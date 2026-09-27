/**
 * @internal The 3D working view, read from the one geometry's parts and
 * written back to them.
 *
 * A 3D value is the one geometry (`Material`): typed columns per domain, a
 * `z` point column, stated polygon faces with their corners, and minted
 * numeric ids. The 3D kernels (visibility, subdivide, extrude, booleans,
 * dual, sweep, revolve, isolines, hatch, intersections, sampling) keep their
 * own working format, `Surface3`: row objects and fixed triangles. The
 * core's parts are the one format between the two, both ways:
 *
 *   partsOfSurface(surface, from?)  a kernel's result → `MaterialParts`,
 *                                   for the core's `materialFromParts`;
 *   surfaceOfParts(parts)           `partsOfMaterial`'s parts → the working
 *                                   view a kernel reads.
 *
 * The faces' FIXED triangulation is face data: a polygon is authoring
 * topology, its triangles are what is drawn and occluded, and a move keeps
 * them as they were (a quad bent by a displacement keeps the diagonal it was
 * born with). The parts hold each face's triangles as positions round its
 * loop; a face with none is triangulated from its positions (`triangulate`,
 * the ear clipping a new surface gets).
 *
 * Identity, two words, both internal:
 *
 * - ids: every row's minted number (`mintIds`, the run's counter). It is
 *   the row's identity in the one geometry: a selection from an earlier
 *   state is resolved by it, and a row a kernel kept keeps it.
 * - keys: every row's kernel NAME — the string the kernels made it under
 *   (`p0`, a face's `f3`, a subdivision child's hash of its parents'). The
 *   view spells a row's `id` with its name, so a kernel reads exactly the
 *   rows it always read: its canonical orders, its stroke keys and the
 *   stroke seeds they feed come from what a row is made of, and not from
 *   when in the run it was minted. A line added above an object does not
 *   re-roll its strokes. A name is never a public word. A row with no name
 *   (one the core added) is named for its id.
 *
 * `partsOfSurface` joins the two: a row whose name the kernel's first input
 * holds in the same domain is that row, and keeps its id; any other row is
 * new, and gets a fresh id.
 *
 * Columns: the view's attribute records hold numbers, booleans, strings and
 * numeric vectors — the kinds a kernel reads. A column holds one kind on
 * every row. A row with no value in a column (a face a boolean took from the
 * other solid, an edge a subdivision made) reads the kind's default: the one
 * geometry has no holes in a column. Reference and placement columns never
 * enter the view (a kernel sees numbers only); `partsOfSurface` carries them
 * from the first input: a row that kept its id keeps its value, a row made
 * from others takes its first parent's (a reference or a placement never
 * interpolates), any other row the default.
 *
 * Lineage: a row a derivation made carries `{ operation, parents, inputs? }`
 * — the names of the rows it came from, and which input holds each when the
 * derivation read more than one value (the kernels' `provenance`). It rides
 * beside the parts, into the view a derivation's value keeps.
 */

import {Column, kinds, kindOf, kindWords, type AnyColumn, type AnyKind, type VectorColumn} from '../../column.js';
import {mintIds, type FacePart, type MaterialParts, type MaterialPartsOut} from '../../material.js';
import type {CellValue} from '../../tables.js';
import {kindOfValue} from '../../tables.js';
import {captureSurface3, ownSurface3} from './model.js';
import {triangulate, type Attribute3, type Attributes3, type Provenance3, type Surface3, type SurfaceCorner3, type SurfaceEdge3, type SurfaceFace3, type SurfacePoint3, type SurfaceTriangle3} from './surface.js';
import type {Vec3} from '../math.js';
import {Mesh3} from './mesh3.js';
import {viewOwner} from './value.js';

/** The domains of the one geometry a 3D value fills. */
export type Domain3 = 'points' | 'edges' | 'faces' | 'corners';
const DOMAINS3: readonly Domain3[] = Object.freeze(['points', 'edges', 'faces', 'corners']);

export type Columns3 = Readonly<Record<string, AnyColumn>>;
/** What each row of one domain came from; absent where nothing did. */
export type Lineage3 = Readonly<Partial<Record<Domain3, readonly (Provenance3 | undefined)[]>>>;

/** @internal The parts a view is read from: `partsOfMaterial`'s. */
export type ViewParts = MaterialPartsOut;

/** @internal A kernel's surface as the core's parts, with what a view of
 * them needs besides: the rows' lineage, and whether the surface is its own
 * view (every column on every row and a corner record at every vertex). */
export type SurfaceMade = MaterialParts & {readonly lineage: Lineage3; readonly complete: boolean};

// ─── columns ──────────────────────────────────────────────────────────

/** The column kind a view value is: a number, a boolean, a string, or a
 * vector of its length. */
function kernelKind(value: Attribute3): AnyKind {
  const kind = kindOfValue(value);
  if (kind === null || kind === undefined || kind === kinds.reference) throw new Error(`a geometry column holds numbers, booleans, strings or numeric vectors — got ${typeof value}`);
  return kind;
}

/** The typed columns of a domain's attribute records: one column per name any
 * row has, of the kind its values are; a row with none reads the default. */
function columnsOf(records: readonly Readonly<Attributes3>[], holes: {sparse: boolean}): Record<string, AnyColumn> {
  const found = new Map<string, AnyKind>();
  const count = new Map<string, number>();
  for (const record of records) {
    for (const name in record) {
      const value = record[name];
      if (value === undefined) continue;
      const kind = kernelKind(value);
      const known = found.get(name);
      if (known === undefined) found.set(name, kind);
      else if (known !== kind) throw new Error(`the column '${name}' holds ${kindWords(known)} on one row and ${kindWords(kind)} on another: a column holds one kind`);
      count.set(name, (count.get(name) ?? 0) + 1);
    }
  }
  for (const c of count.values()) if (c !== records.length) holes.sparse = true;
  const out: Record<string, AnyColumn> = {};
  const n = records.length;
  for (const [name, kind] of found) {
    if (kind === kinds.number) {
      const flat = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const v = records[i][name];
        flat[i] = v === undefined ? 0 : v as number;
      }
      out[name] = Column.of(flat);
    } else if (kind === kinds.boolean) {
      const flat = new Uint8Array(n);
      for (let i = 0; i < n; i++) flat[i] = records[i][name] === true ? 1 : 0;
      out[name] = kinds.boolean.of(flat);
    } else if (kind === kinds.string) {
      const flat: string[] = [];
      for (let i = 0; i < n; i++) {
        const v = records[i][name];
        flat.push(v === undefined ? '' : v as string);
      }
      out[name] = kinds.string.of(flat);
    } else {
      const k = kind.width;
      const flat = new Float64Array(n * k);
      for (let i = 0; i < n; i++) {
        const v = records[i][name] as readonly number[] | undefined;
        if (v !== undefined) for (let s = 0; s < k; s++) flat[i * k + s] = v[s];
      }
      out[name] = (kind as ReturnType<typeof kinds.vector>).of(flat);
    }
  }
  return out;
}

/** The columns a kernel reads: numbers, booleans, strings, vectors. */
const inView = (column: AnyColumn): boolean => {
  const name = kindOf(column).name;
  return name !== 'reference' && name !== 'placement';
};

/** Row `i` of every view column, as the view's attribute record. */
function recordsOf(cols: Columns3, n: number): Attributes3[] {
  const out: Attributes3[] = [];
  for (let i = 0; i < n; i++) out.push({});
  for (const name in cols) {
    const column = cols[name];
    if (!inView(column)) continue;
    const kind = kindOf(column);
    if (kind === kinds.number) {
      const flat = (column as Column<Float64Array>).flat();
      for (let i = 0; i < n; i++) out[i][name] = flat[i];
    } else if (kind.name === 'vector') {
      const vectors = column as VectorColumn;
      for (let i = 0; i < n; i++) out[i][name] = Object.freeze(vectors.get(i));
    } else {
      for (let i = 0; i < n; i++) out[i][name] = (column as {get(i: number): Attribute3}).get(i);
    }
  }
  return out;
}

/** A cell of a column, as a face part takes it. */
const cellAt = (column: AnyColumn, i: number): CellValue => (column as {get(i: number): unknown}).get(i) as CellValue;

// ─── names and ids ────────────────────────────────────────────────────

/** Kernel names, or a row's own name made from its id where it has none. */
const named = (keys: readonly string[] | null | undefined, ids: ArrayLike<number>, prefix: string): readonly string[] =>
  Array.from(ids, (id, i) => { const k = keys?.[i]; return k === undefined || k === '' ? `${prefix}${id}` : k; });

/** Every row of the parts, by domain: its kernel name and its id, the
 * columns it holds, and each face's loop (point rows). */
interface Rows3 {
  readonly names: Readonly<Record<Domain3, readonly string[]>>;
  readonly ids: Readonly<Record<Domain3, ArrayLike<number>>>;
  readonly cols: Readonly<Record<Domain3, Columns3>>;
  readonly loops: readonly (readonly number[])[];
}
function rowsOf(parts: ViewParts): Rows3 {
  const stated = parts.faces;
  const loops = stated?.loops ?? [];
  const cornerCount = stated?.corners.point.length ?? 0;
  const faceIds = stated?.ids.faces ?? new Float64Array(loops.length);
  const cornerIds = stated?.ids.corners ?? new Float64Array(cornerCount);
  return {
    names: {
      points: named(parts.keys.points, parts.ids.points, '2d:'),
      edges: named(parts.keys.edges, parts.ids.edges, '2d:e'),
      faces: named(stated?.keys.faces, stated?.ids.faces ?? Float64Array.from(loops, (_, f) => f), 'face:'),
      corners: named(stated?.keys.corners, stated?.ids.corners ?? Float64Array.from({length: cornerCount}, (_, c) => c), 'corner:'),
    },
    ids: {points: parts.ids.points, edges: parts.ids.edges, faces: faceIds, corners: cornerIds},
    cols: {points: parts.pointCols, edges: parts.edgeCols, faces: stated?.cols ?? {}, corners: stated?.corners.cols ?? {}},
    loops,
  };
}

/** name → row of one domain. */
function rowOfName(names: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < names.length; i++) map.set(names[i], i);
  return map;
}

/** An edge's ends, by the names of its points: the same two points are the
 * same edge, whatever name a kernel gave the edge. */
const endsKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** The ids of a domain's rows: a name `from` holds is that row's id (an
 * edge also by its two points), any other a fresh one. */
function domainIds(names: readonly string[], known: Map<string, number> | undefined, fromIds: ArrayLike<number> | undefined, byEnds?: {map: Map<string, number>; key: (i: number) => string}): Float64Array {
  const out = new Float64Array(names.length);
  let fresh = 0;
  for (let i = 0; i < names.length; i++) {
    const row = known?.get(names[i]) ?? byEnds?.map.get(byEnds.key(i));
    if (row === undefined) {
      out[i] = NaN;
      fresh++;
    } else out[i] = fromIds![row];
  }
  if (fresh > 0) {
    const minted = mintIds(fresh);
    let k = 0;
    for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) out[i] = minted[k++];
  }
  return out;
}

// ─── carrying the columns a kernel never sees ─────────────────────────

/** `from`'s reference and placement columns of one domain, onto the rows a
 * kernel answered: a kept row keeps its value, a row made from others its
 * first parent's in `from`, any other the default. */
function carried(fromCols: Columns3 | undefined, rowOf: Map<string, number> | undefined, names: readonly string[], lineage: readonly (Provenance3 | undefined)[] | undefined): Record<string, AnyColumn> {
  const out: Record<string, AnyColumn> = {};
  if (fromCols === undefined || rowOf === undefined) return out;
  for (const name in fromCols) {
    const column = fromCols[name];
    if (inView(column)) continue;
    const kind = kindOf(column) as typeof kinds.reference | typeof kinds.placement;
    const values: unknown[] = [];
    for (let i = 0; i < names.length; i++) {
      let at = rowOf.get(names[i]);
      const l = lineage?.[i];
      if (at === undefined && l !== undefined) {
        for (let k = 0; k < l.parents.length && at === undefined; k++) {
          if (l.inputs !== undefined && l.inputs[k] !== 0) continue;
          at = rowOf.get(l.parents[k]);
        }
      }
      values.push(at === undefined ? kind.default : (column as {get(i: number): unknown}).get(at));
    }
    out[name] = (kind as {from(values: ArrayLike<unknown>): AnyColumn}).from(values);
  }
  return out;
}

// ─── the two doors ────────────────────────────────────────────────────

/** A face's corner records, one per vertex: its own, or ones a kernel never
 * named, named as `assembleSurface3` names them. */
function cornersOf(surface: Surface3, f: SurfaceFace3): readonly SurfaceCorner3[] {
  return f.corners ?? f.vertices.map((v) => ({id: JSON.stringify(['corner', f.id, surface.points[v].id]), attributes: {}}));
}

/** @internal A surface as the core's parts. `from` is the parts of the value
 * the kernel that made `surface` read first, when it read one: a row it kept
 * keeps its id, and its reference and placement columns ride across. */
export function partsOfSurface(surface: Surface3, from?: ViewParts): SurfaceMade {
  const n = surface.points.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = surface.points[i].position;
    x[i] = p[0];
    y[i] = p[1];
    z[i] = p[2];
  }
  const edges = new Uint32Array(surface.edges.length * 2);
  surface.edges.forEach((e, i) => {
    edges[2 * i] = e.vertices[0];
    edges[2 * i + 1] = e.vertices[1];
  });
  const corners: SurfaceCorner3[] = [];
  for (const f of surface.faces) for (const c of cornersOf(surface, f)) corners.push(c);
  const rows: Record<Domain3, readonly {readonly id: string; readonly provenance?: Provenance3; readonly attributes: Readonly<Attributes3>}[]> = {points: surface.points, edges: surface.edges, faces: surface.faces, corners};
  const fromRows = from === undefined ? undefined : rowsOf(from);
  const names = {} as Record<Domain3, readonly string[]>;
  const ids = {} as Record<Domain3, Float64Array>;
  const lineage: Partial<Record<Domain3, readonly (Provenance3 | undefined)[]>> = {};
  const cols = {} as Record<Domain3, Columns3>;
  const holes = {sparse: false};
  for (const d of DOMAINS3) {
    const r = rows[d];
    names[d] = Object.freeze(r.map((row) => row.id));
    const known = fromRows === undefined ? undefined : rowOfName(fromRows.names[d]);
    let byEnds: {map: Map<string, number>; key: (i: number) => string} | undefined;
    if (d === 'edges' && fromRows !== undefined) {
      const p = fromRows.names.points, list = from!.edges, map = new Map<string, number>();
      for (let e = 0; e < list.length / 2; e++) map.set(endsKey(p[list[2 * e]], p[list[2 * e + 1]]), e);
      byEnds = {map, key: (e) => endsKey(names.points[edges[2 * e]], names.points[edges[2 * e + 1]])};
    }
    ids[d] = domainIds(names[d], known, fromRows?.ids[d], byEnds);
    if (r.some((row) => row.provenance !== undefined)) lineage[d] = Object.freeze(r.map((row) => row.provenance));
    cols[d] = Object.freeze({...columnsOf(r.map((row) => row.attributes), holes), ...carried(fromRows?.cols[d], known, names[d], lineage[d])});
  }
  // Each face: its loop, its fixed triangles as positions round the loop,
  // and its columns, every face every column.
  const local: number[][] = surface.faces.map(() => []);
  for (const t of surface.triangles) {
    const loop = surface.faces[t.face].vertices;
    for (let k = 0; k < 3; k++) local[t.face].push(loop.indexOf(t.vertices[k]));
  }
  const faceNames = Object.keys(cols.faces);
  const faces: FacePart[] = surface.faces.map((f, i) => {
    let own: Record<string, CellValue> | undefined;
    if (faceNames.length > 0) {
      own = {};
      for (const name of faceNames) own[name] = cellAt(cols.faces[name], i);
    }
    return {loop: f.vertices, triangles: local[i], ...(own ? {cols: own} : {})};
  });
  return {
    x, y, z,
    pointCols: cols.points,
    edges,
    edgeCols: cols.edges,
    faces,
    ...(surface.faces.length > 0 ? {cornerColumns: cols.corners} : {}),
    ids: {points: ids.points, edges: ids.edges, faces: ids.faces, corners: ids.corners},
    keys: names,
    lineage: Object.freeze(lineage),
    complete: !holes.sparse && !surface.faces.some((f) => f.corners === undefined),
  };
}

const edgeKey = (a: number, b: number): number => a < b ? a * 0x100000000 + b : b * 0x100000000 + a;
const withProvenance = <T extends object>(row: T, provenance: Provenance3 | undefined): T =>
  provenance === undefined ? row : {...row, provenance};

/** @internal The working view of a value's parts: a captured `Surface3`
 * whose rows are spelled with their names, whose attribute records are the
 * view columns, and whose triangles are each face's fixed ones, or the ear
 * clipping of the face when it has none. `lineage`, when given, is what the
 * rows came from. A value with no `z` is at z = 0. */
export function surfaceOfParts(parts: ViewParts, lineage: Lineage3 = {}): Surface3 {
  const rows = rowsOf(parts);
  const n = parts.x.length;
  const zs = parts.z;
  const pointRecords = recordsOf(rows.cols.points, n);
  const points: SurfacePoint3[] = [];
  for (let i = 0; i < n; i++) {
    points.push(withProvenance({id: rows.names.points[i], position: [parts.x[i], parts.y[i], zs === undefined ? 0 : zs[i]] as Vec3, attributes: pointRecords[i]}, lineage.points?.[i]));
  }
  const edgeCount = parts.edges.length / 2;
  const loops = rows.loops;
  const cornerRecords = recordsOf(rows.cols.corners, rows.names.corners.length);
  const faceRecords = recordsOf(rows.cols.faces, loops.length);
  const faces: SurfaceFace3[] = [];
  const triangles: SurfaceTriangle3[] = [];
  const incident: number[][] = [];
  for (let e = 0; e < edgeCount; e++) incident.push([]);
  const edgeAt = new Map<number, number>();
  for (let e = 0; e < edgeCount; e++) edgeAt.set(edgeKey(parts.edges[2 * e], parts.edges[2 * e + 1]), e);
  const held = parts.faces?.triangles;
  let positions: Vec3[] | undefined;
  let c = 0;
  for (let f = 0; f < loops.length; f++) {
    const vertices = loops[f];
    const corners: SurfaceCorner3[] = [];
    for (let k = 0; k < vertices.length; k++, c++) corners.push(withProvenance({id: rows.names.corners[c], attributes: cornerRecords[c]}, lineage.corners?.[c]));
    for (let k = 0; k < vertices.length; k++) {
      const e = edgeAt.get(edgeKey(vertices[k], vertices[(k + 1) % vertices.length]));
      if (e === undefined) throw new Error(`surface parts: face ${f} walks a side no edge joins (${vertices[k]}–${vertices[(k + 1) % vertices.length]})`);
      incident[e].push(f);
    }
    faces.push(withProvenance({id: rows.names.faces[f], vertices: Object.freeze([...vertices]), corners: Object.freeze(corners), attributes: faceRecords[f]}, lineage.faces?.[f]));
    const own = held?.[f];
    if (own !== undefined) {
      for (let k = 0; k + 2 < own.length; k += 3) triangles.push(Object.freeze({vertices: Object.freeze([vertices[own[k]], vertices[own[k + 1]], vertices[own[k + 2]]] as [number, number, number]), face: f}));
    } else {
      for (const t of triangulate(positions ??= points.map((p) => p.position), vertices)) triangles.push(Object.freeze({vertices: Object.freeze(t), face: f}));
    }
  }
  const edgeRecords = recordsOf(rows.cols.edges, edgeCount);
  const edges: SurfaceEdge3[] = [];
  for (let e = 0; e < edgeCount; e++) {
    edges.push(withProvenance({id: rows.names.edges[e], vertices: Object.freeze([parts.edges[2 * e], parts.edges[2 * e + 1]] as [number, number]), faces: Object.freeze(incident[e]), attributes: edgeRecords[e]}, lineage.edges?.[e]));
  }
  return captureSurface3(ownSurface3({points: Object.freeze(points), faces: Object.freeze(faces), edges: Object.freeze(edges), triangles: Object.freeze(triangles)}));
}

/** @internal A reader over a surface (see mesh3.ts), for a kernel that
 * reads the one geometry while its caller still holds a surface. A
 * surface that is a value's working view is that value's statement for
 * attachment. */
export function meshOfSurface3(surface: Surface3): Mesh3 {
  const holes = {sparse: false};
  const corners = surface.faces.flatMap((f) => cornersOf(surface, f));
  const local = surface.faces.map((): number[] => []);
  for (const t of surface.triangles) {
    const loop = surface.faces[t.face].vertices;
    for (let k = 0; k < 3; k++) local[t.face].push(loop.indexOf(t.vertices[k]));
  }
  const edges = new Uint32Array(surface.edges.length * 2);
  surface.edges.forEach((e, i) => {
    edges[2 * i] = e.vertices[0];
    edges[2 * i + 1] = e.vertices[1];
  });
  const owner = viewOwner(surface);
  return new Mesh3({
    x: Float64Array.from(surface.points, (p) => p.position[0]),
    y: Float64Array.from(surface.points, (p) => p.position[1]),
    z: Float64Array.from(surface.points, (p) => p.position[2]),
    loops: surface.faces.map((f) => f.vertices),
    local,
    edges,
    topology: owner?.stated ?? surface,
    ...(owner !== undefined ? {value: owner} : {}),
    names: () => Object.freeze({points: surface.points.map((p) => p.id), edges: surface.edges.map((e) => e.id), faces: surface.faces.map((f) => f.id), corners: corners.map((c) => c.id)}),
    cols: () => Object.freeze({
      points: Object.freeze(columnsOf(surface.points.map((p) => p.attributes), holes)),
      edges: Object.freeze(columnsOf(surface.edges.map((e) => e.attributes), holes)),
      faces: Object.freeze(columnsOf(surface.faces.map((f) => f.attributes), holes)),
      corners: Object.freeze(columnsOf(corners.map((c) => c.attributes), holes)),
    }),
  });
}

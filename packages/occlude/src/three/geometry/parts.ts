/**
 * @internal The one geometry's parts, and the 3D working view built from them.
 *
 * A 3D value is the one geometry (`Material`): typed columns per domain, a
 * `z` point column, stated polygon faces with their corners, and minted
 * numeric ids. The 3D kernels (visibility, subdivide, extrude, booleans,
 * dual, sweep, revolve, isolines, hatch, intersections, sampling) keep their
 * own working format, `Surface3`: row objects and fixed triangles. This
 * module is the one door between the two, both ways:
 *
 *   partsOfSurface(surface, from?)  a kernel's result → parts, for the
 *                                   core's constructor door;
 *   surfaceOfParts(parts)           parts → the working view a kernel reads.
 *
 * The parts, domain by domain:
 *
 * | domain  | rows                              | columns      |
 * |---------|-----------------------------------|--------------|
 * | points  | `x`, `y`, `z`                     | `pointCols`  |
 * | edges   | `edges`, two point rows an edge   | `edgeCols`   |
 * | faces   | `loops` from `loopStarts[f]` to   | `faceCols`   |
 * |         | `loopStarts[f + 1]`, point rows   |              |
 * | corners | one per loop entry, in face order | `cornerCols` |
 * |         | then winding order                |              |
 *
 * `triangles` (three point rows each) and `triangleFaces` are the faces'
 * FIXED triangulation: a polygon is authoring topology, its triangles are
 * what is drawn and occluded, and a move keeps them as they were (a quad
 * bent by a displacement keeps the diagonal it was born with). Absent, each
 * face is triangulated from its positions (`triangulate`, the ear clipping
 * a new surface gets).
 *
 * Identity, two words, both internal:
 *
 * - `ids`: every row's minted number (`mintIds`, the run's counter). It is
 *   the row's identity in the one geometry: a selection from an earlier
 *   state is resolved by it, and a row a kernel kept keeps it.
 * - `names`: every row's kernel NAME — the string the kernels made it under
 *   (`p0`, a face's `f3`, a subdivision child's hash of its parents'). The
 *   view spells a row's `id` with its name, so a kernel reads exactly the
 *   rows it always read: its canonical orders, its stroke keys and the
 *   stroke seeds they feed come from what a row is made of, and not from
 *   when in the run it was minted. A line added above an object does not
 *   re-roll its strokes. A name is never a public word.
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
 * derivation read more than one value (the kernels' `provenance`).
 */

import {Column, kinds, kindOf, type AnyColumn, type AnyKind, type VectorColumn} from '../../column.js';
import {mintIds} from '../../material.js';
import {captureSurface3, ownSurface3} from './model.js';
import {inheritTopology3} from './topology.js';
import {triangulate, type Attribute3, type Attributes3, type Provenance3, type Surface3, type SurfaceCorner3, type SurfaceEdge3, type SurfaceFace3, type SurfacePoint3, type SurfaceTriangle3} from './surface.js';
import type {Vec3} from '../math.js';

/** The domains of the one geometry a 3D value fills. */
export type Domain3 = 'points' | 'edges' | 'faces' | 'corners';
export const DOMAINS3: readonly Domain3[] = Object.freeze(['points', 'edges', 'faces', 'corners']);

/** What one row came from: the names of its parent rows, and, when the
 * derivation read several values, the input that holds each parent. */
export type Lineage3 = Provenance3;

export type Columns3 = Readonly<Record<string, AnyColumn>>;

/** @internal The one geometry's parts, as the 3D layer builds and reads them. */
export interface SurfaceParts {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly pointCols: Columns3;
  /** Two point rows an edge, the lower first. */
  readonly edges: Uint32Array;
  readonly edgeCols: Columns3;
  /** Every face's loop of point rows, one after another. */
  readonly loops: Uint32Array;
  /** Face `f`'s loop is `loops[loopStarts[f]]` up to `loops[loopStarts[f + 1]]`;
   * one longer than the faces. A corner's row is its place in `loops`. */
  readonly loopStarts: Uint32Array;
  readonly faceCols: Columns3;
  readonly cornerCols: Columns3;
  /** The fixed triangulation: three point rows a triangle, and the face
   * each triangle belongs to. Absent: triangulated from the positions. */
  readonly triangles?: Uint32Array;
  readonly triangleFaces?: Uint32Array;
  /** The minted id of every row, per domain. */
  readonly ids: Readonly<Record<Domain3, Float64Array>>;
  /** The kernel name of every row, per domain (see the module note). */
  readonly names: Readonly<Record<Domain3, readonly string[]>>;
  /** What each row came from, per domain; absent where nothing did. */
  readonly lineage: Readonly<Partial<Record<Domain3, readonly (Lineage3 | undefined)[]>>>;
  /** @internal The surface these parts were read from has every column on
   * every row and a corner record at every vertex: it is its own view. */
  readonly complete?: true;
}

// ─── columns ──────────────────────────────────────────────────────────

/** The column kind a view value is: a number, a boolean, a string, or a
 * vector of its length. */
function kindOfValue(value: Attribute3): AnyKind {
  if (typeof value === 'number') return kinds.number;
  if (typeof value === 'boolean') return kinds.boolean;
  if (typeof value === 'string') return kinds.string;
  if (Array.isArray(value)) return kinds.vector(value.length);
  throw new Error(`a geometry column holds numbers, booleans, strings or numeric vectors — got ${typeof value}`);
}
const kindWords = (kind: AnyKind): string => kind.name === 'vector' ? `a vector of ${kind.width}` : `a ${kind.name}`;

/** Does every record hold a value for every column any of them holds? */
/** The typed columns of a domain's attribute records: one column per name any
 * row has, of the kind its values are; a row with none reads the default. */
function columnsOf(records: readonly Readonly<Attributes3>[], holes?: {sparse: boolean}): Record<string, AnyColumn> {
  const found = new Map<string, AnyKind>();
  const count = new Map<string, number>();
  for (const record of records) {
    for (const name in record) {
      const value = record[name];
      if (value === undefined) continue;
      const kind = kindOfValue(value);
      const known = found.get(name);
      if (known === undefined) found.set(name, kind);
      else if (known !== kind) throw new Error(`the column '${name}' holds ${kindWords(known)} on one row and ${kindWords(kind)} on another: a column holds one kind`);
      count.set(name, (count.get(name) ?? 0) + 1);
    }
  }
  if (holes !== undefined) for (const c of count.values()) if (c !== records.length) holes.sparse = true;
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

// ─── ids ──────────────────────────────────────────────────────────────

/** name → row of one domain of `parts`, built once per parts. */
const nameMaps = new WeakMap<SurfaceParts, Partial<Record<Domain3, Map<string, number>>>>();
function rowOfName(parts: SurfaceParts, domain: Domain3): Map<string, number> {
  let maps = nameMaps.get(parts);
  if (maps === undefined) nameMaps.set(parts, maps = {});
  let map = maps[domain];
  if (map === undefined) {
    map = new Map();
    const names = parts.names[domain];
    for (let i = 0; i < names.length; i++) map.set(names[i], i);
    maps[domain] = map;
  }
  return map;
}

/** An edge's ends, by the names of its points: the same two points are the
 * same edge, whatever name a kernel gave the edge. */
const endsKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
const edgeEnds = new WeakMap<SurfaceParts, Map<string, number>>();
function rowOfEnds(parts: SurfaceParts): Map<string, number> {
  let map = edgeEnds.get(parts);
  if (map === undefined) {
    map = new Map();
    const p = parts.names.points;
    for (let e = 0; e < parts.edges.length / 2; e++) map.set(endsKey(p[parts.edges[2 * e]], p[parts.edges[2 * e + 1]]), e);
    edgeEnds.set(parts, map);
  }
  return map;
}

/** The ids of a domain's rows: a name `from` holds is that row's id (an
 * edge also by its two points), any other a fresh one. */
function domainIds(names: readonly string[], from: SurfaceParts | undefined, domain: Domain3, ends?: (i: number) => string): Float64Array {
  const out = new Float64Array(names.length);
  const known = from === undefined ? undefined : rowOfName(from, domain);
  const byEnds = from === undefined || ends === undefined ? undefined : rowOfEnds(from);
  const fromIds = from?.ids[domain];
  let fresh = 0;
  for (let i = 0; i < names.length; i++) {
    const row = known?.get(names[i]) ?? byEnds?.get(ends!(i));
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
function carried(from: SurfaceParts | undefined, domain: Domain3, fromCols: Columns3 | undefined, names: readonly string[], lineage: readonly (Lineage3 | undefined)[] | undefined): Record<string, AnyColumn> {
  const out: Record<string, AnyColumn> = {};
  if (from === undefined || fromCols === undefined) return out;
  for (const name in fromCols) {
    const column = fromCols[name];
    if (inView(column)) continue;
    const rowOf = rowOfName(from, domain);
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

/** @internal A surface as parts. `from` is the parts of the value the
 * kernel that made `surface` read first, when it read one: a row it kept
 * keeps its id, and its reference and placement columns ride across. */
export function partsOfSurface(surface: Surface3, from?: SurfaceParts): SurfaceParts {
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
  const loopStarts = new Uint32Array(surface.faces.length + 1);
  surface.faces.forEach((f, i) => { loopStarts[i + 1] = loopStarts[i] + f.vertices.length; });
  const loops = new Uint32Array(loopStarts[surface.faces.length]);
  const corners: SurfaceCorner3[] = [];
  surface.faces.forEach((f, i) => {
    loops.set(f.vertices, loopStarts[i]);
    for (const c of cornersOf(surface, f)) corners.push(c);
  });
  const triangles = new Uint32Array(surface.triangles.length * 3);
  const triangleFaces = new Uint32Array(surface.triangles.length);
  surface.triangles.forEach((t, i) => {
    triangles[3 * i] = t.vertices[0];
    triangles[3 * i + 1] = t.vertices[1];
    triangles[3 * i + 2] = t.vertices[2];
    triangleFaces[i] = t.face;
  });
  const rows: Record<Domain3, readonly {readonly id: string; readonly provenance?: Provenance3; readonly attributes: Readonly<Attributes3>}[]> = {points: surface.points, edges: surface.edges, faces: surface.faces, corners};
  const fromCols: Record<Domain3, Columns3 | undefined> = {points: from?.pointCols, edges: from?.edgeCols, faces: from?.faceCols, corners: from?.cornerCols};
  const names = {} as Record<Domain3, readonly string[]>;
  const ids = {} as Record<Domain3, Float64Array>;
  const lineage: Partial<Record<Domain3, readonly (Lineage3 | undefined)[]>> = {};
  const cols = {} as Record<Domain3, Columns3>;
  const holes = {sparse: false};
  for (const d of DOMAINS3) {
    const r = rows[d];
    names[d] = Object.freeze(r.map((row) => row.id));
    ids[d] = domainIds(names[d], from, d, d === 'edges' ? (e) => endsKey(names.points[edges[2 * e]], names.points[edges[2 * e + 1]]) : undefined);
    if (r.some((row) => row.provenance !== undefined)) lineage[d] = Object.freeze(r.map((row) => row.provenance));
    cols[d] = Object.freeze({...columnsOf(r.map((row) => row.attributes), holes), ...carried(from, d, fromCols[d], names[d], lineage[d])});
  }
  return Object.freeze({
    x, y, z,
    pointCols: cols.points,
    edges,
    edgeCols: cols.edges,
    loops, loopStarts,
    faceCols: cols.faces,
    cornerCols: cols.corners,
    triangles, triangleFaces,
    ids: Object.freeze(ids),
    names: Object.freeze(names),
    lineage: Object.freeze(lineage),
    ...(holes.sparse || surface.faces.some((f) => f.corners === undefined) ? {} : {complete: true}),
  });
}

const edgeKey = (a: number, b: number): number => a < b ? a * 0x100000000 + b : b * 0x100000000 + a;
const withProvenance = <T extends object>(row: T, provenance: Provenance3 | undefined): T =>
  provenance === undefined ? row : {...row, provenance};

/** @internal The working view of `parts`: a captured `Surface3` whose rows
 * are spelled with their names, whose attribute records are the view
 * columns, and whose triangles are the fixed ones, or the ear clipping of
 * each face when the parts carry none. */
export function surfaceOfParts(parts: SurfaceParts): Surface3 {
  const n = parts.x.length;
  const faceCount = parts.loopStarts.length - 1;
  const edgeCount = parts.edges.length / 2;
  const pointRecords = recordsOf(parts.pointCols, n);
  const points: SurfacePoint3[] = [];
  for (let i = 0; i < n; i++) {
    points.push(withProvenance({id: parts.names.points[i], position: [parts.x[i], parts.y[i], parts.z[i]] as Vec3, attributes: pointRecords[i]}, parts.lineage.points?.[i]));
  }
  const cornerRecords = recordsOf(parts.cornerCols, parts.loops.length);
  const faceRecords = recordsOf(parts.faceCols, faceCount);
  const faces: SurfaceFace3[] = [];
  const incident: number[][] = [];
  for (let e = 0; e < edgeCount; e++) incident.push([]);
  const edgeAt = new Map<number, number>();
  for (let e = 0; e < edgeCount; e++) edgeAt.set(edgeKey(parts.edges[2 * e], parts.edges[2 * e + 1]), e);
  for (let f = 0; f < faceCount; f++) {
    const start = parts.loopStarts[f];
    const end = parts.loopStarts[f + 1];
    const vertices = Array.from(parts.loops.subarray(start, end));
    const corners: SurfaceCorner3[] = [];
    for (let c = start; c < end; c++) corners.push(withProvenance({id: parts.names.corners[c], attributes: cornerRecords[c]}, parts.lineage.corners?.[c]));
    for (let k = 0; k < vertices.length; k++) {
      const e = edgeAt.get(edgeKey(vertices[k], vertices[(k + 1) % vertices.length]));
      if (e === undefined) throw new Error(`surface parts: face ${f} walks a side no edge joins (${vertices[k]}–${vertices[(k + 1) % vertices.length]})`);
      incident[e].push(f);
    }
    faces.push(withProvenance({id: parts.names.faces[f], vertices: Object.freeze(vertices), corners: Object.freeze(corners), attributes: faceRecords[f]}, parts.lineage.faces?.[f]));
  }
  const edgeRecords = recordsOf(parts.edgeCols, edgeCount);
  const edges: SurfaceEdge3[] = [];
  for (let e = 0; e < edgeCount; e++) {
    edges.push(withProvenance({id: parts.names.edges[e], vertices: Object.freeze([parts.edges[2 * e], parts.edges[2 * e + 1]] as [number, number]), faces: Object.freeze(incident[e]), attributes: edgeRecords[e]}, parts.lineage.edges?.[e]));
  }
  const triangles: SurfaceTriangle3[] = [];
  if (parts.triangles !== undefined && parts.triangleFaces !== undefined) {
    for (let t = 0; t < parts.triangleFaces.length; t++) {
      triangles.push(Object.freeze({vertices: Object.freeze([parts.triangles[3 * t], parts.triangles[3 * t + 1], parts.triangles[3 * t + 2]] as [number, number, number]), face: parts.triangleFaces[t]}));
    }
  } else {
    const positions = points.map((p) => p.position);
    faces.forEach((f, face) => { for (const vertices of triangulate(positions, f.vertices)) triangles.push(Object.freeze({vertices: Object.freeze(vertices), face})); });
  }
  return captureSurface3(ownSurface3({points: Object.freeze(points), faces: Object.freeze(faces), edges: Object.freeze(edges), triangles: Object.freeze(triangles)}));
}

// ─── the view kept beside its parts ───────────────────────────────────

const partsOfViews = new WeakMap<Surface3, SurfaceParts>();

/** @internal The parts a view was built from, or undefined for a surface
 * that is not a view. */
export const partsOfView = (surface: Surface3): SurfaceParts | undefined => partsOfViews.get(surface);

/** @internal The view of `parts`, kept beside them: `partsOfView` answers
 * them back. */
export function viewOfParts(parts: SurfaceParts): Surface3 {
  const view = surfaceOfParts(parts);
  partsOfViews.set(view, parts);
  return view;
}

/** @internal The view of parts read from `surface`: the surface itself when
 * nothing had to be filled in (see `complete`), else one built from the
 * parts that takes the surface's topology revision, so adjacency and
 * attachment lineage carry on. */
export function viewFrom(surface: Surface3, parts: SurfaceParts): Surface3 {
  if (parts.complete !== true || parts.triangles === undefined) {
    const view = viewOfParts(parts);
    inheritTopology3(view, surface);
    return view;
  }
  const view = captureSurface3(surface);
  partsOfViews.set(view, parts);
  return view;
}

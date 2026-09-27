/**
 * @internal The 3D kernels' reader and builder over the one geometry.
 *
 * A 3D value is a `Material` with a `z` column: points, edges, stated
 * polygon faces with their corners and FIXED triangles, typed columns per
 * domain, minted ids and the kernels' row names. A kernel reads it through
 * `mesh3(m)` — a typed reader over the store that copies nothing it does
 * not have to — and answers columns (`Made3`), which `made3` turns into
 * the next value.
 *
 * Reading (`Mesh3`):
 *
 *   x, y, z            the position flats (a value with no `z` reads 0);
 *   loops              each face's loop of point rows (a face that holds
 *                      others has an empty loop);
 *   triangles          the triangle slot: every face's fixed triangles as
 *                      global point rows, three a triangle, in face order,
 *                      with `triangleFace` (a face with none is ear
 *                      clipped from the positions, as a new face is);
 *   edges              the edge list, two point rows an edge;
 *   names              each row's kernel NAME (points, edges, faces,
 *                      corners): what the kernels made it under. Stroke
 *                      order and scatter seeds read them; a row the core
 *                      added is named for its id;
 *   cols               the typed columns of each domain, as held;
 *   pointFaces, faceNeighbors, edgeFaces, cornerStart
 *                      incidence, built on first read and shared by every
 *                      state with the same statement of faces.
 *
 * Writing (`Made3` → `made3`): positions, the point names, the loops and
 * their fixed triangles (positions round each loop), the edges with their
 * names (`faceEdges3` derives them from the loops the way a surface always
 * derived them: first seen, face by face, side by side, low row first),
 * each domain's columns and each made row's lineage. `made3` keeps the id
 * of every row whose name the value the kernel read first holds (an edge
 * also by the names of its two points), carries that value's reference and
 * placement columns (a kernel never reads them), links each row the kernel
 * made to the rows it came from (`source`), and builds the value through
 * the core's `materialFromParts`.
 *
 * Attachment: curves and locations bound to a surface may be rebound to a
 * later state only when it has the same faces, corners and triangles by
 * lineage — the same statement, or one a mirror turned over
 * (`sameAttachment3`). A statement that merely looks the same — an
 * independent build with the same names — is not the same surface.
 */

import {Column, kinds, kindOf, type AnyColumn} from '../../column.js';
import {Material, materialFromParts, mintIds, type FacePart, type MaterialParts} from '../../material.js';
import type {CellValue} from '../../tables.js';
import type {FaceSource, StatedFaces} from '../../faces.js';
import {select, type Selection} from '../../selection.js';
import type {DomainSpec, SourceSpec} from '../../derivation.js';
import {statedFaceIds} from '../../faces.js';
import {cornerIndex} from '../../corners.js';
import {finite3, type Vec3} from '../math.js';
import {triangulate, type Provenance3} from './surface.js';
import type {Rotation} from '../rotation.js';

/** The domains of a value in space. */
export type Domain3 = 'points' | 'edges' | 'faces' | 'corners';
export const DOMAINS3: readonly Domain3[] = Object.freeze(['points', 'edges', 'faces', 'corners']);
/** One domain's columns, by name. */
export type Columns3 = Readonly<Record<string, AnyColumn>>;
/** What each made row of one domain came from; absent where nothing did. */
export type Lineage3 = Readonly<Partial<Record<Domain3, readonly (Provenance3 | undefined)[]>>>;

const EMPTY_COLS: Columns3 = Object.freeze({});
const NO_LOOP: readonly number[] = Object.freeze([]);

// ─── reading ─────────────────────────────────────────────────────────

/** @internal What a `Mesh3` is read from: plain parts (see `Mesh3`). */
export interface MeshParts3 {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly loops: readonly (readonly number[])[];
  /** Per face, its fixed triangles as positions round its loop; a face
   * without (undefined) is ear clipped. Absent: none has any. */
  readonly local?: readonly (readonly number[] | undefined)[];
  readonly edges: Uint32Array;
  readonly names: () => Readonly<Record<Domain3, readonly string[]>>;
  readonly cols: () => Readonly<Record<Domain3, Columns3>>;
  /** What the incidence and the attachment are kept by: the statement of
   * faces (or anything else that fixes the loops and the edges). */
  readonly topology: object;
  /** The value read, when it is one. */
  readonly value?: Material;
}

/** Incidence kept per statement of faces. */
interface Incidence3 {
  pointFaces?: readonly (readonly number[])[];
  faceNeighbors?: readonly (readonly number[])[];
  edgeFaces?: readonly (readonly number[])[];
  cornerStart?: Uint32Array;
}
const INCIDENCE = new WeakMap<object, Incidence3>();
const incidenceOf = (key: object): Incidence3 => {
  let got = INCIDENCE.get(key);
  if (got === undefined) INCIDENCE.set(key, (got = {}));
  return got;
};

/** @internal A value in space as the kernels read it (see the module note). */
export class Mesh3 {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly loops: readonly (readonly number[])[];
  readonly faceCount: number;
  readonly edges: Uint32Array;
  readonly edgeCount: number;
  /** The value read, when it is one. */
  readonly value: Material | undefined;
  /** What incidence and attachment are kept by. */
  readonly topology: object;
  private readonly parts: MeshParts3;
  private namesRead?: Readonly<Record<Domain3, readonly string[]>>;
  private colsRead?: Readonly<Record<Domain3, Columns3>>;
  private slot?: {readonly triangles: Uint32Array; readonly face: Uint32Array; readonly start: Uint32Array};
  private positionsRead?: readonly Vec3[];

  constructor(parts: MeshParts3) {
    this.parts = parts;
    this.n = parts.x.length;
    this.x = parts.x;
    this.y = parts.y;
    this.z = parts.z;
    this.loops = parts.loops;
    this.faceCount = parts.loops.length;
    this.edges = parts.edges;
    this.edgeCount = parts.edges.length / 2;
    this.value = parts.value;
    this.topology = parts.topology;
  }

  /** Point `i`'s position, a fresh triple. */
  position(i: number): Vec3 {
    return [this.x[i], this.y[i], this.z[i]];
  }
  /** Every position, frozen triples, built on first read. */
  get positions(): readonly Vec3[] {
    if (this.positionsRead === undefined) {
      const out: Vec3[] = [];
      for (let i = 0; i < this.n; i++) out.push(Object.freeze([this.x[i], this.y[i], this.z[i]]) as unknown as Vec3);
      this.positionsRead = Object.freeze(out);
    }
    return this.positionsRead;
  }

  /** Every row's kernel name, per domain. */
  get names(): Readonly<Record<Domain3, readonly string[]>> {
    return (this.namesRead ??= this.parts.names());
  }
  /** Every domain's columns, as held. */
  get cols(): Readonly<Record<Domain3, Columns3>> {
    return (this.colsRead ??= this.parts.cols());
  }

  /** Where each face's corners start, one more entry the count. */
  get cornerStart(): Uint32Array {
    const kept = incidenceOf(this.topology);
    if (kept.cornerStart === undefined) {
      const start = new Uint32Array(this.faceCount + 1);
      let c = 0;
      for (let f = 0; f < this.faceCount; f++) {
        start[f] = c;
        c += this.loops[f].length;
      }
      start[this.faceCount] = c;
      kept.cornerStart = start;
    }
    return kept.cornerStart;
  }
  /** How many corners: one per point of every loop. */
  get cornerCount(): number {
    return this.cornerStart[this.faceCount];
  }

  private triangleSlot(): {readonly triangles: Uint32Array; readonly face: Uint32Array; readonly start: Uint32Array} {
    if (this.slot !== undefined) return this.slot;
    const local = this.parts.local;
    const out: number[] = [];
    const face: number[] = [];
    const start = new Uint32Array(this.faceCount + 1);
    for (let f = 0; f < this.faceCount; f++) {
      start[f] = face.length;
      const loop = this.loops[f];
      const own = local?.[f];
      if (own !== undefined) {
        for (let k = 0; k + 2 < own.length; k += 3) {
          out.push(loop[own[k]], loop[own[k + 1]], loop[own[k + 2]]);
          face.push(f);
        }
      } else if (loop.length > 0) {
        for (const t of triangulate(this.positions, loop)) {
          out.push(t[0], t[1], t[2]);
          face.push(f);
        }
      }
    }
    start[this.faceCount] = face.length;
    this.slot = {triangles: Uint32Array.from(out), face: Uint32Array.from(face), start};
    return this.slot;
  }
  /** The triangle slot: three global point rows a triangle, in face order. */
  get triangles(): Uint32Array {
    return this.triangleSlot().triangles;
  }
  /** Each triangle's face. */
  get triangleFace(): Uint32Array {
    return this.triangleSlot().face;
  }
  /** Where each face's triangles start in the slot, one more entry the count. */
  get faceTriangleStart(): Uint32Array {
    return this.triangleSlot().start;
  }
  get triangleCount(): number {
    return this.triangleSlot().face.length;
  }
  /** Triangle `t`'s three point rows. */
  triangle(t: number): readonly [number, number, number] {
    const s = this.triangles;
    return [s[3 * t], s[3 * t + 1], s[3 * t + 2]];
  }
  /** Each face's fixed triangles as positions round its loop (the ear
   * clipping for a face that holds none). */
  localTriangles(f: number): readonly number[] {
    const own = this.parts.local?.[f];
    if (own !== undefined) return own;
    const loop = this.loops[f];
    const s = this.triangleSlot();
    const out: number[] = [];
    for (let t = s.start[f]; t < s.start[f + 1]; t++) for (let k = 0; k < 3; k++) out.push(loop.indexOf(s.triangles[3 * t + k]));
    return out;
  }

  /** The faces round each point, in face order. */
  get pointFaces(): readonly (readonly number[])[] {
    const kept = incidenceOf(this.topology);
    if (kept.pointFaces === undefined) {
      const rows: Set<number>[] = [];
      for (let i = 0; i < this.n; i++) rows.push(new Set());
      this.loops.forEach((loop, f) => { for (const v of loop) rows[v].add(f); });
      kept.pointFaces = Object.freeze(rows.map((row) => Object.freeze([...row].sort((a, b) => a - b))));
    }
    return kept.pointFaces;
  }
  /** The faces on each edge, in face order: one on a rim, two inside. */
  get edgeFaces(): readonly (readonly number[])[] {
    const kept = incidenceOf(this.topology);
    if (kept.edgeFaces === undefined) {
      const at = new Map<number, number>();
      for (let e = 0; e < this.edgeCount; e++) at.set(pairKey(this.edges[2 * e], this.edges[2 * e + 1]), e);
      const rows: number[][] = [];
      for (let e = 0; e < this.edgeCount; e++) rows.push([]);
      this.loops.forEach((loop, f) => {
        for (let k = 0; k < loop.length; k++) {
          const e = at.get(pairKey(loop[k], loop[(k + 1) % loop.length]));
          if (e !== undefined) rows[e].push(f);
        }
      });
      kept.edgeFaces = Object.freeze(rows.map((row) => Object.freeze(row)));
    }
    return kept.edgeFaces;
  }
  /** The faces beside each face through a shared edge, in face order. */
  get faceNeighbors(): readonly (readonly number[])[] {
    const kept = incidenceOf(this.topology);
    if (kept.faceNeighbors === undefined) {
      const rows: Set<number>[] = [];
      for (let f = 0; f < this.faceCount; f++) rows.push(new Set());
      for (const faces of this.edgeFaces) for (const a of faces) for (const b of faces) if (a !== b) rows[a].add(b);
      kept.faceNeighbors = Object.freeze(rows.map((row) => Object.freeze([...row].sort((a, b) => a - b))));
    }
    return kept.faceNeighbors;
  }

  /** Row `row` of a domain's column `name` as a kernel reads it: a number,
   * a boolean, a string or a vector (a fresh array); undefined where the
   * domain has no such column. */
  cell(domain: Domain3, name: string, row: number): CellValue | undefined {
    const column = this.cols[domain][name];
    return column === undefined ? undefined : (column as {get(i: number): CellValue}).get(row);
  }
}

/** Two point rows as one number, the lower first. */
export const pairKey = (a: number, b: number): number => (a < b ? a * 0x100000000 + b : b * 0x100000000 + a);

/** Kernel names, or a row's own name made from its id where it has none. */
const named = (keys: ArrayLike<string> | null | undefined, ids: ArrayLike<number>, prefix: string): readonly string[] =>
  Object.freeze(Array.from(ids, (id, i) => { const k = keys?.[i]; return k === undefined || k === '' ? `${prefix}${id}` : k; }));

/** @internal The reader of `m` (see `Mesh3`), kept on the value. */
export function mesh3(m: Material): Mesh3 {
  return (m.cache.mesh3 ??= readMaterial(m));
}

function readMaterial(m: Material): Mesh3 {
  const s = m.store;
  const zc = s.attrs.z;
  const stated = m.stated;
  const loops = stated === undefined ? [] : stated.cycles.map((runs) => (runs.length === 0 ? NO_LOOP : runs[0]));
  return new Mesh3({
    x: s.x.flat(),
    y: s.y.flat(),
    z: zc instanceof Column ? zc.flat() : new Float64Array(m.n),
    loops,
    ...(stated?.triangles !== undefined ? {local: stated.triangles} : {}),
    edges: s.edgeList.flat(),
    topology: stated ?? s.edgeList,
    value: m,
    names: () => {
      const faceCount = loops.length;
      const cornerCount = stated === undefined ? 0 : cornerIndex(stated.cycles).count;
      return Object.freeze({
        points: named(s.pointKeys === null ? null : s.pointKeys.flat(), s.pointIds.flat(), '2d:'),
        edges: named(s.edgeKeys === null ? null : s.edgeKeys.flat(), s.edgeIds.flat(), '2d:e'),
        faces: named(stated?.faceKeys, stated?.faceIds ?? Float64Array.from({length: faceCount}, (_, f) => f), 'face:'),
        corners: named(stated?.cornerKeys, stated?.cornerIds ?? Float64Array.from({length: cornerCount}, (_, c) => c), 'corner:'),
      });
    },
    cols: () => {
      const points: Record<string, AnyColumn> = {};
      for (const name of s.attrNames) if (name !== 'z') points[name] = s.attrs[name];
      return Object.freeze({
        points: Object.freeze(points),
        edges: s.edgeAttrs,
        faces: stated === undefined ? EMPTY_COLS : faceColumns(m, stated),
        corners: stated?.corners ?? EMPTY_COLS,
      });
    },
  });
}

/** The face columns of `m`, one row per face row: its own value, else the
 * column's fallback, else the kind's default. */
function faceColumns(m: Material, stated: StatedFaces): Columns3 {
  const names = Object.keys(m.faceAttrs);
  if (names.length === 0) return EMPTY_COLS;
  const keys = statedFaceIds(m, stated.cycles);
  const out: Record<string, AnyColumn> = {};
  for (const name of names) {
    const column = m.faceAttrs[name];
    const kind = column.kind ?? kinds.number;
    const fallback = column.fallback !== undefined ? column.fallback : kind.default;
    out[name] = (kind as {from(values: readonly unknown[]): AnyColumn}).from(keys.map((key) => {
      const v = column.values.get(key);
      return v === undefined ? fallback : v;
    }));
  }
  return Object.freeze(out);
}

// ─── attachment ──────────────────────────────────────────────────────

const TOKENS = new WeakMap<object, object>();
const tokenOf = (topology: object): object => {
  let token = TOKENS.get(topology);
  if (token === undefined) TOKENS.set(topology, (token = Object.freeze({})));
  return token;
};
/** @internal `turned` is `stated` turned over (a mirror): the same faces,
 * corners and triangles by lineage, wound the other way. */
export function turnedOver3(stated: object, turned: object): void {
  TOKENS.set(turned, tokenOf(stated));
}
/** @internal Are `a` and `b` the same surface by lineage (see the module
 * note)? A winding may be reversed. */
export function sameAttachment3(a: Mesh3, b: Mesh3): boolean {
  return tokenOf(a.topology) === tokenOf(b.topology);
}

// ─── writing ─────────────────────────────────────────────────────────

/** @internal A kernel's answer, as columns (see the module note). Every
 * face side has an edge: derive the edges with `faceEdges3`. */
export interface Made3 {
  readonly x: ArrayLike<number>;
  readonly y: ArrayLike<number>;
  readonly z: ArrayLike<number>;
  readonly names: {
    readonly points: readonly string[];
    readonly edges: readonly string[];
    readonly faces: readonly string[];
    readonly corners: readonly string[];
  };
  readonly loops: readonly (readonly number[])[];
  /** Per face, its fixed triangles as positions round its loop. */
  readonly triangles: readonly (readonly number[])[];
  /** The edge list, two point rows an edge. */
  readonly edges: ArrayLike<number>;
  readonly cols?: Partial<Record<Domain3, Columns3>>;
  readonly lineage?: Lineage3;
}

/** @internal The edges of a set of loops, as a surface always derived them:
 * first seen, face by face and side by side, each with its lower point row
 * first, named for its two points' names — or, where `previous` has an
 * edge between points of the same names, that edge's name and row (`kept`),
 * and after them `previous`'s loose edges (no face) whose points are still
 * here. `previous` is the value the loops were edited from, when the kernel
 * keeps its rows by name. */
export function faceEdges3(loops: readonly (readonly number[])[], pointNames: readonly string[], previous?: Mesh3): {readonly edges: Uint32Array; readonly names: readonly string[]; readonly kept: Int32Array} {
  const ends: number[] = [];
  const seen = new Map<number, number>();
  for (const loop of loops) {
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k];
      const b = loop[(k + 1) % loop.length];
      const key = pairKey(a, b);
      if (seen.has(key)) continue;
      seen.set(key, ends.length / 2);
      ends.push(Math.min(a, b), Math.max(a, b));
    }
  }
  let prior: Map<string, number> | undefined;
  if (previous !== undefined) {
    const at = new Map<string, number>();
    pointNames.forEach((name, i) => at.set(name, i));
    const names = previous.names.points;
    const faces = previous.edgeFaces;
    for (let e = 0; e < previous.edgeCount; e++) {
      if (faces[e].length > 0) continue;
      const a = at.get(names[previous.edges[2 * e]]);
      const b = at.get(names[previous.edges[2 * e + 1]]);
      if (a === undefined || b === undefined) continue;
      if (a === b) throw new Error('loose edge requires distinct point indices');
      const key = pairKey(a, b);
      if (seen.has(key)) continue;
      seen.set(key, ends.length / 2);
      ends.push(a, b);
    }
    prior = new Map();
    for (let e = 0; e < previous.edgeCount; e++) prior.set(endsKey(names[previous.edges[2 * e]], names[previous.edges[2 * e + 1]]), e);
  }
  const count = ends.length / 2;
  const edgeNames: string[] = [];
  const kept = new Int32Array(count).fill(-1);
  for (let e = 0; e < count; e++) {
    const a = pointNames[ends[2 * e]];
    const b = pointNames[ends[2 * e + 1]];
    const old = prior?.get(endsKey(a, b));
    if (old !== undefined) {
      kept[e] = old;
      edgeNames.push(previous!.names.edges[old]);
    } else edgeNames.push(`e:${a}:${b}`);
  }
  return {edges: Uint32Array.from(ends), names: Object.freeze(edgeNames), kept};
}

/** @internal The corner names of a set of loops, as a surface always named
 * the corners it was not given: the face's name and the point's. */
export function cornerNames3(loops: readonly (readonly number[])[], faceNames: readonly string[], pointNames: readonly string[]): string[] {
  const out: string[] = [];
  loops.forEach((loop, f) => { for (const v of loop) out.push(JSON.stringify(['corner', faceNames[f], pointNames[v]])); });
  return out;
}

/** @internal Check a kernel's answer the way a surface was checked: finite
 * positions, unique point and face names, loops of three or more distinct
 * points, and every edge on at most two faces that run it opposite ways. */
export function checkMade3(made: Made3): void {
  const n = made.x.length;
  for (let i = 0; i < n; i++) finite3([made.x[i], made.y[i], made.z[i]], 'mesh');
  for (const names of [made.names.points, made.names.faces]) if (new Set(names).size !== names.length) throw new Error('surface IDs must be unique within their domain');
  const runs = new Map<number, {count: number; forward: number}>();
  for (const loop of made.loops) {
    if (loop.length < 3 || new Set(loop).size !== loop.length || loop.some((v) => !Number.isInteger(v) || v < 0 || v >= n)) throw new Error('surface face requires at least three distinct valid point indices');
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k];
      const b = loop[(k + 1) % loop.length];
      const key = pairKey(a, b);
      const run = runs.get(key);
      if (run === undefined) runs.set(key, {count: 1, forward: a});
      else {
        if (run.count === 2) throw new Error('non-manifold edge: more than two incident faces');
        if (run.forward === a) throw new Error('adjacent face winding must oppose along the shared edge');
        run.count++;
      }
    }
  }
}

/** @internal A reader over a kernel's answer, for a kernel that reads its
 * own intermediate result (a level of a subdivision): no value is made and
 * no id minted. */
export function meshOfMade3(made: Made3): Mesh3 {
  const cols = made.cols ?? {};
  const all = Object.freeze({points: cols.points ?? EMPTY_COLS, edges: cols.edges ?? EMPTY_COLS, faces: cols.faces ?? EMPTY_COLS, corners: cols.corners ?? EMPTY_COLS});
  const names = Object.freeze({...made.names});
  return new Mesh3({
    x: Float64Array.from(made.x),
    y: Float64Array.from(made.y),
    z: Float64Array.from(made.z),
    loops: made.loops,
    local: made.triangles,
    edges: Uint32Array.from(made.edges),
    names: () => names,
    cols: () => all,
    topology: made,
  });
}

/** The same two points, whatever an edge is named. */
const endsKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** @internal What a kernel's value carries besides its rows. */
export interface MadeCarry3 {
  /** The value the kernel read first: a row whose name it holds keeps its
   * id, and its reference and placement columns ride across. */
  readonly from?: Material;
  readonly origin?: Vec3;
  readonly orientation?: Rotation;
  readonly radialCentre?: Vec3;
  readonly transfers?: MaterialParts['transfers'];
  readonly key?: string;
  readonly prototype?: Material;
  /** Where the rows came from (the core's `source` spec). */
  readonly source?: MaterialParts['source'];
}

/** The ids of a domain's rows: a name `from` holds is that row's id (an
 * edge also by its two points), any other a fresh one, minted in row order. */
function domainIds(names: readonly string[], known: Map<string, number> | undefined, fromIds: ArrayLike<number> | undefined, byEnds?: {readonly map: Map<string, number>; readonly key: (i: number) => string}): Float64Array {
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

/** name → row of one domain. */
function rowOfName(names: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < names.length; i++) map.set(names[i], i);
  return map;
}

/** Does a kernel read this column? Numbers, booleans, strings, vectors. */
export const kernelColumn = (column: AnyColumn): boolean => {
  const name = kindOf(column).name;
  return name !== 'reference' && name !== 'placement';
};

/** `from`'s reference and placement columns of one domain, onto the rows a
 * kernel answered: a kept row keeps its value, a row made from others its
 * first parent's in `from`, any other the default. */
function carried(fromCols: Columns3, rowOf: Map<string, number>, names: readonly string[], lineage: readonly (Provenance3 | undefined)[] | undefined): Record<string, AnyColumn> {
  const out: Record<string, AnyColumn> = {};
  for (const name in fromCols) {
    const column = fromCols[name];
    if (kernelColumn(column)) continue;
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

/** A cell of a column, as a face part takes it. */
const cellAt = (column: AnyColumn, i: number): CellValue => (column as {get(i: number): unknown}).get(i) as CellValue;

/** @internal A kernel's answer as the one geometry (see the module note). */
export function made3(made: Made3, carry: MadeCarry3 = {}): Material {
  const from = carry.from === undefined ? undefined : mesh3(carry.from);
  const cols = made.cols ?? {};
  const ids = {} as Record<Domain3, Float64Array>;
  const withCarried = {} as Record<Domain3, Columns3>;
  const edges = made.edges;
  for (const d of DOMAINS3) {
    const names = made.names[d];
    const known = from === undefined ? undefined : rowOfName(from.names[d]);
    let byEnds: {map: Map<string, number>; key: (i: number) => string} | undefined;
    if (d === 'edges' && from !== undefined) {
      const p = from.names.points;
      const map = new Map<string, number>();
      for (let e = 0; e < from.edgeCount; e++) map.set(endsKey(p[from.edges[2 * e]], p[from.edges[2 * e + 1]]), e);
      byEnds = {map, key: (e) => endsKey(made.names.points[edges[2 * e]], made.names.points[edges[2 * e + 1]])};
    }
    ids[d] = domainIds(names, known, from === undefined ? undefined : idsOf(from, d), byEnds);
    withCarried[d] = from === undefined || known === undefined ? (cols[d] ?? EMPTY_COLS) : Object.freeze({...(cols[d] ?? {}), ...carried(from.cols[d], known, names, made.lineage?.[d])});
  }
  const faceNames = Object.keys(withCarried.faces);
  const faces: FacePart[] = made.loops.map((loop, f) => {
    let own: Record<string, CellValue> | undefined;
    if (faceNames.length > 0) {
      own = {};
      for (const name of faceNames) own[name] = cellAt(withCarried.faces[name], f);
    }
    return {loop, triangles: made.triangles[f], ...(own ? {cols: own} : {})};
  });
  return materialFromParts({
    x: made.x,
    y: made.y,
    z: made.z,
    pointCols: withCarried.points,
    edges,
    edgeCols: withCarried.edges,
    faces,
    ...(made.loops.length > 0 ? {cornerColumns: withCarried.corners} : {}),
    ids: {points: ids.points, edges: ids.edges, faces: ids.faces, corners: ids.corners},
    keys: made.names,
    ...(carry.source !== undefined ? {source: carry.source} : {}),
    ...(carry.transfers !== undefined ? {transfers: {...carry.transfers}} : {}),
    ...(carry.key !== undefined ? {key: carry.key} : {}),
    ...(carry.prototype !== undefined ? {prototype: carry.prototype} : {}),
    ...(carry.origin !== undefined ? {origin: carry.origin} : {}),
    ...(carry.orientation !== undefined ? {orientation: carry.orientation} : {}),
    ...(carry.radialCentre !== undefined ? {radialCentre: carry.radialCentre} : {}),
  });
}

/** The minted ids of one domain of a value read. */
function idsOf(mesh: Mesh3, d: Domain3): ArrayLike<number> {
  const m = mesh.value!;
  if (d === 'points') return m.store.pointIds.flat();
  if (d === 'edges') return m.store.edgeIds.flat();
  // A statement with no minted ids (a plane value's) matches by name only.
  const stated = m.stated;
  if (d === 'faces') return stated?.faceIds ?? new Float64Array(mesh.faceCount);
  return stated?.cornerIds ?? new Float64Array(mesh.cornerCount);
}

declare module '../../material.js' {
  interface StateCache {
    /** The kernels' reader (`mesh3`). */
    mesh3?: Mesh3;
  }
}

// ─── source: the rows a derivation read ─────────────────────────────

/** Where one made row came from: per input it read, rows of one domain. */
interface Found3 {readonly input: number; readonly domain: Domain3; readonly rows: number[]}

/** name → row, per domain, of an input (the first domain that holds it). */
const NAME_INDEX = new WeakMap<Material, Map<string, {readonly domain: Domain3; readonly row: number}>>();
function rowsByName(input: Material): Map<string, {readonly domain: Domain3; readonly row: number}> {
  let index = NAME_INDEX.get(input);
  if (index !== undefined) return index;
  index = new Map();
  const names = mesh3(input).names;
  for (const d of DOMAINS3) names[d].forEach((name, row) => { if (!index!.has(name)) index!.set(name, {domain: d, row}); });
  NAME_INDEX.set(input, index);
  return index;
}
/** Rows of one domain of an input, as a sketch reads them: one row, or a
 * selection of several. */
function rowsIn(input: Material, domain: Domain3, rows: readonly number[]): FaceSource {
  const one = <R>(all: Selection<R>): R | Selection<R> => (rows.length === 1 ? all.at(rows[0])! : select(all.domain, rows));
  return (domain === 'points' ? one(input.points) : domain === 'edges' ? one(input.edges) : domain === 'faces' ? one(input.faces) : one(input.corners)) as FaceSource;
}
/**
 * What a made row came from, in the inputs its derivation read: a row the
 * derivation made names its parents (its lineage for this operation); a
 * row it kept as it was is its own row in the first input that holds it.
 */
function foundOf(operation: string, inputs: readonly Material[], name: string, lineage: Provenance3 | undefined): readonly Found3[] {
  const own = lineage !== undefined && lineage.operation === operation;
  const parents = own ? lineage!.parents : [name];
  const where = own ? lineage!.inputs : undefined;
  const groups: Found3[] = [];
  parents.forEach((parent, k) => {
    const tried = where !== undefined ? [where[k]] : inputs.map((_, i) => i);
    for (const i of tried) {
      const input = inputs[i];
      if (input === undefined) continue;
      const found = rowsByName(input).get(parent);
      if (found === undefined) continue;
      let g = groups.find((x) => x.input === i && x.domain === found.domain);
      if (g === undefined) groups.push((g = {input: i, domain: found.domain, rows: []}));
      if (!g.rows.includes(found.row)) g.rows.push(found.row);
      break;
    }
  });
  return groups;
}
/** One answer: a row, a selection of one domain of one input, or a list with
 * one of those per input. */
function answerOf(inputs: readonly Material[], groups: readonly Found3[]): FaceSource {
  if (groups.length === 0) return undefined;
  const one = (g: Found3): FaceSource => rowsIn(inputs[g.input], g.domain, g.rows);
  return (groups.length === 1 ? one(groups[0]) : Object.freeze(groups.map(one))) as FaceSource;
}
/** The core's spec for one domain: one spec when every row with an answer
 * names one domain of one input, a list when every row names the same inputs
 * in the same order (a sweep point: a profile point and a path point);
 * corners have no link and are left out. */
function specOf(inputs: readonly Material[], rows: readonly (readonly Found3[])[]): DomainSpec | undefined {
  let shape: string | undefined;
  for (const groups of rows) {
    if (groups.length === 0) continue;
    const s = groups.map((g) => `${g.input}:${g.domain}`).join(',');
    if (shape === undefined) shape = s;
    else if (shape !== s) return undefined;
  }
  if (shape === undefined) return undefined;
  const shapes = shape.split(',').map((x) => { const [i, d] = x.split(':'); return {input: Number(i), domain: d as Domain3}; });
  if (shapes.some((x) => x.domain === 'corners')) return undefined;
  // One parent answers a row and several a selection: rows of both kinds in
  // one domain are read row by row.
  const counts = new Set(rows.flatMap((groups) => groups.map((g) => g.rows.length === 1)));
  if (counts.size > 1) return undefined;
  const specs = shapes.map((x, k): SourceSpec => {
    const many = rows.map((groups) => (groups.length === 0 ? undefined : groups[k].rows));
    const of = inputs[x.input];
    const domain = x.domain as 'points' | 'edges' | 'faces';
    return many.every((r) => r === undefined || r.length === 1)
      ? {of, domain, rows: Int32Array.from(many, (r) => (r === undefined ? -1 : r[0]))}
      : {of, domain, many};
  });
  return {source: specs.length === 1 ? specs[0] : specs};
}
/** @internal Where the rows of a derivation's answer came from, as the
 * core's `source` spec: each made row's lineage, each kept row itself. */
export function sourceOfMade3(operation: string, made: Made3, inputs: readonly Material[]): NonNullable<MaterialParts['source']> {
  const found = (d: 'points' | 'edges'): readonly (readonly Found3[])[] => made.names[d].map((name, i) => foundOf(operation, inputs, name, made.lineage?.[d]?.[i]));
  // One shape for the whole domain goes to the core as rows; a shape that
  // varies row by row (a boolean's point from either solid) is read per row.
  const spec = (rows: readonly (readonly Found3[])[]): DomainSpec | undefined =>
    specOf(inputs, rows) ?? (rows.some((g) => g.length > 0) ? {source: {read: (i: number) => answerOf(inputs, rows[i])}} : undefined);
  const points = spec(found('points'));
  const edges = spec(found('edges'));
  // A face answers what its lineage says, read the first time it is asked.
  const faceMemo = new Map<number, FaceSource>();
  const faces = (f: number): FaceSource => {
    if (!faceMemo.has(f)) faceMemo.set(f, answerOf(inputs, foundOf(operation, inputs, made.names.faces[f], made.lineage?.faces?.[f])));
    return faceMemo.get(f);
  };
  return {...(points ? {points} : {}), ...(edges ? {edges} : {}), faces};
}

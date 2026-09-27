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
 *                      state with the same statement of faces;
 *   policies           how each domain's columns cross a later edit (a
 *                      point column interpolates or takes the nearest, an
 *                      edge column copies or distributes, a face column
 *                      takes the nearest face or drops): the value's, as
 *                      declared. A kernel that makes a piece of an edge
 *                      gives a distributed column its share (`edgeColumns3`).
 *
 * Writing (`Made3` → `made3`): positions, the point names, the loops and
 * their fixed triangles (positions round each loop), the edges with their
 * names (`faceEdges3` derives them from the loops the way a surface always
 * derived them: first seen, face by face, side by side, low row first),
 * each domain's columns and each made row's lineage. `made3` keeps the id
 * of every row whose name the value the kernel read first holds (an edge
 * also by the names of its two points); carries the reference and
 * placement columns of every value the kernel read (a kernel never reads
 * them) onto the rows it holds of each and the rows made from them, a
 * reference to a row of a later input read as the row here that is it;
 * gives every column the policy its input declared for it; links each row
 * the kernel made to the rows it came from (`source`); and builds the
 * value through the core's `materialFromParts`.
 *
 * Attachment: curves and locations bound to a surface may be rebound to a
 * later state only when it has the same faces, corners and triangles by
 * lineage — the same statement, or one a mirror turned over
 * (`sameAttachment3`). A statement that merely looks the same — an
 * independent build with the same names — is not the same surface.
 */

import {Column, kinds, kindOf, kindWords, type AnyColumn} from '../../column.js';
import {Material, materialFromParts, mintIds, type EdgeTransfer, type FaceTransfer, type MaterialParts, type PointTransfer} from '../../material.js';
import type {CellValue} from '../../tables.js';
import type {FaceSource, StatedFaces} from '../../faces.js';
import {select, type Selection} from '../../selection.js';
import type {DomainSpec, SourceSpec} from '../../derivation.js';
import {statedFaceIds} from '../../faces.js';
import {cornerIndex} from '../../corners.js';
import {add3, cross3, finite3, mul3, sub3, type Vec3} from '../math.js';
import {orient2d} from 'robust-predicates';
import type {Rotation} from '../rotation.js';

/** Internal lineage: the derivation, the ids of the rows it read, and, when
 * it read more than one value, which of its inputs holds each parent. */
export interface Provenance3 { readonly operation: string; readonly parents: readonly string[]; readonly inputs?: readonly number[] }

/** The domains of a value in space. */
export type Domain3 = 'points' | 'edges' | 'faces' | 'corners';
export const DOMAINS3: readonly Domain3[] = Object.freeze(['points', 'edges', 'faces', 'corners']);
/** One domain's columns, by name. */
export type Columns3 = Readonly<Record<string, AnyColumn>>;
/** What each made row of one domain came from; absent where nothing did. */
export type Lineage3 = Readonly<Partial<Record<Domain3, readonly (Provenance3 | undefined)[]>>>;
/** How each domain's columns cross a later edit, by column name (a column
 * with none takes the default: interpolate, copy, nearest). Corners have
 * none. */
export interface Policies3 {
  readonly points: Readonly<Record<string, PointTransfer>>;
  readonly edges: Readonly<Record<string, EdgeTransfer>>;
  readonly faces: Readonly<Record<string, FaceTransfer>>;
}

const EMPTY_COLS: Columns3 = Object.freeze({});
const NO_LOOP: readonly number[] = Object.freeze([]);
const NO_POLICIES: Policies3 = Object.freeze({points: Object.freeze({}), edges: Object.freeze({}), faces: Object.freeze({})});

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
  /** The columns' policies (absent: none declared). */
  readonly policies?: () => Policies3;
  /** What the incidence and the attachment are kept by: the loops of the
   * statement of faces (or anything else that fixes them). */
  readonly topology: object;
  /** The value read, when it is one. */
  readonly value?: Material;
}

/** Incidence kept per statement of faces. */
interface Incidence3 {
  pointFaces?: readonly (readonly number[])[];
  faceNeighbors?: readonly (readonly number[])[];
  edgeFaces?: {readonly edges: Uint32Array; readonly faces: readonly (readonly number[])[]};
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
  private policiesRead?: Policies3;
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
  /** How each domain's columns cross a later edit, as declared. */
  get policies(): Policies3 {
    return (this.policiesRead ??= this.parts.policies?.() ?? NO_POLICIES);
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
    // The same loops over another edge list (loose edges added) are other
    // edges: the faces on each are kept per edge list.
    const kept = incidenceOf(this.topology);
    if (kept.edgeFaces === undefined || kept.edgeFaces.edges !== this.edges) {
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
      kept.edgeFaces = {edges: this.edges, faces: Object.freeze(rows.map((row) => Object.freeze(row)))};
    }
    return kept.edgeFaces.faces;
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

/** Deterministic ear clipping of a simple polygon. No fan triangulation of
 * concave faces; robust orientation guards crossings and ear containment.
 * A nonplanar polygon is clipped in its own average plane, so the face becomes
 * the triangles that plane gives: the polygon is authoring topology, the
 * triangles are what is drawn and occluded.
 *
 * A polygon with no plane at all — zero extent, cancelling winding, no ear to
 * clip — yields no triangles rather than failing. The face keeps its identity,
 * its corners and its place in the face order (`triangle.face` indices and
 * chart callbacks stay aligned); it simply contributes nothing to draw. */
export function triangulate(positions: readonly Vec3[], vertices: readonly number[]): [number, number, number][] {
  const origin = positions[vertices[0]];
  const local = vertices.map(i => sub3(positions[i], origin));
  const extent = Math.max(...local.map(p => Math.hypot(...p)));
  if (!(extent > 0) || !Number.isFinite(extent)) return [];
  const normalized = local.map(p => mul3(p, 1 / extent));
  let normal: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < normalized.length; i++) normal = add3(normal, cross3(normalized[i], normalized[i + 1]));
  const norm = Math.hypot(...normal);
  if (!(norm > 1e-14)) return [];
  normal = mul3(normal, 1 / norm);
  const drop = Math.abs(normal[0]) > Math.abs(normal[1]) ? (Math.abs(normal[0]) > Math.abs(normal[2]) ? 0 : 2) : (Math.abs(normal[1]) > Math.abs(normal[2]) ? 1 : 2);
  const projected = normalized.map(p => drop === 0 ? [p[1], p[2]] : drop === 1 ? [p[0], p[2]] : [p[0], p[1]]);
  const turn = (a: number, b: number, c: number) => -orient2d(...projected[a] as [number, number], ...projected[b] as [number, number], ...projected[c] as [number, number]);
  const between = (a: number, b: number, p: number) => projected[p].every((v, k) => v >= Math.min(projected[a][k], projected[b][k]) && v <= Math.max(projected[a][k], projected[b][k]));
  for (let i = 0; i < vertices.length; i++) for (let j = i + 1; j < vertices.length; j++) {
    const b = (i + 1) % vertices.length, d = (j + 1) % vertices.length;
    if (i === j || b === j || d === i) continue;
    const x = turn(i, b, j), y = turn(i, b, d), z = turn(j, d, i), w = turn(j, d, b);
    if ((x * y < 0 && z * w < 0) || (x === 0 && between(i, b, j)) || (y === 0 && between(i, b, d)) || (z === 0 && between(j, d, i)) || (w === 0 && between(j, d, b))) throw new Error('surface face must be simple without crossings or touching edges');
  }
  const area = projected.reduce((sum, p, i) => { const q = projected[(i + 1) % projected.length]; return sum + p[0] * q[1] - p[1] * q[0]; }, 0);
  const sign = Math.sign(area), remaining = vertices.map((_, i) => i), triangles: [number, number, number][] = [];
  while (remaining.length > 3) {
    let found = false;
    for (let j = 0; j < remaining.length; j++) {
      const a = remaining[(j + remaining.length - 1) % remaining.length], b = remaining[j], c = remaining[(j + 1) % remaining.length];
      if (turn(a, b, c) * sign <= 0) continue;
      if (remaining.some(p => p !== a && p !== b && p !== c && turn(a, b, p) * sign >= 0 && turn(b, c, p) * sign >= 0 && turn(c, a, p) * sign >= 0)) continue;
      triangles.push([vertices[a], vertices[b], vertices[c]]); remaining.splice(j, 1); found = true; break;
    }
    if (!found) return [];
  }
  if (turn(remaining[0], remaining[1], remaining[2]) * sign <= 0) return [];
  triangles.push(remaining.map(i => vertices[i]) as [number, number, number]);
  return triangles;
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
    // What the faces ARE: a column write (a corner column too) keeps the
    // loops, and with them the incidence and the attachment.
    topology: stated?.cycles ?? s.edgeList,
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
    policies: () => policiesOf3(m),
  });
}

/** @internal The policies `m` declares for its columns (see `Policies3`). */
export function policiesOf3(m: Material): Policies3 {
  const faces: Record<string, FaceTransfer> = {};
  for (const name in m.faceAttrs) if (m.faceAttrs[name].transfer !== 'nearest') faces[name] = m.faceAttrs[name].transfer;
  return Object.freeze({points: m.transfers, edges: m.edgeTransfers, faces: Object.freeze(faces)});
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
export function turnedOver3(stated: StatedFaces, turned: StatedFaces): void {
  TOKENS.set(turned.cycles, tokenOf(stated.cycles));
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
  /** The points of a later input (by its index in the carry's `inputs`)
   * that the answer holds as points of its own: that input's name for the
   * point → the answer's. The first input's are held by name (see
   * `MadeCarry3.from`); an edge between two held points of one input is
   * held too, where that input has one between them. */
  readonly held?: readonly (ReadonlyMap<string, string> | undefined)[];
}

/** @internal An answer with no rows: nothing to draw. */
export const NO_ROWS3: Made3 = Object.freeze({
  x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0),
  names: Object.freeze({points: [], edges: [], faces: [], corners: []}),
  loops: [], triangles: [], edges: new Uint32Array(0),
});

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
 * no id minted. Its columns keep the policies of `policies` (the value the
 * kernel read). */
export function meshOfMade3(made: Made3, policies: Policies3 = NO_POLICIES): Mesh3 {
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
    policies: () => policies,
    topology: made,
  });
}

/**
 * @internal The edge columns a kernel answers for the edges it makes, by
 * the policies `mesh` holds: made edge `i` takes the columns of edge
 * `rows[i]` of `mesh` (-1: none, the kinds' defaults), and a column that
 * distributes holds a part of it — `shares[i]` of that edge's value (a
 * piece's part of its length; 1 for a whole copy; 0 for an edge that
 * covers none of it), or, where `shares[i]` is a list `[e0, w0, e1, w1,
 * …]`, the sum of each edge's value times its weight (an edge that covers
 * several). Absent `shares`: each a whole copy. Only numbers and vectors
 * distribute; references and placements are `made3`'s to carry.
 */
export function edgeColumns3(mesh: Mesh3, rows: ArrayLike<number>, shares?: readonly (number | readonly number[])[]): Record<string, AnyColumn> {
  const out: Record<string, AnyColumn> = {};
  const cols = mesh.cols.edges;
  const policies = mesh.policies.edges;
  const n = rows.length;
  let whole = true;
  for (let i = 0; i < n && whole; i++) if (rows[i] < 0) whole = false;
  for (const name in cols) {
    const column = cols[name];
    if (!kernelColumn(column)) continue;
    const kind = kindOf(column);
    if (shares === undefined || policies[name] !== 'distribute' || (kind.name !== 'number' && kind.name !== 'vector')) {
      out[name] = whole ? column.keep(Array.from(rows)) : (kind as {from(values: ArrayLike<unknown>): AnyColumn}).from(Array.from(rows, (r) => (r < 0 ? kind.default : (column as {get(i: number): unknown}).get(r))));
      continue;
    }
    const width = kind.width;
    const from = column.flat() as Float64Array;
    const flat = new Float64Array(n * width);
    for (let i = 0; i < n; i++) {
      const share = shares[i];
      for (let s = 0; s < width; s++) {
        if (typeof share === 'number') flat[i * width + s] = rows[i] < 0 ? 0 : from[rows[i] * width + s] * share;
        else {
          let sum = 0;
          for (let k = 0; k < share.length; k += 2) sum += from[share[k] * width + s] * share[k + 1];
          flat[i * width + s] = sum;
        }
      }
    }
    out[name] = (kind as {of(flat: Float64Array): AnyColumn}).of(flat);
  }
  return out;
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
  /** The policies of a domain whose columns are not its input's of the
   * same name and domain (a dual's points are faces), said outright. Any
   * other domain's column keeps the policy of the first input that holds
   * it. */
  readonly policies?: Partial<Policies3>;
  readonly key?: string;
  readonly prototype?: Material;
  /** Where the rows came from (the core's `source` spec). */
  readonly source?: MaterialParts['source'];
  /** Point columns a kernel never sees (a sample's placement), one a
   * point: set over every other point column, the carried ones too. */
  readonly pointCols?: Columns3;
  /** Every value the kernel read, in the order its lineage's `inputs` count
   * them (absent: `from` alone): a made edge descends from the edge its
   * lineage names, and each one's reference and placement columns ride
   * across. */
  readonly inputs?: readonly Material[];
}

/** The ids of a domain's rows: a name `from` holds is that row's id (an
 * edge also by its two points), any other a fresh one, minted in row order.
 * `rows` answers each kept row's row in `from` (-1: a fresh one). */
function domainIds(names: readonly string[], known: Map<string, number> | undefined, fromIds: ArrayLike<number> | undefined, byEnds?: {readonly map: Map<string, number>; readonly key: (i: number) => string}, rows?: Int32Array): Float64Array {
  const out = new Float64Array(names.length);
  let fresh = 0;
  for (let i = 0; i < names.length; i++) {
    const row = known?.get(names[i]) ?? byEnds?.map.get(byEnds.key(i));
    if (rows !== undefined) rows[i] = row ?? -1;
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

/** Each edge's lineage root: a kept edge keeps its row's in `from`; a made
 * edge whose lineage names one parent, an edge of the input it names,
 * descends from it and takes its root, as a split's piece does; any other
 * edge is its own root. */
function edgeRoots(ids: Float64Array, kept: Int32Array, from: Material | undefined, inputs: readonly Material[], lineage: Lineage3['edges']): Float64Array {
  const out = Float64Array.from(ids);
  const fromRoots = from?.store.edgeRoots.flat();
  const byName = new Map<Material, Map<string, number>>();
  for (let e = 0; e < out.length; e++) {
    if (kept[e] >= 0) {
      out[e] = fromRoots![kept[e]];
      continue;
    }
    const l = lineage?.[e];
    if (l === undefined || l.parents.length !== 1) continue;
    const input = inputs[l.inputs?.[0] ?? 0];
    if (input === undefined) continue;
    let rows = byName.get(input);
    if (rows === undefined) byName.set(input, (rows = rowOfName(mesh3(input).names.edges)));
    const row = rows.get(l.parents[0]);
    if (row !== undefined) out[e] = input.store.edgeRoots.flat()[row];
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

/**
 * One value a kernel read, as `made3` carries from it: its reader, which
 * rows of the answer are rows of it (`rows`, per domain: the answer's row →
 * its row, -1 for none), and the row here that a reference it holds names
 * (`named`). The first input (`from`) holds the rows whose names it holds,
 * and a reference of it names the same row, whose id is kept. A later input
 * holds the points `made.held` says and the edges between two of them, and
 * a reference of it names the row here that is its row, or no row.
 */
class Carried3 {
  readonly mesh: Mesh3;
  private readonly memo = new Map<Domain3, Int32Array>();
  private ids?: Map<number, number>;

  constructor(
    private readonly input: Material,
    private readonly first: boolean,
    private readonly made: Made3,
    private readonly held: ReadonlyMap<string, string> | undefined,
    private readonly answerIds: Readonly<Record<Domain3, Float64Array>>,
    private readonly keptEdges: Int32Array,
  ) {
    this.mesh = mesh3(input);
  }

  rows(d: Domain3): Int32Array {
    let got = this.memo.get(d);
    if (got === undefined) this.memo.set(d, (got = this.find(d)));
    return got;
  }

  named(id: number | null): number | null {
    if (id === null || this.first) return id;
    if (this.ids === undefined) {
      this.ids = new Map();
      const theirs = {points: this.input.store.pointIds.flat(), edges: this.input.store.edgeIds.flat()};
      for (const d of ['points', 'edges'] as const) this.rows(d).forEach((r, i) => { if (r >= 0) this.ids!.set(theirs[d][r], this.answerIds[d][i]); });
    }
    return this.ids.get(id) ?? null;
  }

  private find(d: Domain3): Int32Array {
    const {made, mesh} = this;
    if (this.first) {
      if (d === 'edges') return this.keptEdges;
      const own = rowOfName(mesh.names[d]);
      return Int32Array.from(made.names[d], (name) => own.get(name) ?? -1);
    }
    if (this.held === undefined || (d !== 'points' && d !== 'edges')) return new Int32Array(made.names[d].length).fill(-1);
    if (d === 'points') return heldPoints(made, mesh, this.held);
    // An edge between two held points is the input's edge between them.
    const points = this.rows('points');
    const at = new Map<number, number>();
    for (let e = 0; e < mesh.edgeCount; e++) at.set(pairKey(mesh.edges[2 * e], mesh.edges[2 * e + 1]), e);
    return Int32Array.from({length: made.edges.length / 2}, (_, e) => {
      const a = points[made.edges[2 * e]];
      const b = points[made.edges[2 * e + 1]];
      return a < 0 || b < 0 ? -1 : at.get(pairKey(a, b)) ?? -1;
    });
  }
}
/** The answer's point → the input's point it is, from `made.held`. */
function heldPoints(made: Made3, mesh: Mesh3, held: ReadonlyMap<string, string>): Int32Array {
  const theirs = rowOfName(mesh.names.points);
  const ours = rowOfName(made.names.points);
  const out = new Int32Array(made.names.points.length).fill(-1);
  for (const [their, our] of held) {
    const i = ours.get(our);
    const r = theirs.get(their);
    if (i !== undefined && r !== undefined) out[i] = r;
  }
  return out;
}

/**
 * The reference and placement columns of one domain, of every input, onto
 * the rows a kernel answered: a row an input holds takes that input's value
 * (the first input that holds it; a column it does not declare, the
 * default), a row made from others its first parent's (in the input its
 * lineage names), any other the default. A reference is read as the row it
 * names here. A column two inputs declare is one column; declared as two
 * kinds, or as a column a kernel reads by another input, it is refused.
 */
function carried(d: Domain3, made: Made3, from: readonly Carried3[]): Record<string, AnyColumn> {
  const found = new Map<string, {kind: typeof kinds.reference | typeof kinds.placement; by: (AnyColumn | undefined)[]}>();
  from.forEach(({mesh}, j) => {
    const cols = mesh.cols[d];
    for (const name in cols) {
      const column = cols[name];
      if (kernelColumn(column)) continue;
      const kind = kindOf(column) as typeof kinds.reference | typeof kinds.placement;
      let got = found.get(name);
      if (got === undefined) found.set(name, (got = {kind, by: from.map(() => undefined)}));
      else if (got.kind !== kind) throw twoKinds(name, got.kind, kind);
      got.by[j] = column;
    }
  });
  if (found.size === 0) return {};
  for (const [name, {kind}] of found) {
    for (const {mesh} of from) {
      const other = mesh.cols[d][name];
      if (other !== undefined && kernelColumn(other)) throw twoKinds(name, kind, kindOf(other));
    }
  }
  const names = made.names[d];
  const lineage = made.lineage?.[d];
  const held = from.map((c) => c.rows(d));
  const byName = new Map<number, Map<string, number>>();
  const rowIn = (j: number, name: string): number | undefined => {
    let map = byName.get(j);
    if (map === undefined) byName.set(j, (map = rowOfName(from[j].mesh.names[d])));
    return map.get(name);
  };
  // Where each row reads: an input and its row there, or nowhere.
  const input = new Int32Array(names.length).fill(-1);
  const row = new Int32Array(names.length).fill(-1);
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < from.length && input[i] < 0; j++) if (held[j][i] >= 0) { input[i] = j; row[i] = held[j][i]; }
    const l = lineage?.[i];
    if (input[i] >= 0 || l === undefined) continue;
    for (let k = 0; k < l.parents.length && input[i] < 0; k++) {
      const j = l.inputs?.[k] ?? 0;
      if (from[j] === undefined) continue;
      const at = rowIn(j, l.parents[k]);
      if (at !== undefined) { input[i] = j; row[i] = at; }
    }
  }
  const out: Record<string, AnyColumn> = {};
  for (const [name, {kind, by}] of found) {
    const values: unknown[] = [];
    for (let i = 0; i < names.length; i++) {
      const column = input[i] < 0 ? undefined : by[input[i]];
      if (column === undefined) { values.push(kind.default); continue; }
      const v = (column as {get(i: number): unknown}).get(row[i]);
      values.push(kind === kinds.reference ? from[input[i]].named(v as number | null) : v);
    }
    out[name] = (kind as {from(values: ArrayLike<unknown>): AnyColumn}).from(values);
  }
  return out;
}
const twoKinds = (name: string, a: {readonly name: string}, b: {readonly name: string}): Error =>
  new Error(`the column '${name}' holds ${kindWords(a as never)} on one row and ${kindWords(b as never)} on another: a column holds one kind`);

/** The policy of each column of the answer, per domain: said outright
 * (`carry.policies`), or the policy of the first input that holds a column
 * of that name in that domain. */
function policiesOfAnswer(cols: Readonly<Record<Domain3, Columns3>>, from: readonly Carried3[], said: Partial<Policies3> | undefined): Policies3 {
  const of = <K extends 'points' | 'edges' | 'faces'>(d: K): Policies3[K] => {
    if (said?.[d] !== undefined) return said[d]!;
    const out: Record<string, string> = {};
    for (const name in cols[d]) {
      const holder = from.find(({mesh}) => Object.hasOwn(mesh.cols[d], name));
      const policy = holder?.mesh.policies[d][name];
      if (policy !== undefined) out[name] = policy;
    }
    return out as Policies3[K];
  };
  return {points: of('points'), edges: of('edges'), faces: of('faces')};
}

/** @internal A kernel's answer as the one geometry (see the module note). */
export function made3(made: Made3, carry: MadeCarry3 = {}): Material {
  const from = carry.from === undefined ? undefined : mesh3(carry.from);
  const inputs = carry.inputs ?? (carry.from === undefined ? [] : [carry.from]);
  const cols = made.cols ?? {};
  const ids = {} as Record<Domain3, Float64Array>;
  const edges = made.edges;
  const keptEdges = new Int32Array(made.names.edges.length).fill(-1);
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
    ids[d] = domainIds(names, known, from === undefined ? undefined : idsOf(from, d), byEnds, d === 'edges' ? keptEdges : undefined);
  }
  const sources = inputs.map((input, j) => new Carried3(input, input === carry.from, made, made.held?.[j], ids, keptEdges));
  const withCarried = {} as Record<Domain3, Columns3>;
  for (const d of DOMAINS3) {
    const extra = carried(d, made, sources);
    withCarried[d] = Object.keys(extra).length === 0 ? (cols[d] ?? EMPTY_COLS) : Object.freeze({...(cols[d] ?? {}), ...extra});
  }
  if (carry.pointCols !== undefined) withCarried.points = Object.freeze({...withCarried.points, ...carry.pointCols});
  const policies = policiesOfAnswer(withCarried, sources, carry.policies);
  return materialFromParts({
    x: made.x,
    y: made.y,
    z: made.z,
    pointCols: withCarried.points,
    edges,
    edgeCols: withCarried.edges,
    faces: made.loops.map((loop, f) => ({loop, triangles: made.triangles[f]})),
    ...(made.loops.length > 0 ? {faceRows: withCarried.faces, cornerColumns: withCarried.corners} : {}),
    ids: {points: ids.points, edges: ids.edges, edgeRoots: edgeRoots(ids.edges, keptEdges, carry.from, inputs, made.lineage?.edges), faces: ids.faces, corners: ids.corners},
    keys: made.names,
    ...(carry.source !== undefined ? {source: carry.source} : {}),
    transfers: {...policies.points},
    edgeTransfers: {...policies.edges},
    faceTransfers: {...policies.faces},
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
 * row it kept as it was is its own row in the first input that holds it
 * (by its name, or by the name a later input's `held` gives it there).
 */
function foundOf(operation: string, inputs: readonly Material[], name: string, lineage: Provenance3 | undefined, heldBy?: readonly (ReadonlyMap<string, string> | undefined)[]): readonly Found3[] {
  const own = lineage !== undefined && lineage.operation === operation;
  const parents = own ? lineage!.parents : [name];
  const where = own ? lineage!.inputs : undefined;
  const groups: Found3[] = [];
  parents.forEach((parent, k) => {
    const tried = where !== undefined ? [where[k]] : inputs.map((_, i) => i);
    for (const i of tried) {
      const input = inputs[i];
      if (input === undefined) continue;
      const theirs = own ? undefined : heldBy?.[i]?.get(parent);
      const found = rowsByName(input).get(parent) ?? (theirs === undefined ? undefined : rowsByName(input).get(theirs));
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
  // A later input's held points, by the answer's name.
  const heldBy = made.held?.map((held) => (held === undefined ? undefined : new Map([...held].map(([theirs, ours]) => [ours, theirs]))));
  const found = (d: 'points' | 'edges'): readonly (readonly Found3[])[] => made.names[d].map((name, i) => foundOf(operation, inputs, name, made.lineage?.[d]?.[i], d === 'points' ? heldBy : undefined));
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

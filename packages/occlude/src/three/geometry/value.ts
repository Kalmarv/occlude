/**
 * @internal The 3D layer's door to the one geometry.
 *
 * A 3D value is a `Material` with a `z` column: points, edges, stated
 * polygon faces and their corners, typed columns, minted ids. The kernels
 * read and write the `Surface3` working view (parts.ts). This module is
 * where the two meet:
 *
 *   value3(surface, carry)  a kernel's surface as the one geometry, through
 *                           the core's `materialFromParts`; the view it was
 *                           made from is kept as its working view;
 *   surfaceOf(m)            the working view of any geometry, built from its
 *                           parts on first need and kept on the value
 *                           (`m.cache.surface`);
 *   mapPositions3(m, move)  every point moved, as a map over the x, y and z
 *                           columns: no view, no kernel.
 *
 * The core keeps what the view needs row by row: every row's kernel name
 * (`store.pointKeys`/`edgeKeys`, the stated faces' `faceKeys`/`cornerKeys`),
 * carried by every write that keeps the row; and the faces' FIXED
 * triangles, which are face data: the statement holds them as positions
 * round each loop (`FacePart.triangles`), and every write that keeps the
 * faces keeps them.
 *
 * What is not a row's is kept here, beside what carries it: the object's
 * own pivot and orientation, and a recorded radial centre, beside the point
 * id column — a write that keeps the rows keeps the column, and so keeps
 * them. The key and the prototype are value fields the core carries.
 */

import {Column, type AnyColumn} from '../../column.js';
import {Material, materialFromParts, partsOfMaterial, type MaterialParts} from '../../material.js';
import type {StatedFaces} from '../../faces.js';
import {carryLinks} from '../../derivation.js';
import {keepRows} from '../../column.js';
import {rotation3, type Rotation} from '../rotation.js';
import type {Vec3} from '../math.js';
import type {Surface3} from './surface.js';
import {partsOfSurface, surfaceOfParts, type Columns3, type Lineage3} from './parts.js';
import {captureSurface3} from './model.js';
import {inheritTopology3, shareTopology3} from './topology.js';
import {ownerOf} from '../../views.js';

/** How a point column refines, as `set(…, { transfer })` declares it. */
export type Transfers3 = Readonly<Record<string, 'interpolate' | 'nearest'>>;

/** @internal What a value in space holds beside its rows: its own pivot,
 * carried by `translate`, and orientation, and a recorded radial centre.
 * (Its key and the prototype it places are value fields, `m.key` and
 * `m.prototype`.) */
export interface Kernel3 {
  /** The object's own pivot, carried by `translate`, and its orientation. */
  readonly origin: Vec3;
  readonly orientation: Rotation;
  /** A centre the value was generated radially about (see `radialCentre`). */
  readonly radialCentre?: Vec3;
}

/** What a kernel result carries besides its surface. */
export interface Carry3 {
  /** The value the kernel read first: a row it kept keeps its id, and its
   * reference and placement columns ride across. */
  readonly from?: Material;
  readonly origin?: Vec3;
  readonly orientation?: Rotation;
  readonly radialCentre?: Vec3;
  readonly transfers?: Transfers3;
  readonly key?: string;
  readonly prototype?: Material;
  /** Where the rows came from (the core's `source` spec). */
  readonly source?: MaterialParts['source'];
  /** Point columns a kernel never sees (a sample's placement), one a point. */
  readonly pointCols?: Readonly<Record<string, AnyColumn>>;
}

/** The kernel state, beside the point id column that carries it. */
const KERNELS = new WeakMap<Column, Kernel3>();
const ORIGIN: Vec3 = Object.freeze([0, 0, 0]) as unknown as Vec3;
const IDENTITY = rotation3([0, 0, 0]);
const NONE: Kernel3 = Object.freeze({origin: ORIGIN, orientation: IDENTITY});

/** @internal The kernel state of `m`: its own, or the one its rows were
 * kept from; the default for a value the 3D layer never made. */
export function kernelOf(m: Material): Kernel3 {
  return KERNELS.get(m.store.pointIds) ?? NONE;
}
const kernelFrom = (carry: Carry3): Kernel3 => Object.freeze({
  origin: carry.origin ?? ORIGIN,
  orientation: carry.orientation ?? IDENTITY,
  ...(carry.radialCentre !== undefined ? {radialCentre: carry.radialCentre} : {}),
});

/** @internal A kernel's surface as the one geometry. */
export function value3(surface: Surface3, carry: Carry3 = {}): Material {
  const made = partsOfSurface(surface, carry.from === undefined ? undefined : partsOfMaterial(carry.from));
  const m = materialFromParts({
    ...made,
    ...(carry.pointCols !== undefined ? {pointCols: {...made.pointCols, ...carry.pointCols}} : {}),
    ...(carry.source !== undefined ? {source: carry.source} : {}),
    ...(carry.transfers !== undefined ? {transfers: {...carry.transfers}} : {}),
    ...(carry.key !== undefined ? {key: carry.key} : {}),
    ...(carry.prototype !== undefined ? {prototype: carry.prototype} : {}),
  });
  KERNELS.set(m.store.pointIds, kernelFrom(carry));
  // The view is the kernel's surface row for row and name for name: the
  // surface itself when nothing was filled in, else one read from the
  // value that takes the surface's topology revision, so adjacency and
  // attachment lineage carry on.
  let view: Surface3;
  if (made.complete && carry.pointCols === undefined) view = captureSurface3(surface);
  else {
    view = surfaceOfParts(partsOfMaterial(m), made.lineage);
    inheritTopology3(view, surface);
  }
  keepView(m, view);
  return m;
}

/** @internal The working view of any geometry (see the module note), kept on
 * the value. A value with no `z` is at z = 0. */
export function surfaceOf(m: Material): Surface3 {
  const known = m.cache.surface;
  if (known !== undefined) return known;
  const view = surfaceOfParts(partsOfMaterial(m));
  // A write that kept the topology — the same edge list, loops and names —
  // keeps the adjacency built for the state it was made from; a mirror
  // keeps the attachment lineage of the view it turned over.
  const donor = DONORS.get(m.store.edgeList);
  const from = m.cache.turnedFrom;
  if (from !== undefined) m.cache.turnedFrom = undefined;
  if (from === undefined && donor !== undefined && donor.cycles === m.stated?.cycles && donor.pointKeys === m.store.pointKeys && donor.n === m.n) {
    shareTopology3(view, donor.view);
    m.cache.surface = view;
  } else {
    if (from !== undefined) inheritTopology3(view, surfaceOf(from));
    keepView(m, view);
  }
  return view;
}


/** Keep `view` as the working view of `m`, and as the last view read for
 * its edge list. */
function keepView(m: Material, view: Surface3): void {
  m.cache.surface = view;
  DONORS.set(m.store.edgeList, {view, cycles: m.stated?.cycles, pointKeys: m.store.pointKeys, n: m.n});
}

/** The last view read for an edge list, with what makes its topology: a
 * view of the same edge list, loops, point names and point count shares
 * its adjacency. */
const DONORS = new WeakMap<object, {readonly view: Surface3; readonly cycles: unknown; readonly pointKeys: unknown; readonly n: number}>();
declare module '../../material.js' {
  interface StateCache {
    /** The working view (`surfaceOf`). */
    surface?: Surface3;
    /** A value turned over by a mirror: the value it was turned from. Its
     * faces run the other way, and its attachment lineage is that value's
     * view's, read when its own view is first built. */
    turnedFrom?: Material;
  }
}

// ─── positions as a column map ──────────────────────────────────────────

/** How `mapPositions3` moves a value. */
export interface Moved3 {
  /** The motion turns space over: every stated face is turned over too. */
  readonly mirror?: boolean;
  /** The moved value's own pivot, orientation and radial centre; absent,
   * `m`'s. */
  readonly kernel?: Kernel3;
}

/**
 * @internal `m` with every point moved through `move`: a map over the x,
 * y and z columns that keeps every row, id, kernel name, column and face,
 * and the links its rows answer `source` with. A mirror turns each stated
 * face over — its runs, its fixed triangles and its corners reversed — so
 * it still faces out. A value with no `z` gets one.
 */
export function mapPositions3(m: Material, move: (p: Vec3, i: number) => Vec3, who: string, how: Moved3 = {}): Material {
  const s = m.store;
  const n = m.n;
  const xs = s.x.flat();
  const ys = s.y.flat();
  const z = s.attrs.z;
  const zs = z instanceof Column ? z.flat() : undefined;
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const q = move([xs[i], ys[i], zs === undefined ? 0 : zs[i]], i);
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1]) || !Number.isFinite(q[2])) throw new Error(`${who}: point ${i} moves to [${q[0]}, ${q[1]}, ${q[2]}], which is not a place`);
    nx[i] = q[0];
    ny[i] = q[1];
    nz[i] = q[2];
  }
  // The moved value's own state rides beside its own id column: the ids
  // are the same numbers, in a column of its own.
  const pointIds = how.kernel === undefined ? s.pointIds : Column.of(Float64Array.from(s.pointIds.flat()));
  const faces = how.mirror === true && m.stated !== undefined ? turnedOver(m.stated) : m.stated;
  const out = carryLinks(m, new Material(nx, ny, {...s.attrs, z: nz}, s.edgeList, {
    iteration: m.iteration,
    history: [],
    edgeAttrs: s.edgeAttrs,
    transfers: {...m.transfers},
    edgeTransfers: {...m.edgeTransfers},
    ids: {points: pointIds, edges: s.edgeIds, edgeRoots: s.edgeRoots},
    keys: {points: s.pointKeys, edges: s.edgeKeys},
    faceAttrs: m.faceAttrs,
    from: m,
    faces,
  }));
  if (how.kernel !== undefined) KERNELS.set(out.store.pointIds, how.kernel);
  if (faces !== m.stated) out.cache.turnedFrom = m;
  return out;
}

/** Faces turned over: each run reversed, each fixed triangle wound the other
 * way, and the corners in the order of their reversed runs. */
function turnedOver(stated: StatedFaces): StatedFaces {
  const order: number[] = [];
  let at = 0;
  const cycles = stated.cycles.map((runs) => runs.map((run) => {
    for (let k = run.length - 1; k >= 0; k--) order.push(at + k);
    at += run.length;
    return Object.freeze([...run].reverse());
  }));
  const triangles = stated.triangles?.map((t, f) => {
    if (t === undefined) return undefined;
    const last = stated.cycles[f][0].length - 1;
    const out: number[] = [];
    for (let k = 0; k + 2 < t.length; k += 3) out.push(last - t[k], last - t[k + 2], last - t[k + 1]);
    return Object.freeze(out);
  });
  const corners: Record<string, AnyColumn> | undefined = stated.corners === undefined ? undefined : {};
  for (const name in stated.corners ?? {}) corners![name] = keepRows(stated.corners![name], order);
  return {
    ...stated,
    cycles: Object.freeze(cycles.map((runs) => Object.freeze(runs))),
    ...(triangles !== undefined ? {triangles: Object.freeze(triangles)} : {}),
    ...(corners !== undefined ? {corners: Object.freeze(corners)} : {}),
    ...(stated.cornerIds !== undefined ? {cornerIds: Float64Array.from(order, (c) => stated.cornerIds![c])} : {}),
    ...(stated.cornerKeys !== undefined ? {cornerKeys: Object.freeze(order.map((c) => stated.cornerKeys![c]))} : {}),
  };
}

// ─── the explicit stage, and questions a value answers without a view ───

/** What the explicit stage reads: a surface, or a geometry, whose working
 * view is read — as a scene object's `surface` is. */
export type StageSurface3 = Surface3 | Material;
/** @internal The surface the explicit stage reads (see `StageSurface3`). */
export function stageSurface3(input: StageSurface3): Surface3 {
  if (input instanceof Material) return surfaceOf(input);
  if (!Array.isArray((input as Surface3 | undefined)?.points)) throw new Error('expected a surface or a geometry with faces');
  return input;
}

/** @internal Does a value state faces? A value with a `z` has the faces it
 * states or none, so the count needs no working view. */
export const hasFaces = (m: Material): boolean => (m.stated?.cycles.length ?? 0) > 0;

/** @internal The value a row view belongs to. */
function ownerOfRow(row: object): Material {
  const owner = ownerOf(row);
  // A face or a corner belongs to its table, which belongs to the geometry.
  const m = owner instanceof Material ? owner : (owner as {owner?: unknown} | undefined)?.owner ?? (owner as {source?: unknown} | undefined)?.source;
  if (!(m instanceof Material)) throw new Error('expected a row of a geometry (a point, an edge, a face or a corner)');
  return m;
}
type Domain = 'points' | 'edges' | 'faces';
/** @internal A row's kernel name: what the kernels made it under. */
export function rowName(row: {readonly index: number}, domain: Domain): string {
  return surfaceOf(ownerOfRow(row))[domain][row.index].id;
}
/** @internal A row's columns as the kernels read them: numbers, booleans,
 * strings and vectors. */
export function rowAttributes(row: {readonly index: number}, domain: Domain): Readonly<Record<string, unknown>> {
  return surfaceOf(ownerOfRow(row))[domain][row.index].attributes;
}

export type {Columns3, Lineage3};

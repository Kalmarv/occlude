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
 *                           columns on first need and kept on the value
 *                           (`m.surfaceBox`).
 *
 * The core keeps what the view needs row by row: every row's kernel name
 * (`store.pointKeys`/`edgeKeys`, the stated faces' `faceKeys`/`cornerKeys`),
 * carried by every write that keeps the row; and the faces' FIXED
 * triangles, which are face data: the statement holds them as positions
 * round each loop (`FacePart.triangles`), and every write that keeps the
 * faces keeps them.
 *
 * What is not a row's is kept here, beside what carries it:
 *
 * - the object's own pivot and orientation, a recorded radial centre and
 *   the stream key, beside the point id column: a write that keeps the
 *   rows keeps the column, and so keeps them.
 *
 * A row the core added (a `points.add` on a value in space) has no kernel
 * name; the view names it for its id.
 */

import {Column, kinds, type AnyColumn} from '../../column.js';
import {Material, materialFromParts, partsOfMaterial, type FacePart, type MaterialParts} from '../../material.js';
import type {CellValue} from '../../tables.js';
import type {StatedFaces} from '../../faces.js';
import {rotation3, type Rotation} from '../rotation.js';
import type {Vec3} from '../math.js';
import {triangulate, type Surface3} from './surface.js';
import {STAGE_VIEW} from './model.js';
import {partsOfSurface, viewOfParts, viewFrom, partsOfView, type SurfaceParts, type Columns3} from './parts.js';
import {inheritTopology3, shareTopology3} from './topology.js';
import {ownerOfView} from '../../views.js';

/** How a point column refines, as `set(…, { transfer })` declares it. */
export type Transfers3 = Readonly<Record<string, 'interpolate' | 'nearest'>>;

/** @internal What a value in space holds beside its rows. */
export interface Kernel3 {
  /** The object's own pivot, carried by `translate`, and its orientation. */
  readonly origin: Vec3;
  readonly orientation: Rotation;
  /** A centre the value was generated radially about (see `radialCentre`). */
  readonly radialCentre?: Vec3;
  /** The key a scatter on this value names its stream with, and its
   * identity in a view. */
  readonly key?: string;
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

/** A cell value of a column row, as a face or corner part takes it. */
const cell = (column: AnyColumn, i: number): CellValue => (column instanceof Column ? column.get(i) : (column as {get(i: number): unknown}).get(i)) as CellValue;

/** @internal A kernel's surface as the one geometry. */
export function value3(surface: Surface3, carry: Carry3 = {}): Material {
  const fromParts = carry.from === undefined ? undefined : partsOfView(surfaceOf(carry.from));
  const made = partsOfSurface(surface, fromParts);
  const parts: SurfaceParts = carry.pointCols === undefined ? made : {...made, pointCols: Object.freeze({...made.pointCols, ...carry.pointCols})};
  const faceCount = parts.loopStarts.length - 1;
  const faceNames = Object.keys(parts.faceCols);
  const cornerNames = Object.keys(parts.cornerCols);
  // Each face's fixed triangles, as positions round its own loop.
  const local: number[][] = [];
  for (let f = 0; f < faceCount; f++) local.push([]);
  const tri = parts.triangles!, triFace = parts.triangleFaces!;
  for (let t = 0; t < triFace.length; t++) {
    const f = triFace[t], start = parts.loopStarts[f], loop = parts.loops.subarray(start, parts.loopStarts[f + 1]);
    for (let k = 0; k < 3; k++) local[f].push(loop.indexOf(tri[3 * t + k]));
  }
  const faces: FacePart[] = [];
  for (let f = 0; f < faceCount; f++) {
    const start = parts.loopStarts[f];
    const end = parts.loopStarts[f + 1];
    let cols: Record<string, CellValue> | undefined;
    if (faceNames.length > 0) {
      cols = {};
      for (const name of faceNames) cols[name] = cell(parts.faceCols[name], f);
    }
    let corners: Record<string, CellValue>[] | undefined;
    if (cornerNames.length > 0) {
      corners = [];
      for (let c = start; c < end; c++) {
        const rec: Record<string, CellValue> = {};
        for (const name of cornerNames) rec[name] = cell(parts.cornerCols[name], c);
        corners.push(rec);
      }
    }
    faces.push({loop: parts.loops.subarray(start, end), triangles: local[f], ...(cols ? {cols} : {}), ...(corners ? {corners} : {})});
  }
  const m = materialFromParts({
    x: parts.x, y: parts.y, z: parts.z,
    pointCols: parts.pointCols as Record<string, AnyColumn>,
    edges: parts.edges,
    edgeCols: parts.edgeCols as Record<string, AnyColumn>,
    faces,
    ids: {points: parts.ids.points, edges: parts.ids.edges, faces: parts.ids.faces, corners: parts.ids.corners},
    keys: {points: parts.names.points, edges: parts.names.edges, faces: parts.names.faces, corners: parts.names.corners},
    ...(carry.source !== undefined ? {source: carry.source} : {}),
    ...(carry.transfers !== undefined ? {transfers: {...carry.transfers}} : {}),
  });
  KERNELS.set(m.store.pointIds, Object.freeze({
    origin: carry.origin ?? ORIGIN,
    orientation: carry.orientation ?? IDENTITY,
    ...(carry.radialCentre !== undefined ? {radialCentre: carry.radialCentre} : {}),
    ...(carry.key !== undefined ? {key: carry.key} : {}),
  }));
  // The view is the kernel's surface row for row and name for name: the
  // surface itself when nothing was filled in, else one that takes its
  // topology revision, so adjacency and attachment lineage carry on.
  const view = carry.pointCols === undefined ? viewFrom(surface, parts) : viewOfParts(parts);
  if (carry.pointCols !== undefined) inheritTopology3(view, surface);
  m.surfaceBox.surface = view;
  DONORS.set(m.store.edgeList, {view, cycles: m.stated?.cycles, pointKeys: m.store.pointKeys, n: parts.x.length});
  return m;
}

/** A column of values by row, of the kind its values are. */
function columnOfValues(values: readonly unknown[]): AnyColumn {
  const first = values.find((v) => v !== undefined && v !== null);
  if (typeof first === 'boolean') return kinds.boolean.from(values as boolean[]);
  if (typeof first === 'string') return kinds.string.from(values as string[]);
  if (Array.isArray(first)) return kinds.vector(first.length).from(values as number[][]);
  if (typeof first === 'number' || first === undefined) return Column.of(Float64Array.from(values as number[]));
  return kinds.placement.from(values);
}
/** Kernel names, or a row's own name made from its id where it has none. */
const named = (keys: readonly string[] | null | undefined, ids: ArrayLike<number>, prefix: string): readonly string[] =>
  Array.from(ids, (id, i) => { const k = keys?.[i]; return k === undefined || k === '' ? `${prefix}${id}` : k; });

/** @internal The working view of any geometry (see the module note), kept on
 * the value. A value with no `z` is at z = 0. */
export function surfaceOf(m: Material): Surface3 {
  const known = m.surfaceBox.surface as Surface3 | null;
  if (known !== null) return known;
  const out = partsOfMaterial(m);
  const n = out.x.length;
  const stated = out.faces;
  const faceCount = stated?.loops.length ?? 0;
  const loopStarts = new Uint32Array(faceCount + 1);
  for (let f = 0; f < faceCount; f++) loopStarts[f + 1] = loopStarts[f] + stated!.loops[f].length;
  const loops = new Uint32Array(loopStarts[faceCount]);
  for (let f = 0; f < faceCount; f++) loops.set(stated!.loops[f], loopStarts[f]);
  // Face columns come back as values by face row; the view reads columns.
  const faceCols: Record<string, AnyColumn> = {};
  for (const [name, values] of Object.entries(stated?.cols ?? {})) faceCols[name] = columnOfValues(values);
  const pointNames = named(out.keys.points, out.ids.points, '2d:');
  // The fixed triangles the statement holds, face by face; a face with
  // none is triangulated from its positions.
  const zs = out.z ?? new Float64Array(n);
  let positions: Vec3[] | undefined;
  const triangles: number[] = [], triangleFaces: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const loop = stated!.loops[f], held = stated!.triangles?.[f];
    const ts = held !== undefined ? chunk3(held.map((k) => loop[k])) : triangulate(positions ??= Array.from({length: n}, (_, i): Vec3 => [out.x[i], out.y[i], zs[i]]), loop);
    for (const t of ts) { triangles.push(t[0], t[1], t[2]); triangleFaces.push(f); }
  }
  const fixed = {triangles: Uint32Array.from(triangles), triangleFaces: Uint32Array.from(triangleFaces)};
  const parts: SurfaceParts = {
    x: out.x, y: out.y, z: zs,
    pointCols: out.pointCols as Columns3,
    edges: out.edges,
    edgeCols: out.edgeCols as Columns3,
    loops, loopStarts,
    faceCols,
    cornerCols: stated?.corners.cols ?? {},
    ...fixed,
    ids: {points: out.ids.points, edges: out.ids.edges, faces: stated?.ids.faces ?? new Float64Array(faceCount), corners: stated?.ids.corners ?? new Float64Array(loops.length)},
    names: {
      points: pointNames,
      edges: named(out.keys.edges, out.ids.edges, '2d:e'),
      faces: named(stated?.keys.faces, stated?.ids.faces ?? Float64Array.from({length: faceCount}, (_, f) => f), 'face:'),
      corners: named(stated?.keys.corners, stated?.ids.corners ?? Float64Array.from(loops, (_, c) => c), 'corner:'),
    },
    lineage: {},
  };
  const view = viewOfParts(parts);
  // A write that kept the topology — the same edge list, loops and names —
  // keeps the adjacency built for the state it was made from.
  const donor = DONORS.get(m.store.edgeList);
  if (donor !== undefined && donor.cycles === m.stated?.cycles && donor.pointKeys === m.store.pointKeys && donor.n === n) shareTopology3(view, donor.view);
  else DONORS.set(m.store.edgeList, {view, cycles: m.stated?.cycles, pointKeys: m.store.pointKeys, n});
  m.surfaceBox.surface = view;
  return view;
}

/** The last view read for an edge list, with what makes its topology: a
 * view of the same edge list, loops, point names and point count shares
 * its adjacency. */
const DONORS = new WeakMap<object, {readonly view: Surface3; readonly cycles: unknown; readonly pointKeys: unknown; readonly n: number}>();

/** @internal The value a row view belongs to. */
function ownerOfRow(row: object): Material {
  const owner = ownerOfView(row);
  // A face or a corner belongs to its table, which belongs to the geometry.
  const m = owner instanceof Material ? owner : (owner as {source?: unknown} | undefined)?.source;
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

// The explicit stage reads a geometry through the same view.
STAGE_VIEW.surfaceOf = surfaceOf as (m: never) => Surface3;

/** Three at a time. */
function chunk3(v: readonly number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let k = 0; k + 2 < v.length; k += 3) out.push([v[k], v[k + 1], v[k + 2]]);
  return out;
}

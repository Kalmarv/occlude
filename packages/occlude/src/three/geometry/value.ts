/**
 * @internal A value in space: what it carries besides its rows, and the
 * motions that keep every row.
 *
 * A 3D value is a `Material` with a `z` column: points, edges, stated
 * polygon faces with their corners and fixed triangles, typed columns,
 * minted ids and the kernels' row names. The kernels read it through
 * `mesh3` and answer columns (mesh3.ts). A motion of space needs neither:
 * `mapPositions3` maps the x, y and z columns and keeps every row, column
 * and face.
 *
 * What is not a row's is the value's own, and a value field the core
 * carries through every write: its key, the prototype it places, its own
 * origin and orientation, and a recorded radial centre (`m.key`,
 * `m.prototype`, `m.origin`, `m.orientation`, `m.radialCentre`). A rigid
 * move gives the moved ones (`Frame3`); nothing else changes them.
 */

import {Column, type AnyColumn} from '../../column.js';
import {Material} from '../../material.js';
import type {StatedFaces} from '../../faces.js';
import {carryLinks} from '../../derivation.js';
import {rotation3, type Rotation} from '../rotation.js';
import type {Vec3} from '../math.js';
import {ownerOf} from '../../views.js';
import {mesh3, turnedOver3} from './mesh3.js';

/** @internal A value's own frame in space, as a rigid move reads and
 * gives it: its origin and orientation (the user origin and no turn when
 * unset), and a recorded radial centre, if it has one (see
 * `Material.origin`). */
export interface Frame3 {
  readonly origin: Vec3;
  readonly orientation: Rotation;
  readonly radialCentre?: Vec3;
}

const ORIGIN: Vec3 = Object.freeze([0, 0, 0]) as unknown as Vec3;
const IDENTITY = rotation3([0, 0, 0]);

/** @internal The frame of `m`: its own fields, the user origin and no turn
 * where they are unset. */
export function frameOf(m: Material): Frame3 {
  return {
    origin: m.origin ?? ORIGIN,
    orientation: m.orientation ?? IDENTITY,
    ...(m.radialCentre !== undefined ? {radialCentre: m.radialCentre} : {}),
  };
}

// ─── positions as a column map ──────────────────────────────────────────

/** How `mapPositions3` moves a value. */
export interface Moved3 {
  /** The motion turns space over: every stated face is turned over too. */
  readonly mirror?: boolean;
  /** The moved value's own frame (a rigid move); absent, `m`'s (a write
   * of the points, `displace`). */
  readonly frame?: Frame3;
}

/**
 * @internal `m` with every point moved through `move`: a map over the x,
 * y and z columns that keeps every row, id, kernel name, column and face,
 * every value field, and the links its rows answer `source` with. A
 * mirror turns each stated face over — its runs, its fixed triangles and its corners reversed — so
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
  const frame = how.frame;
  const faces = how.mirror === true && m.stated !== undefined ? turnedOver(m.stated) : m.stated;
  if (faces !== undefined && faces !== m.stated) turnedOver3(m.stated!, faces);
  return carryLinks(m, new Material(nx, ny, {...s.attrs, z: nz}, s.edgeList, {
    iteration: m.iteration,
    history: [],
    edgeAttrs: s.edgeAttrs,
    transfers: {...m.transfers},
    edgeTransfers: {...m.edgeTransfers},
    ids: {points: s.pointIds, edges: s.edgeIds, edgeRoots: s.edgeRoots},
    keys: {points: s.pointKeys, edges: s.edgeKeys},
    faceAttrs: m.faceAttrs,
    from: m,
    ...(frame !== undefined ? {origin: frame.origin, orientation: frame.orientation, radialCentre: frame.radialCentre} : {}),
    faces,
  }));
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
  for (const name in stated.corners ?? {}) corners![name] = stated.corners![name].keep(order);
  return {
    ...stated,
    cycles: Object.freeze(cycles.map((runs) => Object.freeze(runs))),
    ...(triangles !== undefined ? {triangles: Object.freeze(triangles)} : {}),
    ...(corners !== undefined ? {corners: Object.freeze(corners)} : {}),
    ...(stated.cornerIds !== undefined ? {cornerIds: Float64Array.from(order, (c) => stated.cornerIds![c])} : {}),
    ...(stated.cornerKeys !== undefined ? {cornerKeys: Object.freeze(order.map((c) => stated.cornerKeys![c]))} : {}),
  };
}

// ─── questions a value answers from its columns ─────────────────────────

/** @internal Does a value state faces? A value with a `z` has the faces it
 * states or none. */
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
  return mesh3(ownerOfRow(row)).names[domain][row.index];
}

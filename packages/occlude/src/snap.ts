/**
 * snap: move every point to the best place within reach.
 *
 * A lattice is regular and a scatter is even, and neither knows anything about
 * what is under it. `snap(m, field, { radius })` gives each point a look
 * around: it moves to wherever `field` is greatest inside `radius` of where it
 * stood, or stays put if that is already the best place it can see. Marks then
 * sit ON the feature — the dark of an eye, the crest of a ridge, the edge of a
 * shape — instead of beside it, which is the difference between a stipple that
 * reads and a stipple that smears.
 *
 * Greatest, always. There is no option to seek the least, because there does
 * not need to be one: `snap(m, (x, y) => -f(x, y), …)` is the other direction,
 * and a field is a function you can negate. The same goes for anything else
 * you want it to prefer — `snap` never learns a second mode, it just reads
 * whatever field it is handed.
 *
 * The look around is a deterministic spiral of `samples` offsets over the
 * disc, plus the point's own position, so the same input always gives the same
 * output: no seed, no paper, distances in the material's own coordinates.
 * Non-finite samples are absent, exactly as they are for isolines and scatter,
 * so a field can decline to answer somewhere without moving a point there.
 *
 * Structure is untouched. Edges, columns and row order all survive: this moves
 * points, it does not add, remove or reconnect them.
 */

import { Material, material as makeMaterial } from './material.js';
import { whereRows, type PointSelection, type EdgeSelection } from './relation.js';

export type SnapField = (x: number, y: number) => number;

export interface SnapOpts {
  /** How far a point may move, in the material's own coordinates. */
  radius: number;
  /** Offsets tried inside that disc, besides staying put (default 48). */
  samples?: number;
  /** Only these points look for a better place; the rest stay where they
   * are. An edge selection is read as its endpoints. Absent is the whole
   * material. */
  where?: PointSelection | EdgeSelection;
}

/** The golden angle, which is what spaces a spiral evenly over a disc without
 * a seed and without rings that line up into spokes. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export function snap(m: Material, field: SnapField, opts: SnapOpts): Material {
  const src = makeMaterial(m);
  if (typeof field !== 'function') throw new Error('snap: expected a field, (x, y) => number');
  const asked = opts?.radius;
  if (typeof asked !== 'number') throw new Error(`snap: { radius } must be a non-negative length in the material's own coordinates, got ${String(asked)} (mm(1) and the other lengths need the sketch frame)`);
  // A radius below zero is no radius to look around in: the points stay put.
  const radius = asked > 0 ? asked : 0;
  const asked2 = opts.samples ?? 48;
  if (!Number.isInteger(asked2)) throw new Error(`snap: { samples } must be a whole number of offsets, at least 1 (got ${String(opts.samples)})`);
  // Staying put is always one of the offers, so a request for fewer than one
  // offset is one offset.
  const samples = Math.max(1, asked2);
  if (radius === 0 || src.n === 0) return src;
  // One spiral, built once and reused at every point: the offsets do not
  // depend on where the point is.
  const ox = new Float64Array(samples);
  const oy = new Float64Array(samples);
  for (let k = 0; k < samples; k++) {
    const r = radius * Math.sqrt((k + 0.5) / samples);
    const a = k * GOLDEN;
    ox[k] = Math.cos(a) * r;
    oy[k] = Math.sin(a) * r;
  }
  const x = Float64Array.from(src.x);
  const y = Float64Array.from(src.y);
  const moves = whereRows(src, opts.where, 'points', 'snap');
  for (let i = 0; i < src.n; i++) {
    // Not in the eligible region: it keeps the place it has.
    if (moves && !moves.has(i)) continue;
    let bestX = src.x[i];
    let bestY = src.y[i];
    let best = field(bestX, bestY);
    if (!Number.isFinite(best)) best = -Infinity;
    for (let k = 0; k < samples; k++) {
      const cx = src.x[i] + ox[k];
      const cy = src.y[i] + oy[k];
      const v = field(cx, cy);
      if (!Number.isFinite(v) || v <= best) continue;
      best = v;
      bestX = cx;
      bestY = cy;
    }
    x[i] = bestX;
    y[i] = bestY;
  }
  // Same structure, same columns, same policies — only the positions move.
  return new Material(x, y, Object.fromEntries(Object.entries(src.attrs).map(([name, col]) => [name, Float64Array.from(col)])), Uint32Array.from(src.edgeList), { iteration: src.iteration, history: src.history, edgeAttrs: Object.fromEntries(Object.entries(src.edgeAttrs).map(([name, col]) => [name, Float64Array.from(col)])), transfers: { ...src.transfers }, edgeTransfers: { ...src.edgeTransfers }, ids: { points: Float64Array.from(src.pointIds), edges: Float64Array.from(src.edgeIds), edgeRoots: Float64Array.from(src.edgeRoots) }, faceAttrs: src.faceAttrs, space: src.space });
}

/**
 * The chord between two sketch points, read the way the ink reads it, and
 * the space's own gap between them — one module for the three doors that
 * judge a stored chord against the geodesic it stands in for: the ink's
 * `line` sampling (record.ts), a tiling's walls (tiling.ts) and
 * `m.transform` (material.ts).
 *
 * A sphere's coordinates name a point more than once: x comes round every
 * `2π·ell`, and a pole has every x. The door says where both are — its
 * model's `+z` is the centre and `+x` a quarter turn along the base row —
 * so everything here is read off a `ModelDoor` and nothing else.
 *
 * Pure: no paper, no seed.
 */

import type { Model, ModelDoor } from './placement.js';
import { vx, vy, type Vec, type XY } from './vec.js';

/** How near a pole, in radians of the sphere, a point stands ON it: the
 * poles a model point comes back at are one rounding away, and nothing
 * that far off has an azimuth worth keeping. */
export const POLE_EPS = 1e-9;

/** The model's own gap between two model points, in radians of the
 * model, written through the chord — `2·as(|Δ|/2)`, with `|Δ|` the
 * model's own length of the difference and `as` = asin above zero, asinh
 * below — which keeps every digit of a short step. */
export function modelGap(sign: -1 | 1, P: Model, Q: Model): number {
  const d0 = P[0] - Q[0];
  const d1 = P[1] - Q[1];
  const d2 = P[2] - Q[2];
  const t = Math.sqrt(Math.max(0, d0 * d0 + d1 * d1 + sign * d2 * d2)) / 2;
  return 2 * (sign > 0 ? Math.asin(Math.min(1, t)) : Math.asinh(t));
}

/** The chord a → b as the ink names it: b's nearest name from a, and a
 * pole end on the other end's meridian. The identity off a sphere. */
export function chordNamer(door: ModelDoor): (a: XY, b: XY) => [Vec, Vec] {
  if (!(door.sign > 0)) return (a, b) => [[vx(a), vy(a)], [vx(b), vy(b)]];
  const [cx, cy] = door.down([0, 0, 1]);
  const ell = (door.down([1, 0, 0])[0] - cx) / (Math.PI / 2);
  const period = 2 * Math.PI * ell;
  const onPole = (p: Vec): boolean => Math.abs(Math.PI / 2 - Math.abs((p[1] - cy) / ell)) < POLE_EPS;
  return (a, b) => {
    let u: Vec = [vx(a), vy(a)];
    let v: Vec = [vx(b) - period * Math.round((vx(b) - u[0]) / period), vy(b)];
    if (onPole(u)) u = [v[0], u[1]];
    if (onPole(v)) v = [u[0], v[1]];
    return [u, v];
  };
}

/** The middle of the named chord. */
export function chordMiddle(door: ModelDoor): (a: XY, b: XY) => Vec {
  const chord = chordNamer(door);
  return (a, b) => {
    const [u, v] = chord(a, b);
    return [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  };
}

/** The space's own distance between two sketch points, in sketch
 * units, through the model: `ell · 2·as(|Δ|/2)`, `as` = asin above
 * zero, asinh below; the Euclidean distance on the flat door. */
export function metricGap(door: ModelDoor): (p: XY, q: XY) => number {
  const sign = door.sign;
  if (sign === 0) return (p, q) => Math.hypot(vx(q) - vx(p), vy(q) - vy(p));
  // The curvature length is where the door puts one radian along the base
  // row.
  const ell = door.down(sign > 0 ? [Math.sin(1), 0, Math.cos(1)] : [Math.sinh(1), 0, Math.cosh(1)])[0] - door.down([0, 0, 1])[0];
  return (p, q) => ell * modelGap(sign, door.up(p), door.up(q));
}

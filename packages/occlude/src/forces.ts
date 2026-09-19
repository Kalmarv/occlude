/**
 * Spatial neighbours and the force recipes: PREPARE against a frozen state
 * once, EVALUATE at a point to a vector. Nothing here moves anything — a
 * rule sums the vectors and decides (see `Material.steps`). Depends on the
 * material module (a force takes any point list through `material()`);
 * the material module never depends on this one.
 */

import { material, Material, type PointsLike, type Vertex } from './material.js';
import { length, mul, perp, sub, sumBy, unit, vx, vy, type Vec, type XY } from './vec.js';
import { ownerOf } from './views.js';
import { distanceTo } from './distance.js';
import { numericLoops, type AreaInput, type Geometry } from './boundary.js';
import { grad } from './field.js';
import type { VectorFieldFn } from './shapes.js';

// ---- spatial neighbours -----------------------------------------------------------

export interface NeighbourStats {
  queries: number;
  /** Vertices examined from the grid cells around the query point. */
  candidates: number;
  /** Of those, within the radius. */
  hits: number;
}

/**
 * Spatial neighbours of a material's vertices, prepared ONCE for the state as
 * it is now: a uniform grid over the positions. The query gives the rows
 * within `radius` of `p` (a vertex of THIS material is excluded from its own
 * query; a foreign point is not), in grid order — the sketch decides what
 * to do with them. Connectivity is a different concept and is NOT
 * excluded here. Rows are valid for this state.
 */
export function neighbours(m: Material, opts: { radius: number; stats?: NeighbourStats }): (p: XY) => number[] {
  const radius = opts.radius;
  const cell = radius;
  const stats = opts.stats;
  // Cells are indexed row-major over the material's own extent — no packed
  // key, so no two cells can share an index whatever the coordinates.
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let i = 0; i < m.n; i++) {
    if (m.x[i] < minx) minx = m.x[i];
    if (m.x[i] > maxx) maxx = m.x[i];
    if (m.y[i] < miny) miny = m.y[i];
    if (m.y[i] > maxy) maxy = m.y[i];
  }
  const gx0 = Number.isFinite(minx) ? Math.floor(minx / cell) : 0;
  const gy0 = Number.isFinite(miny) ? Math.floor(miny / cell) : 0;
  const cols = Number.isFinite(maxx) ? Math.floor(maxx / cell) - gx0 + 1 : 1;
  const rows = Number.isFinite(maxy) ? Math.floor(maxy / cell) - gy0 + 1 : 1;
  const grid = new Map<number, number[]>();
  const key = (gx: number, gy: number) => (gx - gx0 < 0 || gx - gx0 >= cols || gy - gy0 < 0 || gy - gy0 >= rows ? -1 : (gy - gy0) * cols + (gx - gx0));
  for (let i = 0; i < m.n; i++) {
    const k = key(Math.floor(m.x[i] / cell), Math.floor(m.y[i] / cell));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }
  return (p: XY): number[] => {
    const px = vx(p);
    const py = vy(p);
    const self = ownerOf(p as Vertex) === m ? (p as Vertex).index : -1;
    const out: number[] = [];
    const cx = Math.floor(px / cell);
    const cy = Math.floor(py / cell);
    if (stats) stats.queries++;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const k = key(gx, gy);
        if (k < 0) continue;
        const bucket = grid.get(k);
        if (!bucket) continue;
        if (stats) stats.candidates += bucket.length;
        for (const j of bucket) {
          if (j === self) continue;
          const dx = px - m.x[j];
          const dy = py - m.y[j];
          if (dx * dx + dy * dy < radius * radius) out.push(j);
        }
      }
    }
    if (stats) stats.hits += out.length;
    return out;
  };
}

// ---- forces -----------------------------------------------------------------------
//
// One shape: PREPARE with the source geometry once per state, then EVALUATE
// at a point to get a vector. Nothing here moves anything — the rule sums
// the vectors and decides. Two callback shapes cover the field:
//
//   p => vector        wind, drift, a vector field — works in `sum` as is
//   (p, q) => vector   interaction with another point — `nearby` finds the
//                      q's within a radius and adds your contributions up
//
// The named recipes are ordinary functions on this mechanism and the
// vocabulary. Copy one into a sketch and change it; a custom force that
// earns reuse can become a recipe.

/**
 * Points a force can be prepared from: any geometry that has points — a
 * material, a point selection, an edge selection, a face collection — or a
 * plain list of points. A point consumer reads `points`, which is the
 * protocol's answer for "where are they"; a value that has none is refused
 * by the material constructor, by name.
 */
export type Sources = Geometry | PointsLike;

/**
 * The positions a source holds.
 *
 * A material IS the answer — asking it for `points` would throw its edges
 * away, and `force.separation`'s own `excludeConnected` reads them. A point
 * selection answers `points` with itself. Everything else that has points —
 * a face collection, an edge selection — is read through the protocol.
 */
export function sourcePoints(sources: Sources): PointsLike {
  if (sources instanceof Material) return sources;
  const points = (sources as Geometry).points;
  if (points === undefined || (points as unknown) === sources) return sources as PointsLike;
  return points as unknown as PointsLike;
}

/**
 * Slack tension, prepared for `m`: `pull(p)` is the vector toward each of
 * p's CONNECTED neighbours (edge order) by the part of the gap beyond
 * `rest`. Zero when every neighbour is within `rest`: a slack chain, not
 * a spring. Needs connectivity; on a junction it pulls toward every
 * branch.
 */
export function tension(m: Material, opts: { rest: number }): (p: Vertex) => Vec {
  const { rest } = opts;
  return (p) =>
    sumBy(m.adjacentRows(p.index), (j) => {
      const delta = sub(m.vertex(j), p);
      return mul(unit(delta), Math.max(0, length(delta) - rest));
    });
}

/**
 * Separation: `repel(p)` is the vector away from every source within
 * `radius`, falling off linearly to zero at the radius and peaking at
 * `radius` when touching (strength is the radius, as in the reference
 * rule). Sources may be the material being moved or something else — obstacle
 * samples, another material. `excludeConnected: true` skips p's connected
 * neighbours when the sources are p's own material (tension owns that
 * spacing); off by default, so say it.
 */
export function separation(sources: Sources, opts: { radius: number; excludeConnected?: boolean }): (p: Vertex) => Vec {
  const { radius, excludeConnected = false } = opts;
  return radial(material(sourcePoints(sources)), radius, excludeConnected, radius, -1);
}

/** The fixed-law radial recipes (`separation`, `attract`) on the raw
 * columns: the same neighbours in the same order and the same arithmetic
 * as the generic `nearby` form — so the doubles, and the drawing, are
 * identical — without a vertex view and two tuples per neighbour. Measured
 * 20× on a 5 000-point ring (see the reference). `sign` −1 pushes away
 * from the source, +1 pulls toward it; `strength` is the value when
 * touching, fading linearly to zero at the radius. */
function radial(m: Material, radius: number, excludeConnected: boolean, strength: number, sign: number): (p: Vertex) => Vec {
  const near = neighbours(m, { radius });
  const mx = m.x;
  const my = m.y;
  return (p) => {
    const own = ownerOf(p) === m ? p.index : -1;
    const adj = excludeConnected && own >= 0 ? m.adjacentRows(own) : null;
    const px = p.x;
    const py = p.y;
    let x = 0;
    let y = 0;
    for (const j of near(p)) {
      if (adj && adj.includes(j)) continue;
      // sub(p, q) → unit → mul, spelled out in the same operations
      const dx = (px - mx[j]) * sign * -1;
      const dy = (py - my[j]) * sign * -1;
      const d = Math.sqrt(dx * dx + dy * dy); // `length` spells it so; hypot can differ in the last bit
      if (d > 0) {
        const s = (1 - d / radius) * strength;
        x += (dx / d) * s;
        y += (dy / d) * s;
      }
    }
    return [x, y];
  };
}

/**
 * Drift: a direction read from a noise function, `amount` long, turning
 * slowly with the iteration. Pure — pass the toolkit's seeded `t.noise`
 * in: `drift(t.noise, { amount })`, then `wander(p, k)`. `frequency`
 * scales position into the noise (default 0.08), `rate` the iteration
 * into its third axis (default 0.0004): angle = noise(x·f, y·f, k·rate) · 2π.
 * The default rate is small because the toolkit's noise folds z onto
 * shifted 2D slices about thirty times steeper than x and y: at 0.01 per
 * iteration the direction re-rolls every step and a trail is a random
 * walk; at 0.0004 it turns.
 */
export function drift(
  noise: (x: number, y: number, z: number) => number,
  opts: { amount: number; frequency?: number; rate?: number },
): (p: XY, k: number) => Vec {
  const { amount, frequency = 0.08, rate = 0.0004 } = opts;
  return (p, k) => {
    const a = noise(vx(p) * frequency, vy(p) * frequency, k * rate) * Math.PI * 2;
    return [Math.cos(a) * amount, Math.sin(a) * amount];
  };
}

/**
 * Attraction: `pull(p)` is the vector toward every source within `radius`,
 * `strength` when touching, fading linearly to zero at the radius —
 * separation's mirror. Sources may be the material itself (`excludeConnected`
 * as for separation) or anchor points.
 */
export function attract(
  sources: Sources,
  opts: { radius: number; strength?: number; excludeConnected?: boolean },
): (p: Vertex) => Vec {
  const { radius, strength = 1, excludeConnected = false } = opts;
  return radial(material(sourcePoints(sources)), radius, excludeConnected, strength, +1);
}

/**
 * Boundary: keep inside an area. `keep(p)` is zero deeper than `radius`
 * inside the boundary loops, grows linearly to `strength` at the edge, and
 * keeps pushing inward outside — direction from the signed distance field
 * (`distanceTo`: positive inside, holes respected; contours chord-closed).
 * Loops are any boundary: `t.material(rect(...))`, a chain material's curves,
 * pts, isolines' pts. Sampled obstacles are `separation`; this is the
 * continuous boundary.
 */
export function boundary(loops: AreaInput, opts: { radius: number; strength?: number }): (p: XY) => Vec {
  const { radius, strength = 1 } = opts;
  const inside = distanceTo(numericLoops(loops, 'force.boundary'));
  const inward = grad(inside);
  return (p) => {
    const d = inside(vx(p), vy(p));
    if (d >= radius) return [0, 0];
    return mul(unit(inward(vx(p), vy(p))), (1 - Math.max(d, 0) / radius) * strength);
  };
}

/**
 * Vortex: turn around `centre`. `swirl(p)` is tangential (counter-clockwise
 * for positive `strength`; y is down, so clockwise on the page), `strength`
 * near the centre and falling off as `1 / (1 + distance / falloff)`; zero
 * exactly at the centre.
 */
export function vortex(centre: XY, opts: { strength: number; falloff?: number }): (p: XY) => Vec {
  const { strength, falloff = 10 } = opts;
  return (p) => {
    const radial = sub(p, centre);
    return mul(perp(unit(radial)), strength / (1 + length(radial) / falloff));
  };
}

/** A vector field as a force: `field(curl(f))(p)` is the field at `p`,
 * times `strength` — the adapter that lets `grad`/`curl` fields sit in
 * `sum` beside the others. */
export function field(vf: VectorFieldFn, opts: { strength?: number } = {}): (p: XY) => Vec {
  const { strength = 1 } = opts;
  return (p) => mul(vf(vx(p), vy(p)), strength);
}

/**
 * Relax, prepared for `m`: `smooth(p)` is the vector from `p` toward the
 * mean of its connected neighbours, scaled by `amount` — Laplacian
 * smoothing as a force, the growth-free counterpart of tension. A vertex
 * with fewer than two neighbours (an open end, an isolated point) stays.
 */
export function relax(m: Material, opts: { amount?: number } = {}): (p: Vertex) => Vec {
  const { amount = 1 } = opts;
  return (p) => {
    const nb = m.adjacentRows(p.index);
    if (nb.length < 2) return [0, 0];
    let mx = 0;
    let my = 0;
    for (const j of nb) {
      mx += m.x[j];
      my += m.y[j];
    }
    return mul(sub([mx / nb.length, my / nb.length], p), amount);
  };
}

/** Prepared forces summed into one: `(p, k) => vector`. Every force gets
 * `p` and the iteration `k` (those that do not turn ignore it), so a
 * rule reads `next.move(prev.points, (p) => mul(push(p, k), speed))` with the speed
 * still the author's number. Prepare the members against `cur` each
 * step as before — nothing here binds a state. */
export function sumForces(...forces: readonly ((p: Vertex, k: number) => XY)[]): (p: Vertex, k?: number) => Vec {
  return (p, k = 0) => {
    let x = 0;
    let y = 0;
    for (const f of forces) {
      const v = f(p, k);
      x += vx(v);
      y += vy(v);
    }
    return [x, y];
  };
}

export const force = {
  sum: sumForces, tension, separation, drift, attract, boundary, vortex, field, relax };

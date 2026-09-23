/**
 * Spatial neighbours and the force recipes: PREPARE against a frozen state
 * once, EVALUATE at a point to a vector. Nothing here moves anything — a
 * rule sums the vectors and decides (see `Material.steps`). Depends on the
 * material module (a force takes any point list through `material()`);
 * the material module never depends on this one.
 */

import { material, Material, type PointsLike, type Vertex, type Edge } from './material.js';
import { length, mul, perp, sub, sumBy, unit, vx, vy, type Vec, type XY } from './vec.js';
import { ownerOf, ownerOfView } from './views.js';
import { distanceTo } from './distance.js';
import { numericLoops, type AreaInput, type Geometry } from './boundary.js';
import { grad } from './field.js';
import { valueAt } from './guard.js';
import type { VectorFieldFn } from './shapes.js';
import { bucketStretch, spaceAreaNearest, type Space } from './space.js';

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
 *
 * `opts.radius` is the grid's cell as well as the default reach. A query
 * may ask for a LARGER reach of its own, and then it walks as many rings of
 * cells as that reach needs — one grid still answers a radius that changes
 * from point to point, which is what a per-vertex `force.separation` asks
 * of it.
 */
export function neighbours(m: Material, opts: { radius: number; stats?: NeighbourStats; space?: Space }): (p: XY, reach?: number) => number[] {
  const radius = opts.radius;
  const stats = opts.stats;
  // In a curved space a radius is a length OF THE SPACE, and the grid is
  // laid out in coordinates: a cell is widened by how much longer a space
  // length can be in coordinates over the material's box (`bucketStretch`,
  // the scatter's own reading), and the test is the space's distance. The
  // flat plane widens by 1 and tests the squared coordinate distance.
  const space = opts.space !== undefined && opts.space.kind !== 'euclidean' ? opts.space : null;
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
  const widen = space && Number.isFinite(minx) ? bucketStretch(space, { x: minx, y: miny, w: maxx - minx, h: maxy - miny }) : 1;
  const cell = space ? radius * widen : radius;
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
  return (p: XY, reach?: number): number[] => {
    const px = vx(p);
    const py = vy(p);
    const self = ownerOf(p as Vertex) === m ? (p as Vertex).index : -1;
    const out: number[] = [];
    const cx = Math.floor(px / cell);
    const cy = Math.floor(py / cell);
    // The rings a reach of its own needs; the fixed radius needs one.
    const r2 = reach === undefined ? radius * radius : reach * reach;
    const far = reach === undefined ? radius : reach;
    const span = space ? (reach === undefined ? undefined : reach * widen) : reach;
    const rings = span === undefined || !(span > cell) ? 1 : Math.ceil(span / cell);
    if (stats) stats.queries++;
    for (let gx = cx - rings; gx <= cx + rings; gx++) {
      for (let gy = cy - rings; gy <= cy + rings; gy++) {
        const k = key(gx, gy);
        if (k < 0) continue;
        const bucket = grid.get(k);
        if (!bucket) continue;
        if (stats) stats.candidates += bucket.length;
        for (const j of bucket) {
          if (j === self) continue;
          if (space) {
            if (space.distance([px, py], [m.x[j], m.y[j]]) < far) out.push(j);
            continue;
          }
          const dx = px - m.x[j];
          const dy = py - m.y[j];
          if (dx * dx + dy * dy < r2) out.push(j);
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
 * The space a source's coordinates belong to: a material's own, the
 * material a selection or a view was taken from, or none — a plain list of
 * points is flat numbers. The pure recipes read it here; the toolkit's
 * `t.force.*` hand the sketch's space to the ones with no material to ask.
 */
export function spaceOfSources(sources: unknown): Space | undefined {
  if (sources instanceof Material) return sources.space;
  if (typeof sources !== 'object' || sources === null) return undefined;
  const source = (sources as { source?: unknown }).source;
  if (source instanceof Material) return source.space;
  const first = Array.isArray(sources) ? sources[0] : undefined;
  const owner = typeof first === 'object' && first !== null ? ownerOfView(first) : undefined;
  return owner instanceof Material ? owner.space : undefined;
}

/** The space a recipe measures in: a curved one, or null for the flat
 * plane and the literal old arithmetic. */
const curved = (space: Space | undefined): Space | null => (space !== undefined && space.kind !== 'euclidean' ? space : null);

/**
 * Slack tension, prepared for `m`: `pull(p)` is the vector toward each of
 * p's CONNECTED neighbours (edge order) by the part of the gap beyond
 * `rest`. Zero when every neighbour is within `rest`: a slack chain, not
 * a spring. Needs connectivity; on a junction it pulls toward every
 * branch.
 *
 * `rest` is one length, or a function of the EDGE between the two — which
 * is what a rest length is: a property of the wall, not of either end.
 * The library's own note on `'distribute'` names a rest length as the
 * example of an edge column, and this is the force that reads it:
 * `force.tension(m, { rest: (e) => e.attrs.rest })`. A rest that is not a
 * finite length is no rest at all, so that edge pulls from zero and a
 * degenerate column slackens the chain instead of tearing it.
 */
export function tension(m: Material, opts: { rest: number | ((e: Edge) => number) }): (p: Vertex) => Vec {
  const { rest } = opts;
  const space = curved(m.space);
  if (space) {
    // In a space the pull is along the geodesic to each neighbour, by the
    // part of the space's distance beyond the rest length.
    const restOf = typeof rest === 'number' ? () => rest : typeof rest === 'function' ? (e: number) => valueAt(rest(m.edge(e)), 0) : null;
    if (!restOf) throw new Error(`force.tension: { rest } must be a length, or a function of the edge — got ${String(rest)}`);
    return (p) => {
      const edgeRows = m.incidentEdgeRows(p.index);
      return sumBy(m.adjacentRows(p.index), (j, k) => {
        const q: Vec = [m.x[j], m.y[j]];
        const d = space.distance(p, q);
        return mul(unit(space.log(p, q)), Math.max(0, d - restOf(edgeRows[k])));
      });
    };
  }
  if (typeof rest === 'number') {
    return (p) =>
      sumBy(m.adjacentRows(p.index), (j) => {
        const delta = sub(m.vertex(j), p);
        return mul(unit(delta), Math.max(0, length(delta) - rest));
      });
  }
  if (typeof rest !== 'function') throw new Error(`force.tension: { rest } must be a length, or a function of the edge — got ${String(rest)}`);
  // `adjacentRows` and `incidentEdgeRows` are built by one pass over the
  // edge list and pushed to in step, so the k-th neighbour is the far end
  // of the k-th edge.
  return (p) => {
    const edgeRows = m.incidentEdgeRows(p.index);
    return sumBy(m.adjacentRows(p.index), (j, k) => {
      const delta = sub(m.vertex(j), p);
      const r = valueAt(rest(m.edge(edgeRows[k])), 0);
      return mul(unit(delta), Math.max(0, length(delta) - r));
    });
  };
}

/**
 * Separation: `repel(p)` is the vector away from every source within
 * `radius`, falling off linearly to zero at the radius and peaking at
 * `radius` when touching (strength is the radius, as in the reference
 * rule). Sources may be the material being moved or something else — obstacle
 * samples, another material. `excludeConnected: true` skips p's connected
 * neighbours when the sources are p's own material (tension owns that
 * spacing); off by default, so say it.
 *
 * `radius` may instead be a function of the VERTEX, and then each point
 * carries its own — `(p) => p.attrs.r` is discs of different sizes. The
 * radius of a PAIR is the sum of the two, which is what "these two must
 * not overlap" means for two discs, and the push peaks at that sum and
 * fades to zero there. One grid still answers: it is built at the largest
 * radius among the sources, and a query walks as many rings as its own
 * reach needs.
 */
export function separation(sources: Sources, opts: { radius: number | ((p: Vertex) => number); excludeConnected?: boolean }): (p: Vertex) => Vec {
  return separationIn(sources, opts, undefined);
}

/** @internal `separation` measuring in `space` when the sources carry none
 * of their own: the toolkit's `t.force.separation` hands the sketch's. */
export function separationIn(sources: Sources, opts: { radius: number | ((p: Vertex) => number); excludeConnected?: boolean }, space0: Space | undefined): (p: Vertex) => Vec {
  const { radius, excludeConnected = false } = opts;
  const m = material(sourcePoints(sources));
  const space = curved(spaceOfSources(sources) ?? space0);
  if (typeof radius === 'number') return radial(m, radius, excludeConnected, radius, -1, space);
  if (typeof radius !== 'function') throw new Error(`force.separation: { radius } must be a distance, or a function of the vertex — got ${String(radius)}`);
  // Each source's own radius, read once against the frozen state, as every
  // force here prepares against it. A radius the function does not answer
  // with a finite number is no radius: that source pushes nothing.
  const own = new Float64Array(m.n);
  let widest = 0;
  for (let i = 0; i < m.n; i++) {
    own[i] = Math.max(0, valueAt(radius(m.vertex(i)), 0));
    if (own[i] > widest) widest = own[i];
  }
  const near = neighbours(m, { radius: widest > 0 ? widest : 1, space: space ?? undefined });
  return (p) => {
    const rp = Math.max(0, valueAt(radius(p), 0));
    const row = ownerOf(p) === m ? p.index : -1;
    const adj = excludeConnected && row >= 0 ? m.adjacentRows(row) : null;
    let x = 0;
    let y = 0;
    // Everything that could touch p is within p's radius plus the widest
    // one in the material; the pair's own sum then decides.
    for (const j of near(p, rp + widest)) {
      if (adj && adj.includes(j)) continue;
      const r = rp + own[j];
      if (!(r > 0)) continue;
      if (space) {
        // Away from the neighbour along the geodesic: `log` toward it,
        // turned round, in p's own frame.
        const q: Vec = [m.x[j], m.y[j]];
        const d = space.distance(p, q);
        if (d <= 0 || d >= r) continue;
        const l = space.log(p, q);
        const ll = Math.hypot(l[0], l[1]);
        if (!(ll > 0)) continue;
        const s = (1 - d / r) * r;
        x -= (l[0] / ll) * s;
        y -= (l[1] / ll) * s;
        continue;
      }
      const dx = p.x - m.x[j];
      const dy = p.y - m.y[j];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 0 || d >= r) continue;
      const s = (1 - d / r) * r;
      x += (dx / d) * s;
      y += (dy / d) * s;
    }
    return [x, y];
  };
}

/** The fixed-law radial recipes (`separation`, `attract`) on the raw
 * columns: the same neighbours in the same order and the same arithmetic
 * as the generic `nearby` form — so the doubles, and the drawing, are
 * identical — without a vertex view and two tuples per neighbour. Measured
 * 20× on a 5 000-point ring (see the reference). `sign` −1 pushes away
 * from the source, +1 pulls toward it; `strength` is the value when
 * touching, fading linearly to zero at the radius. */
function radial(m: Material, radius: number, excludeConnected: boolean, strength: number, sign: number, space: Space | null): (p: Vertex) => Vec {
  if (space) return radialIn(m, radius, excludeConnected, strength, sign, space);
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

/** `radial` in a curved space: the neighbours within `radius` OF THE
 * SPACE, each pushing or pulling along the geodesic between the two —
 * direction from `log`, magnitude from the space's distance, the same
 * linear law. */
function radialIn(m: Material, radius: number, excludeConnected: boolean, strength: number, sign: number, space: Space): (p: Vertex) => Vec {
  const near = neighbours(m, { radius, space });
  return (p) => {
    const own = ownerOf(p) === m ? p.index : -1;
    const adj = excludeConnected && own >= 0 ? m.adjacentRows(own) : null;
    let x = 0;
    let y = 0;
    for (const j of near(p)) {
      if (adj && adj.includes(j)) continue;
      const q: Vec = [m.x[j], m.y[j]];
      const d = space.distance(p, q);
      const l = space.log(p, q);
      const ll = Math.hypot(l[0], l[1]);
      if (d > 0 && ll > 0) {
        const s = (1 - d / radius) * strength * sign;
        x += (l[0] / ll) * s;
        y += (l[1] / ll) * s;
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
  return attractIn(sources, opts, undefined);
}

/** @internal `attract` measuring in `space` when the sources carry none of
 * their own. */
export function attractIn(
  sources: Sources,
  opts: { radius: number; strength?: number; excludeConnected?: boolean },
  space: Space | undefined,
): (p: Vertex) => Vec {
  const { radius, strength = 1, excludeConnected = false } = opts;
  return radial(material(sourcePoints(sources)), radius, excludeConnected, strength, +1, curved(spaceOfSources(sources) ?? space));
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
  return boundaryIn(loops, opts, undefined);
}

/** @internal `boundary` in `space` when the area carries none of its own:
 * the toolkit lowers a shape to loops and hands the sketch's space. */
export function boundaryIn(loops: AreaInput, opts: { radius: number; strength?: number }, space: Space | undefined): (p: XY) => Vec {
  const { radius, strength = 1 } = opts;
  const sp = curved(spaceOfSources(loops) ?? space);
  if (sp) {
    // The space's own distance to the area — its edges read as geodesics —
    // and the direction of the geodesic to the nearest boundary point, both
    // from the one reading.
    const read = spaceAreaNearest(sp, numericLoops(loops, 'force.boundary').map((pts) => ({ pts, closed: true })));
    return (p) => {
      const r = read(vx(p), vy(p));
      if (r.distance >= radius) return [0, 0];
      return mul(r.inward, (1 - Math.max(r.distance, 0) / radius) * strength);
    };
  }
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
  return vortexIn(centre, opts, undefined);
}

/** @internal `vortex` in `space`: a centre is a bare point and carries no
 * space, so the toolkit's `t.force.vortex` hands the sketch's. */
export function vortexIn(centre: XY, opts: { strength: number; falloff?: number }, space: Space | undefined): (p: XY) => Vec {
  const { strength, falloff = 10 } = opts;
  const sp = curved(space);
  if (sp) {
    // The direction from the centre is `log(p, centre)` turned round, in
    // p's own frame, and the distance is the space's.
    return (p) => {
      const l = sp.log(p, centre);
      const radial: Vec = [-l[0], -l[1]];
      return mul(perp(unit(radial)), strength / (1 + sp.distance(p, centre) / falloff));
    };
  }
  return (p) => {
    const radial = sub(p, centre);
    return mul(perp(unit(radial)), strength / (1 + length(radial) / falloff));
  };
}

/** A vector field as a force: `field(curl(f))(p)` is the field at `p`,
 * times `strength` — the adapter that lets `grad`/`curl` fields sit in
 * `sum` beside the others. In a curved space the value is read as a
 * vector in the local frame at `p`, which is what a step walks. */
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
  const space = curved(m.space);
  if (space) {
    // The mean of the directions to the neighbours, each `log(p, q)` in
    // p's own frame: the vector to the neighbours' centre of mass.
    return (p) => {
      const nb = m.adjacentRows(p.index);
      if (nb.length < 2) return [0, 0];
      let mx = 0;
      let my = 0;
      for (const j of nb) {
        const l = space.log(p, [m.x[j], m.y[j]]);
        mx += l[0];
        my += l[1];
      }
      return mul([mx / nb.length, my / nb.length], amount);
    };
  }
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

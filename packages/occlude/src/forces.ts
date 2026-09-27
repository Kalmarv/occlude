/**
 * Spatial neighbours and the force recipes: PREPARE against a frozen state
 * once, EVALUATE at a point to a vector. Nothing here moves anything — a
 * rule sums the vectors and decides (see `Material.steps`). Depends on the
 * material module (a force takes any point list through `material()`);
 * the material module reaches this one only through `m.move`, at call
 * time, where a force said without its state is prepared.
 */

import { material, Material, type PointsLike, type Vertex, type Edge } from './material.js';
import { faceCentroids } from './faces.js';
import { length, mul, perp, sub, sumBy, unit, vx, vy, type Vec, type XY } from './vec.js';
import { ownerOf } from './views.js';
import { distanceField } from './distance.js';
import { numericLoops, refuseShape, type AreaInput, type Geometry } from './boundary.js';
import { grad } from './field.js';
import { runOf } from './execution.js';
import { valueAt } from './guard.js';
import type { VectorFieldFn } from './shapes.js';
import type { Model } from './placement.js';
import { bucketChart, carriedSpace, spaceAreaNearest, type Space } from './space.js';

// ---- spatial neighbours -----------------------------------------------------------

/** The space a recipe measures in: a curved one, or null for the flat
 * plane and the literal old arithmetic. */
const curved = (space: Space | undefined): Space | null => (space !== undefined && space.kind !== 'euclidean' ? space : null);

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
export function neighbours(m: Material, opts: { radius: number; stats?: NeighbourStats }): (p: XY, reach?: number) => number[] {
  const space = curved(m.space);
  if (space) {
    const index = neighboursIn(m, opts.radius, opts.stats, space);
    return (p, reach) => index.near(p, space.model.up(p), reach === undefined ? opts.radius : reach, null);
  }
  const radius = opts.radius;
  const stats = opts.stats;
  // The positions, read once: the index and every query read these arrays.
  const X = m.x;
  const Y = m.y;
  // Cells are indexed row-major over the material's own extent — no packed
  // key, so no two cells can share an index whatever the coordinates.
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let i = 0; i < m.n; i++) {
    if (X[i] < minx) minx = X[i];
    if (X[i] > maxx) maxx = X[i];
    if (Y[i] < miny) miny = Y[i];
    if (Y[i] > maxy) maxy = Y[i];
  }
  const cell = radius;
  const gx0 = Number.isFinite(minx) ? Math.floor(minx / cell) : 0;
  const gy0 = Number.isFinite(miny) ? Math.floor(miny / cell) : 0;
  const cols = Number.isFinite(maxx) ? Math.floor(maxx / cell) - gx0 + 1 : 1;
  const rows = Number.isFinite(maxy) ? Math.floor(maxy / cell) - gy0 + 1 : 1;
  const grid = new Map<number, number[]>();
  const key = (gx: number, gy: number) => (gx - gx0 < 0 || gx - gx0 >= cols || gy - gy0 < 0 || gy - gy0 >= rows ? -1 : (gy - gy0) * cols + (gx - gx0));
  for (let i = 0; i < m.n; i++) {
    const k = key(Math.floor(X[i] / cell), Math.floor(Y[i] / cell));
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
    const rings = reach === undefined || !(reach > cell) ? 1 : Math.ceil(reach / cell);
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
          const dx = px - X[j];
          const dy = py - Y[j];
          if (dx * dx + dy * dy < r2) out.push(j);
        }
      }
    }
    if (stats) stats.hits += out.length;
    return out;
  };
}

/**
 * `neighbours` in a curved space, where a radius is a length OF THE SPACE
 * and the grid is laid out in coordinates. The grid holds each place at its
 * home (`bucketChart`) in cells of the radius, and each query widens its
 * own search from its own row: the band of rows the radius reaches, and
 * across it the x the space's circle reaches there — around the sphere's
 * seam when it crosses it, the whole band when a pole lies within reach.
 * The test is the space's distance. In the disk the reach is never wider
 * than the flat one, so it visits a subset of the same cells in the same
 * order and answers the same rows.
 *
 * Every row is lifted to the space's model once (`lifted`), and a query
 * brings its own point lifted, so a pair is measured without lifting
 * either end again; `dists`, when given, receives each row's distance —
 * the same double `space.distance` answers — for the recipe to reuse.
 */
interface CurvedNeighbours {
  lifted: readonly Model[];
  near(p: XY, lifted: Model, far: number, dists: number[] | null): number[];
}

function neighboursIn(m: Material, radius: number, stats: NeighbourStats | undefined, space: Space): CurvedNeighbours {
  const chart = bucketChart(space);
  const cell = radius;
  const n = m.n;
  const lifted = liftRows(m, space);
  const hx = new Float64Array(n);
  const hy = new Float64Array(n);
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, y] = chart.home(m.x[i], m.y[i]);
    hx[i] = x;
    hy[i] = y;
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  const gx0 = Number.isFinite(minx) ? Math.floor(minx / cell) : 0;
  const gy0 = Number.isFinite(miny) ? Math.floor(miny / cell) : 0;
  const cols = Number.isFinite(maxx) ? Math.floor(maxx / cell) - gx0 + 1 : 1;
  const rows = Number.isFinite(maxy) ? Math.floor(maxy / cell) - gy0 + 1 : 1;
  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const k = (Math.floor(hy[i] / cell) - gy0) * cols + (Math.floor(hx[i] / cell) - gx0);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  }
  // The column spans one query visits: its own, and on the sphere the same
  // span a turn either way when that lands on the grid.
  const spans: number[] = [];
  const addSpan = (x0: number, x1: number) => {
    const c0 = Math.max(0, Math.floor(x0 / cell) - gx0);
    const c1 = Math.min(cols - 1, Math.floor(x1 / cell) - gx0);
    if (c0 <= c1) spans.push(c0, c1);
  };
  const near = (p: XY, np: Model, far: number, dists: number[] | null): number[] => {
    const px = vx(p);
    const py = vy(p);
    const self = ownerOf(p as Vertex) === m ? (p as Vertex).index : -1;
    const out: number[] = [];
    if (dists) dists.length = 0;
    if (stats) stats.queries++;
    const [qx, qy] = chart.home(px, py);
    const r0 = Math.max(0, Math.floor((qy - far) / cell) - gy0);
    const r1 = Math.min(rows - 1, Math.floor((qy + far) / cell) - gy0);
    spans.length = 0;
    const w = chart.reach(qy, far);
    // Two cells of room keep a span and its turn from sharing a cell.
    if (!(2 * w + 2 * cell < chart.period)) addSpan(-Infinity, Infinity);
    else {
      addSpan(qx - w, qx + w);
      if (Number.isFinite(chart.period)) {
        addSpan(qx - w - chart.period, qx + w - chart.period);
        addSpan(qx - w + chart.period, qx + w + chart.period);
      }
    }
    for (let s = 0; s < spans.length; s += 2) {
      for (let c = spans[s]; c <= spans[s + 1]; c++) {
        for (let r = r0; r <= r1; r++) {
          const bucket = grid.get(r * cols + c);
          if (!bucket) continue;
          if (stats) stats.candidates += bucket.length;
          for (const j of bucket) {
            if (j === self) continue;
            const d = space.modelDistance(np, lifted[j]);
            if (d < far) {
              out.push(j);
              if (dists) dists.push(d);
            }
          }
        }
      }
    }
    if (stats) stats.hits += out.length;
    return out;
  };
  return { lifted, near };
}

/** Each row of `m` lifted to the space's model, once for the state. */
function liftRows(m: Material, space: Space): Model[] {
  const out = new Array<Model>(m.n);
  for (let i = 0; i < m.n; i++) out[i] = space.model.up([m.x[i], m.y[i]]);
  return out;
}

/** `space.log(p, q)` for a `p` lifted to `np` with its `frame`, and a row
 * lifted to `nq`: the lifted door, and `log` itself at the point opposite. */
function logRow(space: Space, p: XY, np: Model, frame: readonly [Model, Model], m: Material, j: number, nq: Model): Vec {
  return space.modelLog(np, frame, nq) ?? space.log(p, [m.x[j], m.y[j]]);
}

// ---- forces -----------------------------------------------------------------------

/**
 * A force said without its state: `force.tension({ rest })` rather than
 * `force.tension(g, { rest })`. It is a value that says how to prepare
 * itself from the graph a move runs on — `g.move(force.tension({ rest }))`
 * prepares it from `g`, once, and reads it at every point. `prepare(g)` is
 * the same kernel the state-first form returns.
 */
export class GraphForce {
  /** @internal Use the `force.*` words without a state. */
  constructor(private readonly make: (g: Material) => (p: Vertex) => XY) {
    Object.freeze(this);
  }

  /** The force prepared from `g`: `(p) => [dx, dy]`. */
  prepare(g: Material): (p: Vertex) => XY {
    if (!(g instanceof Material)) throw new Error('force.prepare: a force is prepared from a material');
    return this.make(g);
  }
}

/** How much of a force a move takes: a number, or one per point. */
export type Amount = number | ((p: Vertex) => number);

/** An `amount`, checked: absent is all of it. */
function amountOf(amount: unknown, who: string): Amount {
  if (amount === undefined) return 1;
  if (typeof amount !== 'number' && typeof amount !== 'function') throw new Error(`${who}: { amount } must be a number, or a function of the point — got ${String(amount)}`);
  return amount as Amount;
}

/** A prepared force times its amount; all of it is the force itself. */
function scaled(f: (p: Vertex) => Vec, amount: Amount): (p: Vertex) => Vec {
  if (amount === 1) return f;
  return typeof amount === 'number' ? (p) => mul(f(p), amount) : (p) => mul(f(p), amount(p));
}

/** True for a force said without its state. */
export const isGraphForce = (v: unknown): v is GraphForce => v instanceof GraphForce;

/** @internal An options record in the place a state-first force takes its
 * sources: a plain object that is no geometry and no shape. */
export const isOptionsOnly = (a: unknown, b: unknown): boolean =>
  b === undefined && typeof a === 'object' && a !== null && Object.getPrototypeOf(a) === Object.prototype
  && !('points' in a) && !('contours' in a) && !('pts' in a) && !('__occludeShape' in a) && !('__occludeGroup' in a);
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
 * an edge selection — is read through the protocol, and a face collection
 * reads as its centroids.
 */
export function sourcePoints(sources: Sources, who: string): PointsLike {
  if (sources instanceof Material) return sources;
  refuseShape(sources, who);
  // A face collection is points at its faces' centroids, for every point
  // consumer; `faces.points` stays the word for the corners.
  const centres = faceCentroids(sources);
  if (centres) return centres;
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
  const source = (sources as { owner?: unknown }).owner;
  if (source instanceof Material) return source.space;
  const first = Array.isArray(sources) ? sources[0] : undefined;
  const owner = typeof first === 'object' && first !== null ? ownerOf(first) : undefined;
  return owner instanceof Material ? owner.space : undefined;
}

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
 * `force.tension(m, { rest: (e) => e.rest })`. A rest that is not a
 * finite length is no rest at all, so that edge pulls from zero and a
 * degenerate column slackens the chain instead of tearing it.
 */
export function tension(opts: { rest: number | ((e: Edge) => number); amount?: Amount }): GraphForce;
export function tension(m: Material, opts: { rest: number | ((e: Edge) => number) }): (p: Vertex) => Vec;
export function tension(m: Material | { rest: number | ((e: Edge) => number); amount?: Amount }, opts?: { rest: number | ((e: Edge) => number) }): GraphForce | ((p: Vertex) => Vec) {
  if (!(m instanceof Material) && opts === undefined) {
    const said = m as { rest: number | ((e: Edge) => number); amount?: Amount } | undefined;
    const rest = said?.rest;
    if (typeof rest !== 'number' && typeof rest !== 'function') throw new Error(`force.tension: { rest } must be a length, or a function of the edge — got ${String(rest)}`);
    const amount = amountOf(said?.amount, 'force.tension');
    return new GraphForce((g) => scaled(tensionOf(g, rest, true), amount));
  }
  return tensionOf(m as Material, opts!.rest, false);
}

/** `tension` prepared for `m`: the sum of the pulls, or for a force said
 * without its state (`stepped`) half their mean over the neighbours that
 * pull (see `step`): a lone stretched edge is at its rest length after one
 * move, and a point pulled many ways moves no further than one pull. */
function tensionOf(m: Material, rest: number | ((e: Edge) => number), stepped: boolean): (p: Vertex) => Vec {
  // Each pull counted as it is added, for the stepped mean.
  let c = 0;
  const counted = (v: Vec, gap: number): Vec => {
    if (gap > 0) c++;
    return v;
  };
  const done = (v: Vec): Vec => (stepped ? step(v[0], v[1], c, true) : v);
  const space = curved(m.space);
  if (space) {
    // In a space the pull is along the geodesic to each neighbour, by the
    // part of the space's distance beyond the rest length.
    const restOf = typeof rest === 'number' ? () => rest : typeof rest === 'function' ? (e: number) => valueAt(rest(m.edge(e)), 0) : null;
    if (!restOf) throw new Error(`force.tension: { rest } must be a length, or a function of the edge — got ${String(rest)}`);
    const lifted = liftRows(m, space);
    return (p) => {
      const edgeRows = m.incidentEdgeRows(p.index);
      const np = space.model.up(p);
      const frame = space.model.frameAt(p);
      c = 0;
      return done(sumBy(m.adjacentRows(p.index), (j, k) => {
        const d = space.modelDistance(np, lifted[j]);
        const gap = Math.max(0, d - restOf(edgeRows[k]));
        return counted(mul(unit(logRow(space, p, np, frame, m, j, lifted[j])), gap), gap);
      }));
    };
  }
  // A neighbour is read as its position: no row view is made for it.
  const X = m.x;
  const Y = m.y;
  if (typeof rest === 'number') {
    return (p) => {
      c = 0;
      return done(sumBy(m.adjacentRows(p.index), (j) => {
        const delta = sub([X[j], Y[j]], p);
        const gap = Math.max(0, length(delta) - rest);
        return counted(mul(unit(delta), gap), gap);
      }));
    };
  }
  if (typeof rest !== 'function') throw new Error(`force.tension: { rest } must be a length, or a function of the edge — got ${String(rest)}`);
  // `adjacentRows` and `incidentEdgeRows` are built by one pass over the
  // edge list and pushed to in step, so the k-th neighbour is the far end
  // of the k-th edge.
  return (p) => {
    const edgeRows = m.incidentEdgeRows(p.index);
    c = 0;
    return done(sumBy(m.adjacentRows(p.index), (j, k) => {
      const delta = sub([X[j], Y[j]], p);
      const r = valueAt(rest(m.edge(edgeRows[k])), 0);
      const gap = Math.max(0, length(delta) - r);
      return counted(mul(unit(delta), gap), gap);
    }));
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
 * `amount` — a number, or a function of the point — scales the push, and a
 * negative amount pulls: `force.separation(anchors, { radius, amount: -1 /
 * radius })` draws each point toward the anchors within `radius`, 1 when
 * touching and fading to zero at the radius. An attraction is a separation
 * turned round.
 *
 * `radius` may instead be a function of the VERTEX, and then each point
 * carries its own — `(p) => p.attrs.r` is discs of different sizes. The
 * radius of a PAIR is the sum of the two, which is what "these two must
 * not overlap" means for two discs, and the push peaks at that sum and
 * fades to zero there. One grid still answers: it is built at the largest
 * radius among the sources, and a query walks as many rings as its own
 * reach needs.
 */
export function separation(opts: SeparationOpts): GraphForce;
export function separation(sources: Sources, opts: SeparationOpts): (p: Vertex) => Vec;
export function separation(sources: Sources | SeparationOpts, opts?: SeparationOpts): GraphForce | ((p: Vertex) => Vec) {
  if (isOptionsOnly(sources, opts)) return separationOf(sources as SeparationOpts, undefined);
  return separationFrom(sources as Sources, opts!, undefined);
}

/** `separation`'s options. */
export interface SeparationOpts {
  radius: number | ((p: Vertex) => number);
  excludeConnected?: boolean;
  /** Scales the push, a number or a function of the point; negative pulls. */
  amount?: Amount;
}

/**
 * @internal The state-free separation: the graph pushes on itself, and
 * `amount` — a number, or a function of the point — scales the push, so a
 * force can be strong in one part of a drawing and nothing in another.
 */
export function separationOf(said: SeparationOpts, space: Space | undefined): GraphForce {
  const { amount, ...opts } = said;
  const much = amountOf(amount, 'force.separation');
  return new GraphForce((g) => scaled(separationIn(g, opts, space, true), much));
}

/** @internal `separation` from these sources, scaled by its `amount`, in
 * `space` when the sources carry none of their own. */
export function separationFrom(sources: Sources, said: SeparationOpts, space: Space | undefined): (p: Vertex) => Vec {
  const { amount, ...opts } = said;
  const much = amountOf(amount, 'force.separation');
  return scaled(separationIn(sources, opts, space), much);
}

/** @internal `separation` measuring in `space` when the sources carry none
 * of their own: the toolkit's `t.force.separation` hands the sketch's. */
export function separationIn(sources: Sources, opts: { radius: number | ((p: Vertex) => number); excludeConnected?: boolean }, space0: Space | undefined, stepped = false): (p: Vertex) => Vec {
  const { radius, excludeConnected = false } = opts;
  const m = material(sourcePoints(sources, 'force.separation'));
  const space = curved(spaceOfSources(sources) ?? space0);
  if (typeof radius === 'number') return radial(m, radius, excludeConnected, space, stepped);
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
  const cell = widest > 0 ? widest : 1;
  if (space) {
    const index = neighboursIn(m, cell, undefined, space);
    const dists: number[] = [];
    return (p) => {
      const rp = Math.max(0, valueAt(radius(p), 0));
      const row = ownerOf(p) === m ? p.index : -1;
      const adj = excludeConnected && row >= 0 ? m.adjacentRows(row) : null;
      const np = space.model.up(p);
      let frame: readonly [Model, Model] | null = null;
      let x = 0;
      let y = 0;
      let c = 0;
      const rows = index.near(p, np, rp + widest, dists);
      for (let k = 0; k < rows.length; k++) {
        const j = rows[k];
        if (adj && adj.includes(j)) continue;
        const r = rp + own[j];
        if (!(r > 0)) continue;
        // Away from the neighbour along the geodesic: `log` toward it,
        // turned round, in p's own frame.
        const d = dists[k];
        if (d <= 0 || d >= r) continue;
        frame ??= space.model.frameAt(p);
        const l = logRow(space, p, np, frame, m, j, index.lifted[j]);
        const ll = Math.hypot(l[0], l[1]);
        if (!(ll > 0)) continue;
        const s = (1 - d / r) * r;
        x -= (l[0] / ll) * s;
        y -= (l[1] / ll) * s;
        c++;
      }
      return step(x, y, c, stepped);
    };
  }
  const near = neighbours(m, { radius: cell });
  const X = m.x;
  const Y = m.y;
  return (p) => {
    const rp = Math.max(0, valueAt(radius(p), 0));
    const row = ownerOf(p) === m ? p.index : -1;
    const adj = excludeConnected && row >= 0 ? m.adjacentRows(row) : null;
    let x = 0;
    let y = 0;
    let c = 0;
    // Everything that could touch p is within p's radius plus the widest
    // one in the material; the pair's own sum then decides.
    for (const j of near(p, rp + widest)) {
      if (adj && adj.includes(j)) continue;
      const r = rp + own[j];
      if (!(r > 0)) continue;
      const dx = p.x - X[j];
      const dy = p.y - Y[j];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 0 || d >= r) continue;
      const s = (1 - d / r) * r;
      x += (dx / d) * s;
      y += (dy / d) * s;
      c++;
    }
    return step(x, y, c, stepped);
  };
}

/**
 * The step a pair force gives a move, from the sum of `c` pulls or pushes.
 *
 * A force a sketch prepared itself (`force.separation(g, …)`,
 * `force.tension(g, …)`) is the sum, and the sketch scales it. A force said
 * without its state (`force.separation({ … })` handed to `move`) steps by
 * half the MEAN of the pulls that act on the point. The sum grows with how
 * many partners are in reach, so a step that is right for a sparse cloud
 * flings a dense one, and every sketch had to find its own small `amount`.
 * The mean is bounded by the force's own scale — a separation's push by its
 * radius, a tension's pull by the stretch of one edge — wherever the points
 * are, and half of it is the step that brings a lone pair exactly to its
 * radius or its rest length when both ends move: the largest step that does
 * not overshoot. `amount` then scales a calm move, and 1 needs no tuning.
 */
function step(x: number, y: number, c: number, stepped: boolean): Vec {
  return stepped && c > 0 ? [x / (2 * c), y / (2 * c)] : [x, y];
}

/** The fixed-law radial separation on the raw
 * columns: the same neighbours in the same order and the same arithmetic
 * as the generic `nearby` form — so the doubles, and the drawing, are
 * identical — without a vertex view and two tuples per neighbour. Measured
 * 20× on a 5 000-point ring (see the reference). It pushes away from
 * the source, `radius` when touching, fading linearly to zero at the
 * radius. */
function radial(m: Material, radius: number, excludeConnected: boolean, space: Space | null, stepped = false): (p: Vertex) => Vec {
  if (space) return radialIn(m, radius, excludeConnected, space, stepped);
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
    let c = 0;
    for (const j of near(p)) {
      if (adj && adj.includes(j)) continue;
      // sub(p, q) → unit → mul, spelled out in the same operations
      const dx = px - mx[j];
      const dy = py - my[j];
      const d = Math.sqrt(dx * dx + dy * dy); // `length` spells it so; hypot can differ in the last bit
      if (d > 0) {
        const s = (1 - d / radius) * radius;
        x += (dx / d) * s;
        y += (dy / d) * s;
        c++;
      }
    }
    return step(x, y, c, stepped);
  };
}

/** `radial` in a curved space: the neighbours within `radius` OF THE
 * SPACE, each pushing or pulling along the geodesic between the two —
 * direction from `log`, magnitude from the space's distance, the same
 * linear law. */
function radialIn(m: Material, radius: number, excludeConnected: boolean, space: Space, stepped: boolean): (p: Vertex) => Vec {
  const index = neighboursIn(m, radius, undefined, space);
  const dists: number[] = [];
  return (p) => {
    const own = ownerOf(p) === m ? p.index : -1;
    const adj = excludeConnected && own >= 0 ? m.adjacentRows(own) : null;
    const np = space.model.up(p);
    let frame: readonly [Model, Model] | null = null;
    let x = 0;
    let y = 0;
    let c = 0;
    const rows = index.near(p, np, radius, dists);
    for (let k = 0; k < rows.length; k++) {
      const j = rows[k];
      if (adj && adj.includes(j)) continue;
      const d = dists[k];
      frame ??= space.model.frameAt(p);
      const l = logRow(space, p, np, frame, m, j, index.lifted[j]);
      const ll = Math.hypot(l[0], l[1]);
      if (d > 0 && ll > 0) {
        const s = (1 - d / radius) * radius;
        x -= (l[0] / ll) * s;
        y -= (l[1] / ll) * s;
        c++;
      }
    }
    return step(x, y, c, stepped);
  };
}

/**
 * Drift: a direction read from a noise function, `amount` long, turning
 * slowly from one step of a run to the next. Pure — pass the toolkit's
 * seeded `t.noise` in: `g.move(force.drift(t.noise, { amount }))`.
 * `frequency` scales position into the noise (default 0.08), `rate` the
 * step into its third axis (default 0.0004): angle = noise(x·f, y·f,
 * step·rate) · 2π. The step is the one `t.steps` is making: the toolkit's
 * noise knows its run, so a drift turns from step to step whatever the
 * pass keeps its values in (a material, a plain object holding several)
 * and however the force is wrapped (`mul(push(p), 0.2)`). Outside a run
 * of steps it is the step the point's own material reached, and at a
 * plain position step 0. The default rate is small because the toolkit's
 * noise folds z onto shifted 2D slices about thirty times steeper than x
 * and y: at 0.01 per step the direction re-rolls every step and a trail
 * is a random walk; at 0.0004 it turns.
 */
export function drift(
  noise: (x: number, y: number, z: number) => number,
  opts: { amount: number; frequency?: number; rate?: number },
): (p: XY) => Vec {
  const { amount, frequency = 0.08, rate = 0.0004 } = opts;
  const run = runOf(noise);
  return (p) => {
    const owner = typeof p === 'object' && p !== null && !Array.isArray(p) ? ownerOf(p) : undefined;
    const k = run?.step ?? (owner instanceof Material ? owner.iteration : 0);
    const a = noise(vx(p) * frequency, vy(p) * frequency, k * rate) * Math.PI * 2;
    return [Math.cos(a) * amount, Math.sin(a) * amount];
  };
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
  refuseShape(loops, 'force.boundary', 't.force.boundary');
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
  const inside = distanceField(numericLoops(loops, 'force.boundary'));
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

/** @internal `vortex` in the space the centre carries — a vertex of a
 * curved material — else in `space`: a bare point carries none, and the
 * toolkit's `t.force.vortex` hands the sketch's. */
export function vortexIn(centre: XY, opts: { strength: number; falloff?: number }, space: Space | undefined): (p: XY) => Vec {
  const { strength, falloff = 10 } = opts;
  const sp = curved(carriedSpace(centre) ?? space);
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
export function relax(opts?: { amount?: number }): GraphForce;
export function relax(m: Material, opts?: { amount?: number }): (p: Vertex) => Vec;
export function relax(m?: Material | { amount?: number }, opts: { amount?: number } = {}): GraphForce | ((p: Vertex) => Vec) {
  if (!(m instanceof Material)) {
    const said = m ?? {};
    return new GraphForce((g) => relax(g, said));
  }
  const { amount = 1 } = opts;
  const space = curved(m.space);
  if (space) {
    // The mean of the directions to the neighbours, each `log(p, q)` in
    // p's own frame: the vector to the neighbours' centre of mass.
    const lifted = liftRows(m, space);
    return (p) => {
      const nb = m.adjacentRows(p.index);
      if (nb.length < 2) return [0, 0];
      const np = space.model.up(p);
      const frame = space.model.frameAt(p);
      let mx = 0;
      let my = 0;
      for (const j of nb) {
        const l = logRow(space, p, np, frame, m, j, lifted[j]);
        mx += l[0];
        my += l[1];
      }
      return mul([mx / nb.length, my / nb.length], amount);
    };
  }
  const X = m.x;
  const Y = m.y;
  return (p) => {
    const nb = m.adjacentRows(p.index);
    if (nb.length < 2) return [0, 0];
    let mx = 0;
    let my = 0;
    for (const j of nb) {
      mx += X[j];
      my += Y[j];
    }
    return mul(sub([mx / nb.length, my / nb.length], p), amount);
  };
}

/** Prepared forces summed into one: `(p) => vector`, for one `move`:
 * `g.move(force.sum(force.tension(g, { rest }), force.drift(t.noise, { amount })))`.
 * Prepare the members against the graph the move reads — nothing here
 * binds a state. */
function sumForces(...forces: readonly ((p: Vertex) => XY)[]): (p: Vertex) => Vec {
  return (p) => {
    let x = 0;
    let y = 0;
    for (const f of forces) {
      const v = f(p);
      x += vx(v);
      y += vy(v);
    }
    return [x, y];
  };
}

export const force = {
  sum: sumForces, tension, separation, drift, boundary, vortex, field, relax };

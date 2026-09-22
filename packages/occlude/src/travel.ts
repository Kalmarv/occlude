/**
 * Travel time: how long the front takes to reach a point, as `distanceTo`
 * says how far the point is in a straight line.
 *
 * `distanceTo` is exact and obstacle-blind: it measures through a wall as
 * happily as around it. This measures the walk. The front leaves the seeds
 * at time zero, moves at the local speed, and never passes a wall, so its
 * level sets bend through a doorway, crowd where the ground is slow, and
 * stop dead behind a barrier. With speed 1 and nothing in the way the two
 * agree: arrival time IS unsigned distance.
 *
 * The solution is the viscosity solution of the Eikonal equation
 * `|∇T| = 1/F`, computed by fast marching — one sweep in order of arrival,
 * with a heap for "which node arrives next" and the first-order upwind
 * Godunov update at each node. See J. A. Sethian, "A fast marching level set
 * method for monotonically advancing fronts", PNAS 93(4):1591–1595, 1996.
 * Written from the scheme, not from anyone's source.
 *
 * The result is a plain `FieldFn` — bilinear over the grid it marched — so
 * everything that eats a field composes with it: `t.isolines(T, …)` for
 * arrival rings, `grad` for the direction to walk, scatter densities,
 * decimate parameters. Unreachable ground is `+Infinity`, which every field
 * consumer already reads as absent: contours truncate there rather than
 * throwing.
 *
 * Pure and deterministic: a function of the seeds, the speed and the
 * domain alone — no seed stream, no paper. The grid is an implementation
 * number; arrival times are in the units of the input coordinates divided
 * by the units of `speed`.
 */

import { numericLoops, type AreaInput } from './boundary.js';
import { distanceTo } from './distance.js';
import { usableLength } from './guard.js';
import type { IsoEnv } from './isolines.js';
import type { PointSelection } from './relation.js';
import type { FieldFn } from './shapes.js';
import { mm, type L } from './units.js';

/** Where the front starts, at time zero: an area (its whole interior and
 * boundary) or a set of points. The point atom decides an array —
 * `[{ x, y }, …]` is a set of separate seeds, `[[x, y], …]` is one loop. */
export type TravelFrom = AreaInput | PointSelection;

export interface TravelOpts {
  /** Distance covered per unit time, as a number or a field (default 1).
   * A speed that is zero, negative or not finite is a WALL: the front never
   * enters it. `speed: img.field('lum')` makes the dark parts slow. */
  speed?: number | FieldFn;
  /** The ground the front may cross (default: the whole drawable).
   * Everything outside it is wall. */
  within?: AreaInput;
  /** Grid cell in user units (default: max of mm(1) and long-side/256).
   * A first-order scheme, so the error falls with the cell. */
  spacing?: L;
}

/** Unreachable everywhere: the honest answer for a domain with no ground,
 * no seeds, or no speed. Every field consumer reads it as absent. */
const NOWHERE: FieldFn = () => Infinity;

const TRIAL = 1;
const KNOWN = 2;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A point as a THING: `{ x, y }` with resolved coordinates. */
const isPointRecord = (v: unknown): v is { x: number; y: number } =>
  isObj(v) && typeof v.x === 'number' && typeof v.y === 'number';

/**
 * The seeds as loops and loose points.
 *
 * The point-atom law decides an array: `{ x, y }` records are
 * points-as-things, so an array of them is a set of SEPARATE seeds, each
 * its own source. `[x, y]` pairs are anonymous vertices inside a loop, so
 * an array of those is an AREA, exactly as every other area consumer reads
 * it. The first entry decides the whole array, as it does in `areaLoops`.
 *
 * Everything else is the area consumer's own reading: a material's closed
 * chains, a face's contours, contour records, loops of points. A loop of
 * one point is not an area, so it joins the loose points. A value that
 * carries `points` and has no loop at all (a scattered material, a point
 * selection) is read as its points.
 */
function seedsOf(from: TravelFrom, who: string): {
  loops: [number, number][][];
  points: [number, number][];
} {
  if (from === null || from === undefined || typeof from !== 'object') {
    throw new Error(`${who}: expected an area or points, got ${from === null ? 'null' : typeof from}`);
  }
  if (Array.isArray(from) && isPointRecord(from[0])) {
    const seeds: [number, number][] = [];
    for (let i = 0; i < from.length; i++) {
      const p: unknown = from[i];
      if (!isPointRecord(p)) {
        throw new Error(
          `${who}: entry ${i} is not a point. An array of { x, y } records is a set of seeds, ` +
            'and an array of [x, y] pairs is one loop. One spelling per array.',
        );
      }
      seeds.push([p.x, p.y]);
    }
    return { loops: [], points: seeds };
  }
  const looseFrom = (v: unknown): [number, number][] | null => {
    if (!isObj(v) && !Array.isArray(v)) return null;
    const holder = isObj(v) && 'points' in v ? (v as { points: unknown }).points : v;
    if (holder === undefined || holder === null) return null;
    if (typeof (holder as Iterable<unknown>)[Symbol.iterator] !== 'function') return null;
    const out: [number, number][] = [];
    for (const p of holder as Iterable<unknown>) {
      if (!isObj(p)) return null;
      const { x, y } = p as { x: unknown; y: unknown };
      if (typeof x !== 'number' || typeof y !== 'number') return null;
      out.push([x, y]);
    }
    return out;
  };

  let loops: [number, number][][] = [];
  let refusal: unknown;
  try {
    loops = numericLoops(from as AreaInput, who);
  } catch (err) {
    refusal = err;
  }
  const areaLoops = loops.filter((l) => l.length >= 2);
  const points: [number, number][] = loops.filter((l) => l.length === 1).map((l) => l[0]);
  if (areaLoops.length === 0 && points.length === 0) {
    const loose = looseFrom(from);
    if (loose !== null) return { loops: [], points: loose };
  }
  if (refusal !== undefined) throw refusal;
  return { loops: areaLoops, points };
}

/** Distance to the seeds: zero inside a seed area, and the straight-line
 * distance to the nearest seed anywhere else. Only the first cell or so of
 * it is used — to start the march with sub-cell accuracy instead of a
 * staircase — so it never measures through a wall in anger. */
function seedDistance(
  loops: [number, number][][],
  points: [number, number][],
): ((x: number, y: number) => number) | null {
  if (loops.length === 0 && points.length === 0) return null;
  const area = loops.length > 0 ? distanceTo(loops) : null;
  const px = Float64Array.from(points.map((p) => p[0]));
  const py = Float64Array.from(points.map((p) => p[1]));
  return (x, y) => {
    let best = Infinity;
    if (area !== null) {
      const d = area(x, y);
      // Positive inside the seed area: already arrived.
      if (Number.isFinite(d)) best = Math.max(0, -d);
    }
    for (let k = 0; k < px.length; k++) {
      const d = Math.hypot(x - px[k], y - py[k]);
      if (d < best) best = d;
    }
    return best;
  };
}

/**
 * Arrival times over `env.bounds` as a field. See the file comment; the
 * artist-facing word is `t.travelTime`, which lowers a shape first.
 */
export function travelTimeOf(env: IsoEnv, from: TravelFrom, opts: TravelOpts = {}): FieldFn {
  const b = env.bounds;
  // A domain with no area, or a cell that is not a positive length, has
  // nothing to march over — best-effort: nothing arrives anywhere.
  if (!(b.w > 0) || !(b.h > 0)) return NOWHERE;
  if (!usableLength(opts.spacing)) return NOWHERE;
  const step = opts.spacing !== undefined
    ? env.len(opts.spacing)
    : Math.max(env.len(mm(1)), Math.max(b.w, b.h) / 256);
  const gw = Math.max(2, Math.ceil(b.w / step) + 1);
  const gh = Math.max(2, Math.ceil(b.h / step) + 1);
  const n = gw * gh;
  if (!Number.isFinite(n)) return NOWHERE;
  if (n > 16_777_216) {
    throw new Error(
      `travelTime: ${Math.floor(n)} grid nodes (spacing too fine) — capped at 16.7M (~128MB of times)`,
    );
  }
  const sx = b.w / (gw - 1);
  const sy = b.h / (gh - 1);

  const given = opts.speed ?? 1;
  if (typeof given !== 'number' && typeof given !== 'function') {
    throw new Error(`travelTime: { speed } must be a number or a field of (x, y), got ${typeof given}`);
  }
  const speedAt: FieldFn = typeof given === 'function' ? given : () => given;
  const ground = opts.within === undefined ? null : distanceTo(opts.within);
  const start = seedsOf(from, 'travelTime');
  const seed = seedDistance(start.loops, start.points);

  // ---- the grid -------------------------------------------------------
  const T = new Float64Array(n).fill(Infinity);
  const state = new Uint8Array(n);
  const F = new Float64Array(n);
  for (let j = 0; j < gh; j++) {
    const y = b.y + j * sy;
    for (let i = 0; i < gw; i++) {
      const x = b.x + i * sx;
      // Outside the ground is wall, and so is any speed that is not a
      // positive finite number.
      if (ground !== null && !(ground(x, y) >= 0)) continue;
      const s = speedAt(x, y);
      if (typeof s === 'number' && Number.isFinite(s) && s > 0) F[j * gw + i] = s;
    }
  }

  // ---- the heap -------------------------------------------------------
  // Lazy: a node is pushed again when its estimate drops, and a stale entry
  // is skipped on the way out. Fewer moving parts than decrease-key, same
  // answer, and the pops still come out in time order.
  let cap = 1024;
  let hT = new Float64Array(cap);
  let hI = new Int32Array(cap);
  let hn = 0;
  const push = (t: number, idx: number): void => {
    if (hn === cap) {
      cap *= 2;
      const nt = new Float64Array(cap); nt.set(hT); hT = nt;
      const ni = new Int32Array(cap); ni.set(hI); hI = ni;
    }
    let k = hn++;
    hT[k] = t; hI[k] = idx;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (hT[p] <= hT[k]) break;
      const tt = hT[p]; hT[p] = hT[k]; hT[k] = tt;
      const ti = hI[p]; hI[p] = hI[k]; hI[k] = ti;
      k = p;
    }
  };
  const pop = (): number => {
    const top = hI[0];
    hn--;
    hT[0] = hT[hn]; hI[0] = hI[hn];
    let k = 0;
    for (;;) {
      const l = 2 * k + 1;
      const r = l + 1;
      let m = k;
      if (l < hn && hT[l] < hT[m]) m = l;
      if (r < hn && hT[r] < hT[m]) m = r;
      if (m === k) break;
      const tt = hT[m]; hT[m] = hT[k]; hT[k] = tt;
      const ti = hI[m]; hI[m] = hI[k]; hI[k] = ti;
      k = m;
    }
    return top;
  };

  // ---- seeding --------------------------------------------------------
  // Nodes within one cell of the seeds start KNOWN at their exact time, so
  // a point source does not begin life as a square. Everything further out
  // is marched.
  const near = Math.hypot(sx, sy);
  let seeded = 0;
  if (seed !== null) {
    for (let j = 0; j < gh; j++) {
      const y = b.y + j * sy;
      for (let i = 0; i < gw; i++) {
        const idx = j * gw + i;
        if (F[idx] <= 0) continue;
        const d = seed(b.x + i * sx, y);
        if (!(d <= near)) continue;
        T[idx] = d / F[idx];
        state[idx] = KNOWN;
        seeded++;
      }
    }
  }
  if (seeded === 0) return NOWHERE;

  // ---- the march ------------------------------------------------------
  const ax = 1 / (sx * sx);
  const ay = 1 / (sy * sy);
  const solve = (idx: number, i: number, j: number): number => {
    const f = F[idx];
    let a = Infinity;
    if (i > 0 && state[idx - 1] === KNOWN) a = T[idx - 1];
    if (i < gw - 1 && state[idx + 1] === KNOWN && T[idx + 1] < a) a = T[idx + 1];
    let c = Infinity;
    if (j > 0 && state[idx - gw] === KNOWN) c = T[idx - gw];
    if (j < gh - 1 && state[idx + gw] === KNOWN && T[idx + gw] < c) c = T[idx + gw];
    const rhs = 1 / (f * f);
    if (a === Infinity) return c + sy / f;
    if (c === Infinity) return a + sx / f;
    // (T−a)²/sx² + (T−c)²/sy² = 1/F², taking the larger root. It is the
    // right one only while the front arrives from both axes; otherwise the
    // update is one-sided.
    const s = ax + ay;
    const m = ax * a + ay * c;
    const disc = m * m - s * (ax * a * a + ay * c * c - rhs);
    if (disc >= 0) {
      const t = (m + Math.sqrt(disc)) / s;
      if (t >= a && t >= c) return t;
    }
    return Math.min(a + sx / f, c + sy / f);
  };
  const relax = (idx: number, i: number, j: number): void => {
    if (state[idx] === KNOWN || F[idx] <= 0) return;
    const t = solve(idx, i, j);
    if (t < T[idx]) {
      T[idx] = t;
      state[idx] = TRIAL;
      push(t, idx);
    }
  };
  // Every node beside a seed is a candidate to start with.
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const idx = j * gw + i;
      if (state[idx] !== KNOWN) continue;
      if (i > 0) relax(idx - 1, i - 1, j);
      if (i < gw - 1) relax(idx + 1, i + 1, j);
      if (j > 0) relax(idx - gw, i, j - 1);
      if (j < gh - 1) relax(idx + gw, i, j + 1);
    }
  }
  while (hn > 0) {
    const idx = pop();
    if (state[idx] === KNOWN) continue; // a stale entry
    state[idx] = KNOWN;
    const i = idx % gw;
    const j = (idx - i) / gw;
    if (i > 0) relax(idx - 1, i - 1, j);
    if (i < gw - 1) relax(idx + 1, i + 1, j);
    if (j > 0) relax(idx - gw, i, j - 1);
    if (j < gh - 1) relax(idx + gw, i, j + 1);
  }
  // A node the march never reached keeps Infinity — nothing to clear.

  // ---- the field ------------------------------------------------------
  return (x: number, y: number): number => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
    const u = (x - b.x) / sx;
    const v = (y - b.y) / sy;
    if (u < -1e-9 || v < -1e-9 || u > gw - 1 + 1e-9 || v > gh - 1 + 1e-9) return Infinity;
    const i0 = Math.min(gw - 2, Math.max(0, Math.floor(u)));
    const j0 = Math.min(gh - 2, Math.max(0, Math.floor(v)));
    const fx = Math.min(1, Math.max(0, u - i0));
    const fy = Math.min(1, Math.max(0, v - j0));
    const row = j0 * gw + i0;
    const t00 = T[row];
    const t10 = T[row + 1];
    const t01 = T[row + gw];
    const t11 = T[row + gw + 1];
    // A cell with an unreachable corner is on the far side of a wall: say
    // so rather than interpolating an average of a number and infinity.
    if (!Number.isFinite(t00) || !Number.isFinite(t10) || !Number.isFinite(t01) || !Number.isFinite(t11)) {
      return Infinity;
    }
    const top = t00 + (t10 - t00) * fx;
    const bot = t01 + (t11 - t01) * fx;
    return top + (bot - top) * fy;
  };
}

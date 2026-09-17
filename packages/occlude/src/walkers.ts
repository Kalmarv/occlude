/**
 * walkers: a population that draws, and stops when it meets what it drew.
 *
 * Hyphae, fractures, substrate and line-tracing are not four algorithms. They
 * are one machine — seeds, a step length, a rule for where to turn next, a
 * rule for when to branch, and an index of everything already laid down so a
 * walker knows when it has run into something. Give the machine those, and
 * every one of those named systems is a `steer` function a sketch writes in
 * ten lines. That is the whole reason this exists rather than a `hyphae()`.
 *
 * `steer` is handed the walker and returns the heading it should take next, in
 * radians, or `null` to stop it. `spawn` is handed the same walker and returns
 * a child, some children, or nothing. Neither is called with anything the
 * walker does not know about itself, so a steer is a pure function of the
 * walker plus whatever the sketch closes over — a field, an image, another
 * material's query index.
 *
 * `avoid` is the rule that makes the drawings interesting: a walker stops when
 * its next step would land within that distance of ink already laid, its own
 * included. Its own recent tail is exempt, because every walker is always
 * within a step of where it just was; the exemption is the length of tail that
 * `avoid` itself would otherwise veto.
 *
 * `steps` is required rather than defaulted. It is the honest question — how
 * long does this grow for — and a population that spawns has no natural end.
 *
 * Every path comes back as a chain of a single Material, carrying the seed's
 * own columns plus `age`, the number of steps that point was reached in, so a
 * sketch can taper, colour or thicken by it. Determinism is by construction:
 * walkers are advanced in the order they were created, and children join at
 * the end of the queue.
 */

import { Material, material as makeMaterial } from './material.js';
import type { Bounds } from './points.js';

/** A walker as `steer` and `spawn` see it. Plain data, not a live handle. */
export interface Walker {
  readonly x: number;
  readonly y: number;
  /** Where it is pointing now, in radians. */
  readonly heading: number;
  /** Steps taken so far; 0 on the first call. */
  readonly age: number;
  /** Which walker this is, in creation order. */
  readonly index: number;
  /** 0 for a seed, one more than its parent for a child. */
  readonly generation: number;
  /** The seed's own columns, carried along. */
  readonly attrs: Readonly<Record<string, number>>;
}

export interface WalkerSeed {
  x: number;
  y: number;
  heading?: number;
  [column: string]: number | undefined;
}

export interface WalkersOpts {
  /** How many steps a walker may take. Required: a population that spawns has
   * no natural end, and the honest question is how long it grows for. */
  steps: number;
  /** One step, in the drawable's units. */
  step: number;
  /** Where to turn next, in radians, or null to stop this walker. Without one
   * a walker holds its heading. */
  steer?: (w: Walker) => number | null;
  /** A child, some children, or nothing. Children start on the next step. */
  spawn?: (w: Walker) => WalkerSeed | WalkerSeed[] | null | undefined;
  /** Stop when the next step would land this close to ink already laid. */
  avoid?: number;
  /** How much of its own recent path a walker does not see, as a length along
   * that path (default `3 × avoid`). A walker that curves at all is within
   * `avoid` of its own tail by construction, so without this it vetoes itself
   * and the whole population dies at once; `steer` is arbitrary, so the machine
   * cannot work out how much tail is "recent" and has to be told. Raise it if
   * tight turns are killing walkers, lower it if they run over themselves. It
   * is also a newborn's grace, because a child is born ON its parent. */
  memory?: number;
  /** The rectangle a walker must stay inside (default: the drawable). */
  bounds?: Bounds;
}

interface Live {
  x: number;
  y: number;
  heading: number;
  age: number;
  index: number;
  generation: number;
  attrs: Record<string, number>;
  path: number[];
  alive: boolean;
}

export function walkers(seeds: readonly WalkerSeed[], bounds: Bounds, opts: WalkersOpts): Material {
  const { steps, step } = opts;
  if (!Number.isInteger(steps) || steps < 0) throw new Error(`walkers: { steps } must be a non-negative whole number of steps (got ${String(steps)})`);
  if (!(step > 0)) throw new Error(`walkers: { step } must be a positive length in the drawable's units (got ${String(step)})`);
  const avoid = opts.avoid;
  if (avoid !== undefined && !(avoid >= 0)) throw new Error(`walkers: { avoid } must be a non-negative distance (got ${String(avoid)})`);
  for (const name of ['steer', 'spawn'] as const) {
    if (opts[name] !== undefined && typeof opts[name] !== 'function') throw new Error(`walkers: { ${name} } must be a function of the walker`);
  }
  const box = opts.bounds ?? bounds;

  // The index of everything laid down, as segments in a uniform grid. The cell
  // is the avoid distance, so a query only ever looks at nine cells.
  const cell = Math.max(avoid ?? step, step, 1e-9);
  const laid = new Map<string, number[]>();
  const segs: number[] = []; // x0, y0, x1, y1, walker, tailIndex
  const key = (i: number, j: number) => `${i},${j}`;
  const addSeg = (x0: number, y0: number, x1: number, y1: number, who: number, at: number) => {
    const id = segs.length / 6;
    segs.push(x0, y0, x1, y1, who, at);
    const i0 = Math.floor(Math.min(x0, x1) / cell);
    const i1 = Math.floor(Math.max(x0, x1) / cell);
    const j0 = Math.floor(Math.min(y0, y1) / cell);
    const j1 = Math.floor(Math.max(y0, y1) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      const at2 = laid.get(k);
      if (at2) at2.push(id);
      else laid.set(k, [id]);
    }
  };
  /** Distance from a point to a segment. */
  const near = (px: number, py: number, s: number): number => {
    const ax = segs[s * 6];
    const ay = segs[s * 6 + 1];
    const bx = segs[s * 6 + 2];
    const by = segs[s * 6 + 3];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  // Measured as a LENGTH along the walker's own path, not a number of steps:
  // how far it curves in a step is up to `steer`, so steps are the wrong unit.
  const memory = opts.memory ?? (avoid === undefined ? 0 : avoid * 3);
  if (!(memory >= 0)) throw new Error(`walkers: { memory } must be a non-negative length along the path (got ${String(opts.memory)})`);
  const graceSteps = Math.ceil(memory / step);
  const blocked = (px: number, py: number, who: number, age: number): boolean => {
    if (avoid === undefined || age < graceSteps) return false;
    const i = Math.floor(px / cell);
    const j = Math.floor(py / cell);
    for (let a = i - 1; a <= i + 1; a++) {
      for (let b = j - 1; b <= j + 1; b++) {
        for (const s of laid.get(key(a, b)) ?? []) {
          if (segs[s * 6 + 4] === who && (age - segs[s * 6 + 5]) * step < memory) continue;
          if (near(px, py, s) < avoid) return true;
        }
      }
    }
    return false;
  };

  const names = new Set<string>();
  for (const s of seeds) for (const k of Object.keys(s)) if (k !== 'x' && k !== 'y' && k !== 'heading' && typeof s[k] === 'number') names.add(k);
  const born = (s: WalkerSeed, generation: number): Live => {
    const attrs: Record<string, number> = {};
    for (const k of names) attrs[k] = typeof s[k] === 'number' ? (s[k] as number) : NaN;
    return { x: s.x, y: s.y, heading: s.heading ?? 0, age: 0, index: live.length, generation, attrs, path: [s.x, s.y], alive: true };
  };
  const live: Live[] = [];
  for (const s of seeds) live.push(born(s, 0));

  const view = (w: Live): Walker => ({ x: w.x, y: w.y, heading: w.heading, age: w.age, index: w.index, generation: w.generation, attrs: w.attrs });
  for (let tick = 0; tick < steps; tick++) {
    const count = live.length; // children born this tick start on the next one
    for (let k = 0; k < count; k++) {
      const w = live[k];
      if (!w.alive) continue;
      const h = opts.steer ? opts.steer(view(w)) : w.heading;
      if (h === null || h === undefined || !Number.isFinite(h)) {
        w.alive = false;
        continue;
      }
      const nx = w.x + Math.cos(h) * step;
      const ny = w.y + Math.sin(h) * step;
      if (nx < box.x || ny < box.y || nx > box.x + box.w || ny > box.y + box.h || blocked(nx, ny, w.index, w.age)) {
        w.alive = false;
        continue;
      }
      addSeg(w.x, w.y, nx, ny, w.index, w.age);
      w.x = nx;
      w.y = ny;
      w.heading = h;
      w.age++;
      w.path.push(nx, ny);
      if (opts.spawn) {
        const kids = opts.spawn(view(w));
        const list: WalkerSeed[] = kids === null || kids === undefined ? [] : Array.isArray(kids) ? kids : [kids];
        for (const kid of list) if (kid) live.push(born(kid, w.generation + 1));
      }
    }
  }

  // One chain per walker that moved at all.
  const xs: number[] = [];
  const ys: number[] = [];
  const cols: Record<string, number[]> = Object.fromEntries([...names, 'age'].map((k) => [k, []]));
  const edges: number[] = [];
  for (const w of live) {
    if (w.path.length < 4) continue;
    const base = xs.length;
    for (let p = 0; p * 2 < w.path.length; p++) {
      xs.push(w.path[p * 2]);
      ys.push(w.path[p * 2 + 1]);
      for (const k of names) cols[k].push(w.attrs[k]);
      cols.age.push(p);
      if (p > 0) edges.push(base + p - 1, base + p);
    }
  }
  return new Material(
    Float64Array.from(xs), Float64Array.from(ys),
    Object.fromEntries(Object.keys(cols).map((k) => [k, Float64Array.from(cols[k])])),
    Uint32Array.from(edges),
  );
}

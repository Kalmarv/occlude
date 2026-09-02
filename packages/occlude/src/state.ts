/**
 * Sketch state. Module-level API functions record into the current sketch;
 * user code never touches this object. `sketch()` resets everything, so
 * re-running a sketch is the only edit model (spec non-goal: no mutation
 * after run).
 */

import { DEFAULT_PENS, type PenDef } from './pens.js';
import { Rng } from './random.js';
import type { L } from './units.js';

export type Winding = 'nonzero' | 'evenodd';

export interface TransformOp {
  translate?: [L, L];
  /** Degrees. */
  rotate?: number;
  scale?: number | [number, number];
}

export interface SketchOptions {
  aspect?: [number, number] | 'square' | 'paper';
  seed?: 'url' | number | string;
  origin?: 'topLeft' | 'center';
  yUp?: boolean;
  /** Default rect anchoring: 'corner' (default) or 'center' (p5 rectMode). */
  rectMode?: 'corner' | 'center';
}

/** One clip region recorded by `clip()`. */
export interface ClipRecord {
  /** The shape whose region clips; removed from the drawable list. */
  shape: import('./shapes.js').Shape;
  /** Complement: children keep the OUTSIDE of the region. */
  invert: boolean;
}

export interface State {
  shapes: import('./shapes.js').Shape[];
  clips: ClipRecord[];
  /** Active clip ids for shapes recorded now. */
  clipStack: number[];
  /** Active transform chain (outermost first). */
  tfChain: TransformOp[];
  penLib: Map<string, PenDef>;
  currentPen: string;
  marginPct: number;
  aspect: [number, number] | 'square' | 'paper';
  origin: 'topLeft' | 'center';
  yUp: boolean;
  rectMode: 'corner' | 'center';
  rng: Rng;
  seedUsed: number | string;
  /** `t.probe(label, value)` readouts, reset per compile. */
  probes: Map<string, ProbeAccumulator>;
  drawIndex: number;
}

let state: State | null = null;
let externalPenLib: PenDef[] | null = null;
/** Paper size hint (mm) for `bounds()` under aspect 'paper'; set by the host
 * (studio) before running, survives sketch() resets. Default A4 portrait. */
let paperHint: { w: number; h: number } = { w: 210, h: 297 };

/** URL-less 'url' seed: rolled ONCE per session and reused, so re-renders
 * (debug toggles, keystrokes, settings) never reshuffle the drawing —
 * only an explicit reroll (?seed=) changes it. */
let sessionSeed: number | null = null;

/** Host-injected seed for 'url'/default-seed sketches — the worker analogue
 * of the URL param (a worker's own URL carries no `?seed=`). Wins over the
 * URL when set; null clears. Like setPaperHint, survives sketch() resets. */
let seedHint: number | string | null = null;

export function setSeedHint(seed: number | string | null): void {
  seedHint = seed;
}

function freshState(opts: SketchOptions = {}): State {
  let seed: number | string;
  if (opts.seed === 'url' || opts.seed === undefined) {
    const fromUrl =
      seedHint !== null
        ? String(seedHint)
        : typeof globalThis !== 'undefined' && (globalThis as { location?: Location }).location
          ? new URLSearchParams((globalThis as unknown as { location: Location }).location.search).get('seed')
          : null;
    if (fromUrl !== null && fromUrl !== '') {
      seed = fromUrl;
    } else {
      if (sessionSeed === null) {
        sessionSeed = Math.floor(Math.random() * 2 ** 31);
        if (opts.seed === 'url') {
          console.info(`occlude: seed=${sessionSeed}`);
        }
      }
      seed = sessionSeed;
    }
  } else {
    seed = opts.seed;
  }
  const lib = new Map<string, PenDef>();
  for (const p of externalPenLib ?? DEFAULT_PENS) lib.set(p.name, { ...p });
  return {
    shapes: [],
    clips: [],
    clipStack: [],
    tfChain: [],
    penLib: lib,
    currentPen: (externalPenLib ?? DEFAULT_PENS)[0]?.name ?? 'default',
    marginPct: 0,
    aspect: opts.aspect ?? 'paper',
    origin: opts.origin ?? 'topLeft',
    yUp: opts.yUp ?? false,
    rectMode: opts.rectMode ?? 'corner',
    rng: new Rng(seed),
    seedUsed: seed,
    drawIndex: 0,
    probes: new Map(),
  };
}

/** Running stats for one probe label plus a deterministic thinned sample
 * (every stride-th value; the stride doubles when the reservoir fills) —
 * enough for a histogram without storing every value. */
export interface ProbeAccumulator {
  count: number;
  nonFinite: number;
  min: number;
  max: number;
  sum: number;
  stride: number;
  samples: number[];
}

const PROBE_RESERVOIR = 2048;

/** Record one value under `label`. Identity on the value; numbers only
 * count toward the stats (anything else is a "non-finite" tick). */
export function recordProbe(label: string, value: unknown): void {
  const s = getState();
  let p = s.probes.get(label);
  if (!p) {
    p = { count: 0, nonFinite: 0, min: Infinity, max: -Infinity, sum: 0, stride: 1, samples: [] };
    s.probes.set(label, p);
  }
  p.count++;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    p.nonFinite++;
    return;
  }
  if (value < p.min) p.min = value;
  if (value > p.max) p.max = value;
  p.sum += value;
  if (p.count % p.stride === 0) {
    if (p.samples.length >= PROBE_RESERVOIR) {
      p.samples = p.samples.filter((_, i) => i % 2 === 0);
      p.stride *= 2;
      if (p.count % p.stride !== 0) return;
    }
    p.samples.push(value);
  }
}

/** One probe's summary as posted to the studio. */
export interface ProbeSummary {
  count: number;
  nonFinite: number;
  min: number;
  max: number;
  mean: number;
  /** Deterministically thinned values, for a histogram. */
  samples: number[];
}

/** Every probe of the current run, in first-seen order. */
export function getProbeStats(): Record<string, ProbeSummary> {
  const out: Record<string, ProbeSummary> = {};
  const s = state;
  if (!s) return out;
  for (const [label, p] of s.probes) {
    const finite = p.count - p.nonFinite;
    out[label] = {
      count: p.count,
      nonFinite: p.nonFinite,
      min: finite > 0 ? p.min : NaN,
      max: finite > 0 ? p.max : NaN,
      mean: finite > 0 ? p.sum / finite : NaN,
      samples: p.samples.slice(),
    };
  }
  return out;
}

/** Start (or restart) a sketch. Clears all recorded shapes. */
export function sketch(opts: SketchOptions = {}): void {
  state = freshState(opts);
}

/** The studio injects its persisted pen library here before running sketches. */
export function setPenLibrary(pens: PenDef[]): void {
  externalPenLib = pens.length > 0 ? pens : null;
}

/** Hosts call this with the paper that will be rendered, so `bounds()` is
 * accurate for aspect 'paper' sketches. */
export function setPaperHint(wMm: number, hMm: number): void {
  paperHint = { w: wMm, h: hMm };
}

/** The paper hosts said they will render (mm) — what `bounds()` and
 * sketch-time lowering resolve against. */
export function getPaperHint(): { w: number; h: number } {
  return paperHint;
}

/**
 * The drawable extent in bare units (percent of the short side): the safe
 * full-bleed rect is `rect(0, 0, b.w, b.h)`. The short side is always 100;
 * the long side is 100 × aspect ratio. For aspect 'paper' this uses the
 * host's paper hint (A4 portrait when standalone).
 */
/** mm per user unit for the CURRENT aspect + paper hint — lets sketch-time
 * helpers (scatter spacing) resolve mm() before render. */
export function unitScaleMm(): number {
  const s = getState();
  const m = (s.marginPct / 100) * Math.min(paperHint.w, paperHint.h);
  const innerW = paperHint.w - 2 * m;
  const innerH = paperHint.h - 2 * m;
  let aw: number;
  let ah: number;
  if (s.aspect === 'square') {
    aw = 1;
    ah = 1;
  } else if (s.aspect === 'paper') {
    aw = innerW;
    ah = innerH;
  } else {
    [aw, ah] = s.aspect;
  }
  const scale = Math.min(innerW / aw, innerH / ah);
  return (Math.min(aw, ah) * scale) / 100;
}

export function bounds(): { w: number; h: number; cx: number; cy: number } {
  const s = getState();
  let aw: number;
  let ah: number;
  if (s.aspect === 'square') {
    aw = 1;
    ah = 1;
  } else if (s.aspect === 'paper') {
    const m = (s.marginPct / 100) * Math.min(paperHint.w, paperHint.h);
    aw = paperHint.w - 2 * m;
    ah = paperHint.h - 2 * m;
  } else {
    [aw, ah] = s.aspect;
  }
  const short = Math.min(aw, ah);
  const w = (100 * aw) / short;
  const h = (100 * ah) / short;
  return { w, h, cx: w / 2, cy: h / 2 };
}

export function getState(): State {
  if (!state) state = freshState();
  return state;
}

/** Percent inset from the paper edge; coords measure inside it. */
export function margin(n: number): void {
  getState().marginPct = n;
}

/**
 * Set the current pen by library name (throws on unknown so shared sketches
 * fail loudly), or define an ad-hoc pen for this sketch only.
 */
export function pen(p: string | (Partial<PenDef> & { name: string })): void {
  const s = getState();
  if (typeof p === 'string') {
    if (!s.penLib.has(p)) {
      throw new Error(
        `unknown pen '${p}' — available: ${[...s.penLib.keys()].join(', ')}`,
      );
    }
    s.currentPen = p;
    return;
  }
  const def: PenDef = {
    width: 0.3,
    color: '#111111',
    feed: 3000,
    penDown: 0,
    penUp: 5,
    penDelay: 100,
    ...p,
  };
  s.penLib.set(def.name, def);
  s.currentPen = def.name;
}

/** Scope a transform to the callback. Nesting composes; no unbalanced pops. */
export function push(t: TransformOp, fn: () => void): void {
  const s = getState();
  s.tfChain.push(t);
  try {
    fn();
  } finally {
    s.tfChain.pop();
  }
}

/**
 * Restrict everything created inside `fn` to the region of `shape`. The clip
 * shape itself is not drawn and does not occlude.
 */
export function clip(
  shape: import('./shapes.js').Shape,
  fn: () => void,
  invert = false,
): void {
  const s = getState();
  // The shape was recorded on construction; a clip region is not a drawable.
  const idx = s.shapes.indexOf(shape);
  if (idx >= 0) s.shapes.splice(idx, 1);
  const clipId = s.clips.length;
  s.clips.push({ shape, invert });
  s.clipStack.push(clipId);
  try {
    fn();
  } finally {
    s.clipStack.pop();
  }
}

// ---- randomness (one stream per sketch) ----

export function rnd(): number;
export function rnd(n: number): number;
export function rnd(a: number, b: number): number;
export function rnd(a?: number, b?: number): number {
  const f = getState().rng.float();
  if (a === undefined) return f;
  if (b === undefined) return f * a;
  return a + f * (b - a);
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(getState().rng.float() * arr.length)];
}

export function chance(p: number): boolean {
  return getState().rng.float() < p;
}

export function prob<T>(p: number, fn: () => T, elseFn?: () => T): T | undefined {
  if (chance(p)) return fn();
  return elseFn?.();
}

export function noise(x: number, y = 0, z = 0): number {
  return getState().rng.noise(x, y, z);
}

export interface RandomStream {
  rnd(): number;
  rnd(n: number): number;
  rnd(a: number, b: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
  prob<T>(p: number, fn: () => T, elseFn?: () => T): T | undefined;
  noise(x: number, y?: number, z?: number): number;
}

/**
 * An independent random stream keyed off the master seed. Inserting shapes
 * that draw from one stream never shifts the values of another, so parts of
 * a composition can be iterated on in isolation.
 */
export function stream(name: string): RandomStream {
  const rng = new Rng(`${getState().seedUsed}:stream:${name}`);
  const rnd = (a?: number, b?: number): number => {
    const f = rng.float();
    if (a === undefined) return f;
    if (b === undefined) return f * a;
    return a + f * (b - a);
  };
  return {
    rnd: rnd as RandomStream['rnd'],
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(rng.float() * arr.length)],
    chance: (p) => rng.float() < p,
    prob: (p, fn, elseFn) => (rng.float() < p ? fn() : elseFn?.()),
    noise: (x, y = 0, z = 0) => rng.noise(x, y, z),
  };
}

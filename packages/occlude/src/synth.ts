/**
 * synth — random mathematical expressions, for finding fields and warps by
 * looking rather than by deriving.
 *
 * It is an EXPLORATION tool, not a runtime dependency. Generate variants,
 * scrub until one looks right, then paste `.source` into the sketch; after
 * that the sketch has no relationship to synth at all. `.source` is the
 * deliverable and the function is the preview of it, which is why the
 * emitted string never calls back into this module — a protected divide is
 * written out inline, not as `synth.pdiv(...)`.
 *
 * Nothing here rescales, normalises or bounds the result. The shape of the
 * variation IS the point, and `t.map`/negation are one character away.
 * `stats` tells the caller what range they are holding.
 */

import { Rng } from './random.js';
import { bounds } from './state.js';

export interface SynthStats {
  /** Fraction of probe samples that were finite. */
  finite: number;
  /** 2nd and 98th percentile — NOT min/max, which one outlier ruins. */
  lo: number;
  hi: number;
  mid: number;
  spread: number;
  /** (max - hi) / spread: how far the worst outlier sits beyond the body. */
  tail: number;
}

export interface SynthFn {
  (...args: number[]): number;
  /** The expression, self-contained: paste it into a sketch and delete synth. */
  source: string;
  stats: SynthStats;
}

export interface WarpFn {
  (x: number, y: number): [number, number];
  source: [string, string];
  stats: [SynthStats, SynthStats];
}

export interface SynthBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SynthOpts {
  /** Required for reproducibility: same seed and vars, same source, forever. */
  seed?: number;
  depth?: number;
  /** Optional cap on total nodes; the tree degrades to terminals once hit. */
  nodes?: number;
  bounds?: SynthBounds;
  tries?: number;
}

// ---- grammar ------------------------------------------------------------
//
// THE WEIGHTS BELOW ARE THE MAIN TUNING KNOB. Everything else about the
// output quality — how busy, how smooth, how often it is worth keeping —
// is downstream of these numbers. Binary ops dominate so expressions
// combine rather than pile filters on one variable; atan2/min/max are rare
// because they are strong flavours that read as "a synth did this" when
// they show up often.

const BINARY: { op: string; w: number }[] = [
  { op: '+', w: 3 },
  { op: '-', w: 3 },
  { op: '*', w: 3 },
  { op: '/', w: 2 }, // protected — see emit()
  { op: 'min', w: 0.5 },
  { op: 'max', w: 0.5 },
  { op: 'atan2', w: 0.5 },
];

const UNARY: { op: string; w: number }[] = [
  { op: 'sin', w: 3 },
  { op: 'cos', w: 3 },
  { op: 'tanh', w: 2 },
  { op: 'abs', w: 1 },
  { op: 'neg', w: 1 },
  { op: 'sqrtAbs', w: 1 },
];

/** Readable constants only: a pasted source should not carry 0.7234891. */
const CONSTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0.5', '1.5', '2.5', 'Math.PI'];

/** Shape of the tree at each level: binary dominates. */
const PICK_BINARY = 0.6;
const PICK_UNARY = 0.88; // i.e. 0.28 unary, the remaining 0.12 terminal

type Node =
  | { kind: 'var'; name: string }
  | { kind: 'const'; text: string }
  | { kind: 'un'; op: string; a: Node }
  | { kind: 'bin'; op: string; a: Node; b: Node };

const weighted = <T extends { w: number }>(rng: Rng, list: T[]): T => {
  const total = list.reduce((s, e) => s + e.w, 0);
  let r = rng.float() * total;
  for (const e of list) {
    r -= e.w;
    if (r <= 0) return e;
  }
  return list[list.length - 1];
};

function grow(rng: Rng, vars: string[], depth: number, budget: { n: number }): Node {
  const terminal = (): Node =>
    rng.float() < 0.65
      ? { kind: 'var', name: vars[Math.floor(rng.float() * vars.length)] }
      : { kind: 'const', text: CONSTS[Math.floor(rng.float() * CONSTS.length)] };
  if (depth <= 0 || budget.n <= 1) return terminal();
  const r = rng.float();
  if (r < PICK_BINARY) {
    budget.n -= 2;
    const op = weighted(rng, BINARY).op;
    return { kind: 'bin', op, a: grow(rng, vars, depth - 1, budget), b: grow(rng, vars, depth - 1, budget) };
  }
  if (r < PICK_UNARY) {
    budget.n -= 1;
    return { kind: 'un', op: weighted(rng, UNARY).op, a: grow(rng, vars, depth - 1, budget) };
  }
  return terminal();
}

/**
 * Render a node as standalone JavaScript. The protected divide is written
 * out here rather than called: `a / (Math.abs(b) < 1e-6 ? 1e-6 : b)`. That
 * repeats the denominator, which is the price of a source string that runs
 * with no import. Inside the 1e-6 band the guard is positive regardless of
 * b's sign — a singularity guard, not a sign-preserving division.
 */
function emit(n: Node): string {
  switch (n.kind) {
    case 'var':
      return n.name;
    case 'const':
      return n.text;
    case 'un': {
      const a = emit(n.a);
      if (n.op === 'neg') return `(-${a})`;
      if (n.op === 'sqrtAbs') return `Math.sqrt(Math.abs(${a}))`;
      return `Math.${n.op}(${a})`;
    }
    case 'bin': {
      const a = emit(n.a);
      const b = emit(n.b);
      if (n.op === '/') {
        // A literal denominator cannot be zero (0 is not in CONSTS), so the
        // guard is dead code. Not simplification — just declining to emit a
        // branch that can never run into a string whose readability is the
        // deliverable.
        if (n.b.kind === 'const') return `(${a} / ${b})`;
        return `(${a} / (Math.abs(${b}) < 1e-6 ? 1e-6 : ${b}))`;
      }
      if (n.op === 'min' || n.op === 'max' || n.op === 'atan2') return `Math.${n.op}(${a}, ${b})`;
      return `(${a} ${n.op} ${b})`;
    }
  }
}

const compile = (vars: string[], src: string): ((...a: number[]) => number) =>
  new Function(...vars, `return ${src};`) as (...a: number[]) => number;

const pct = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
};

/**
 * Evaluate on an n x n grid and describe the result. The first variable
 * sweeps the bounds' x, the second its y; any further variables repeat that
 * sweep (alternating x, y), which is enough to tell a usable field from a
 * spike but is not a claim about how the caller will drive them.
 */
export function probe(
  fn: (...a: number[]) => number,
  vars: string[],
  b: SynthBounds,
  n = 20,
): SynthStats {
  const vals: number[] = [];
  let finite = 0;
  const total = n * n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = b.x + (b.w * i) / Math.max(1, n - 1);
      const y = b.y + (b.h * j) / Math.max(1, n - 1);
      const args = vars.map((_, k) => (k % 2 === 0 ? x : y));
      const v = fn(...args);
      if (Number.isFinite(v)) {
        finite++;
        vals.push(v);
      }
    }
  }
  if (vals.length === 0) {
    return { finite: 0, lo: NaN, hi: NaN, mid: NaN, spread: 0, tail: Infinity };
  }
  vals.sort((p, q) => p - q);
  const lo = pct(vals, 0.02);
  const hi = pct(vals, 0.98);
  const spread = hi - lo;
  const max = vals[vals.length - 1];
  return {
    finite: finite / total,
    lo,
    hi,
    mid: pct(vals, 0.5),
    spread,
    // A flat page with one spike near a singularity has plenty of min/max
    // range and is useless; this is the test that catches it.
    tail: spread > 1e-12 ? (max - hi) / spread : Infinity,
  };
}

const usable = (s: SynthStats): boolean =>
  s.finite >= 0.95 && s.spread >= 1e-6 && s.tail <= 20;

const defaultBounds = (): SynthBounds => {
  const b = bounds();
  return { x: 0, y: 0, w: b.w, h: b.h };
};

function one(rng: Rng, vars: string[], opts: SynthOpts, b: SynthBounds): SynthFn | null {
  const budget = { n: opts.nodes ?? Number.MAX_SAFE_INTEGER };
  const src = emit(grow(rng, vars, opts.depth ?? 3, budget));
  let raw: (...a: number[]) => number;
  try {
    raw = compile(vars, src);
  } catch {
    return null;
  }
  const stats = probe(raw, vars, b);
  if (!usable(stats)) return null;
  // The only guard: a singularity the 400-sample probe missed reads as 0
  // rather than poisoning the geometry downstream.
  const fn = ((...a: number[]): number => {
    const v = raw(...a);
    return Number.isFinite(v) ? v : 0;
  }) as SynthFn;
  fn.source = src;
  fn.stats = stats;
  return fn;
}

/**
 * A random expression over `vars` that survived probing. Throws when
 * `tries` attempts all fail — a silent `undefined` would surface as a
 * confusing TypeError deep inside a sketch instead of here, where the fix
 * (raise tries, raise depth, widen bounds) is obvious.
 */
function synthFn(vars: string[], opts: SynthOpts = {}): SynthFn {
  if (vars.length === 0) throw new Error('synth: needs at least one variable name');
  for (const v of vars) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v)) throw new Error(`synth: '${v}' is not a variable name`);
  }
  const rng = new Rng(opts.seed ?? 0);
  const b = opts.bounds ?? defaultBounds();
  const tries = opts.tries ?? 200;
  for (let i = 0; i < tries; i++) {
    const got = one(rng, vars, opts, b);
    if (got) return got;
  }
  throw new Error(
    `synth: ${tries} tries produced nothing usable (all were non-finite, constant, or a spike) — ` +
      'raise tries or depth, or widen bounds',
  );
}

/** Two independent expressions over the same variables: a displacement. */
function warp(vars: string[], opts: SynthOpts = {}): WarpFn {
  const rng = new Rng(opts.seed ?? 0);
  const b = opts.bounds ?? defaultBounds();
  const tries = opts.tries ?? 200;
  const pair: SynthFn[] = [];
  for (let k = 0; k < 2; k++) {
    let got: SynthFn | null = null;
    for (let i = 0; i < tries && !got; i++) got = one(rng, vars, opts, b);
    if (!got) {
      throw new Error(`synth.warp: ${tries} tries produced nothing usable for component ${k}`);
    }
    pair.push(got);
  }
  // Spread whatever the caller passes: the declared shape is (x, y) because
  // that is what deform() calls, but a three-variable pool still works.
  const fn = ((...a: number[]): [number, number] => [pair[0](...a), pair[1](...a)]) as unknown as WarpFn;
  fn.source = [pair[0].source, pair[1].source];
  fn.stats = [pair[0].stats, pair[1].stats];
  return fn;
}

export const synth = Object.assign(synthFn, { warp });

/**
 * Stroke shaders: a program that runs along every stroke the drawing lays
 * down and decides what the pen does there.
 *
 * The domain is the PLAN CHAIN, not the fragment. A fragment is a sub-range
 * of one primitive, and a stroked circle is already twenty-odd primitives —
 * the thing an artist calls a stroke only exists after the plan's merge.
 * A chain has an arc length, an order and an index, so `s` in millimetres
 * is exact rather than reconstructed.
 *
 * The stage is chains to chains: the program is sampled along a chain at
 * the pen's own nib width, in the MIDDLE of each step (finer detail cannot
 * reach the paper, and the middle gives the last step a say), the chain
 * is cut where the returned ink changes, and each constant span is kept,
 * dropped, dashed, re-penned or drawn more than once. Nothing here moves a
 * point: a shader never puts ink outside what occlusion cleared.
 */

import { evalPrim, primLength, subPrim, type Prim } from './prims.js';
import type { L } from './units.js';
import type { PlanChain } from './plan.js';

/** What the stage knows that a chain does not: the pen's nib, and how to
 * read a length the sketch wrote in its own units. Both need the resolved
 * paper, so they are passed in — the kernel never reaches for the frame. */
export interface ShadeFrame {
  nibOf(pen: number): number;
  resolve(v: L): number;
  /** The drawing's pen table, by name. A shader reaches a pen the drawing
   * uses; an unknown name is a loud error, the same as anywhere else. */
  penOf(name: string): number;
  /** How many pens the drawing uses. A slot outside the table is refused
   * here, because a plan that names a pen the exporters cannot find loses
   * its ink in silence. */
  penCount(): number;
}

/** More passes than this is not weight, it is a mistake. A pen laying the
 * same line down sixteen times has already made the darkest mark it can. */
export const MAX_PASSES = 16;

/** What the engine knows about the stroke at the point being shaded. */
export interface StrokeCtx {
  /** Row of this stroke in the full plan — its drawing order. */
  index: number;
  /** Pen slot the plan gave the stroke, before any shader override. */
  pen: number;
  /** Arc length of the whole stroke, mm. */
  length: number;
  /** A stipple tap: zero length, plotted as a pen-down/delay/pen-up. */
  dot: boolean;
  /** Position along the stroke as a fraction, `s / length`. */
  at: number;
}

/** What the pen does at that point. Every field is optional; an empty
 * record leaves the stroke exactly as the plan made it. */
export interface StrokeInk {
  /** Draw this span more than once — retrace, the same path repeated. A
   * value below 1 is a dropout, the same as `keep: false`. */
  passes?: number;
  /** The pen to draw this span with, by name or by slot. The tour grouped
   * pens BEFORE the shader ran, so an override costs a tool change the
   * plan did not optimize for. A shader reaches the pens the drawing
   * already uses: a name the drawing never drew with is an error, not a
   * new pen. */
  pen?: number | string;
  /** Mark and gap, repeated along the stroke. Lengths in the sketch's own
   * units: `mm(2)` is two millimetres, a bare `2` is two percent of the
   * drawable's short side. */
  dash?: readonly [L, L];
  /** False drops the span. */
  keep?: boolean;
}

/** The program itself: arc length in mm, the point there, and what the
 * engine knows about the stroke. */
export type StrokeProgram = (s: number, p: [number, number], ctx: StrokeCtx) => StrokeInk;

const SHADER = Symbol.for('occlude.shader');

/** A shader value: the program plus its marker. Pure — it reads no seed
 * and no paper, so it is a module import, not a toolkit function. */
export interface ShaderValue {
  readonly [SHADER]: true;
  readonly program: StrokeProgram;
}

/** Wrap a program as the value `t.plan({ shader })` takes. */
export function shader(program: StrokeProgram): ShaderValue {
  if (typeof program !== 'function') throw new Error('shader: expected a function (s, p, ctx) => ink');
  return { [SHADER]: true, program };
}

export const isShader = (v: unknown): v is ShaderValue =>
  typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[SHADER] === true;

// ---- cutting a chain by arc length -------------------------------------

/**
 * How far along a cubic each of its parameter samples sits. A line and an
 * arc are uniform in their own parameter, so arc length IS the parameter
 * scaled; a cubic is not, and mapping one to the other with a straight
 * division puts the pen in the wrong place. A dash on a curve made marks
 * from one to five millimetres long when they were all asked to be two.
 */
const ARC_SAMPLES = 128;

const arcTable = (p: Prim): Float64Array | undefined => {
  if (p.t !== 'cubic') return undefined;
  const cum = new Float64Array(ARC_SAMPLES + 1);
  let [px, py] = evalPrim(p, 0);
  for (let i = 1; i <= ARC_SAMPLES; i++) {
    const [x, y] = evalPrim(p, i / ARC_SAMPLES);
    cum[i] = cum[i - 1] + Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return cum;
};

/** The parameter at `frac` of a primitive's own arc length. */
const paramAt = (table: Float64Array | undefined, frac: number): number => {
  const f = Math.min(Math.max(frac, 0), 1);
  if (table === undefined) return f;
  const want = f * table[ARC_SAMPLES];
  if (!(want > 0)) return 0;
  let lo = 0;
  let hi = ARC_SAMPLES;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= want) lo = mid;
    else hi = mid;
  }
  const span = table[hi] - table[lo];
  const within = span > 0 ? (want - table[lo]) / span : 0;
  return (lo + within) / ARC_SAMPLES;
};

/** Per-primitive lengths, cumulative offsets, and the arc tables curves need. */
interface Ruler {
  lengths: number[];
  starts: number[];
  tables: (Float64Array | undefined)[];
  total: number;
}

const measure = (prims: readonly Prim[]): Ruler => {
  const lengths: number[] = [];
  const starts: number[] = [];
  const tables: (Float64Array | undefined)[] = [];
  let total = 0;
  for (const p of prims) {
    starts.push(total);
    const table = arcTable(p);
    tables.push(table);
    // The table's own last entry IS the length it will be inverted
    // against, so a curve measures and maps with one set of numbers.
    const L = table === undefined ? primLength(p) : table[ARC_SAMPLES];
    lengths.push(L);
    total += L;
  }
  return { lengths, starts, tables, total };
};

/** The point at arc length `s` along a chain. */
const pointAt = (prims: readonly Prim[], r: Ruler, s: number): [number, number] => {
  if (prims.length === 0) return [0, 0];
  for (let i = 0; i < prims.length; i++) {
    const end = r.starts[i] + r.lengths[i];
    if (s <= end || i === prims.length - 1) {
      const L = r.lengths[i];
      return evalPrim(prims[i], paramAt(r.tables[i], L > 0 ? (s - r.starts[i]) / L : 0));
    }
  }
  return evalPrim(prims[prims.length - 1], 1);
};

/** The primitives covering `[s0, s1]` of a chain, cut at both ends. An
 * empty span (or one inside a zero-length primitive) gives no primitives,
 * and the caller drops it: a zero-length stroke is not ink. */
const cut = (prims: readonly Prim[], r: Ruler, s0: number, s1: number): Prim[] => {
  const out: Prim[] = [];
  if (!(s1 > s0)) return out;
  for (let i = 0; i < prims.length; i++) {
    const L = r.lengths[i];
    if (L <= 0) continue;
    const a = r.starts[i];
    const b = a + L;
    if (b <= s0 || a >= s1) continue;
    const t0 = paramAt(r.tables[i], (s0 - a) / L);
    const t1 = paramAt(r.tables[i], (s1 - a) / L);
    if (t1 > t0) out.push(t0 === 0 && t1 === 1 ? prims[i] : subPrim(prims[i], t0, t1));
  }
  return out;
};

// ---- the stage ---------------------------------------------------------

/** The ink record, normalized so two samples can be compared for "same
 * ink" without caring how the program spelled them. */
interface Span {
  keep: boolean;
  passes: number;
  pen: number;
  dash: readonly [number, number] | undefined;
}

const normalize = (ink: StrokeInk, pen: number, frame: ShadeFrame, nib: number): Span => {
  if (ink.passes !== undefined && !Number.isFinite(ink.passes)) {
    throw new Error(`shader: passes must be a finite number, not ${ink.passes}`);
  }
  const asked = ink.passes === undefined ? 1 : Math.floor(ink.passes);
  // Above the cap is a mistake, and an uncapped count is an out-of-memory
  // with no diagnostic: a million passes is a million chains.
  const passes = Math.min(asked, MAX_PASSES);
  const keep = ink.keep !== false && asked >= 1;
  let dash: readonly [number, number] | undefined;
  if (ink.dash !== undefined) {
    const [on, off] = [frame.resolve(ink.dash[0]), frame.resolve(ink.dash[1])];
    // A dash needs a positive mark and a positive gap to be a dash at all,
    // and a period the pen can resolve. Finer than the nib is not a dash:
    // it is a solid line on paper and a hundred thousand pen lifts in the
    // plan. Anything else draws solid, and the sketch keeps rendering.
    if (Number.isFinite(on) && Number.isFinite(off) && on > 0 && off > 0 && on + off >= nib) dash = [on, off];
  }
  let want = pen;
  if (ink.pen !== undefined) {
    if (typeof ink.pen === 'string') want = frame.penOf(ink.pen);
    else {
      want = Math.floor(ink.pen);
      // A slot the pen table does not hold is refused here. The exporters
      // find no pen for it and drop the chain, so the ink would vanish
      // with no error anywhere — the one failure a plotter must not have.
      if (!Number.isFinite(want) || want < 0 || want >= frame.penCount()) {
        throw new Error(`shader: no pen ${String(ink.pen)} in this drawing (it uses ${frame.penCount()} pen${frame.penCount() === 1 ? '' : 's'}, numbered from 0). Name the pen instead.`);
      }
    }
  }
  return { keep, passes: Math.max(1, passes), pen: want, dash };
};

const same = (a: Span, b: Span): boolean =>
  a.keep === b.keep && a.passes === b.passes && a.pen === b.pen &&
  (a.dash === b.dash || (!!a.dash && !!b.dash && a.dash[0] === b.dash[0] && a.dash[1] === b.dash[1]));

/**
 * Run a program over one chain and give the chains it becomes. The chains
 * come back without indices; `shadeChains` numbers the whole plan once.
 */
function shadeChain(chain: PlanChain, program: StrokeProgram, frame: ShadeFrame): Omit<PlanChain, 'index'>[] {
  const r = measure(chain.prims);
  const ctxBase = { index: chain.index, pen: chain.pen, length: r.total, dot: chain.dot };

  // A tap has no length to walk: it is shaded once, at its own point.
  if (chain.dot || r.total <= 0) {
    const span = normalize(program(0, pointAt(chain.prims, r, 0), { ...ctxBase, at: 0 }), chain.pen, frame, frame.nibOf(chain.pen));
    if (!span.keep) return [];
    const out: Omit<PlanChain, 'index'>[] = [];
    for (let k = 0; k < span.passes; k++) out.push({ pen: span.pen, dot: chain.dot, prims: chain.prims });
    return out;
  }

  // Sample at the nib: finer than the pen can resolve is detail the paper
  // never sees, and coarser would miss a change the artist asked for.
  const nib = frame.nibOf(chain.pen);
  const step = nib > 0 ? nib : r.total;
  const steps = Math.max(1, Math.ceil(r.total / step));
  const cuts: { from: number; span: Span }[] = [];
  for (let i = 0; i < steps; i++) {
    // The step's MIDDLE, not its leading edge: the last nib of a stroke
    // gets a say, and a change lands within half a step of where it is.
    const s = (r.total * (i + 0.5)) / steps;
    const span = normalize(program(s, pointAt(chain.prims, r, s), { ...ctxBase, at: s / r.total }), chain.pen, frame, nib);
    if (cuts.length === 0 || !same(cuts[cuts.length - 1].span, span)) cuts.push({ from: (r.total * i) / steps, span });
  }

  // One span that changes nothing is the chain itself. Say so exactly:
  // a program that returns `{}` must leave the plan bytes untouched, and
  // re-cutting a chain into itself cannot promise that.
  if (cuts.length === 1) {
    const { span } = cuts[0];
    if (!span.keep) return [];
    if (span.passes === 1 && span.pen === chain.pen && !span.dash) return [{ pen: chain.pen, dot: chain.dot, prims: chain.prims }];
  }

  const out: Omit<PlanChain, 'index'>[] = [];
  // Dash phase runs along the whole stroke, not along each span: a span
  // boundary the artist cannot see must not re-phase the pattern. A span
  // that dashes differently starts its own pattern.
  let phase = 0;
  let phaseOf: readonly [number, number] | undefined;
  for (let c = 0; c < cuts.length; c++) {
    const { from, span } = cuts[c];
    const to = c + 1 < cuts.length ? cuts[c + 1].from : r.total;
    const pieces: [number, number][] = [];
    if (span.dash) {
      const [on, off] = span.dash;
      const period = on + off;
      if (!phaseOf || phaseOf[0] !== on || phaseOf[1] !== off) phase = 0;
      phaseOf = span.dash;
      let s = from - (phase % period);
      while (s < to) {
        const a = Math.max(s, from);
        const b = Math.min(s + on, to);
        if (b > a) pieces.push([a, b]);
        s += period;
      }
      phase += to - from;
    } else {
      pieces.push([from, to]);
      phase = 0;
      phaseOf = undefined;
    }
    if (!span.keep) continue;
    for (const [a, b] of pieces) {
      const prims = cut(chain.prims, r, a, b);
      if (prims.length === 0) continue;
      for (let k = 0; k < span.passes; k++) out.push({ pen: span.pen, dot: false, prims });
    }
  }
  return out;
}

/**
 * The stage: every chain of a plan through the program, renumbered. The
 * chains keep the plan's order — a shader decides what the pen does, never
 * where the pen goes next.
 */
export function shadeChains(chains: readonly PlanChain[], program: StrokeProgram, frame: ShadeFrame): PlanChain[] {
  const out: PlanChain[] = [];
  for (const chain of chains) {
    for (const made of shadeChain(chain, program, frame)) {
      out.push({ index: out.length, ...made });
    }
  }
  return out;
}

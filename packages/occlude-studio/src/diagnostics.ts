/**
 * Machine diagnostic patterns (paper mm, plotted via ebb.plot()). Where the
 * calibration sheet characterizes PENS, these characterize the MACHINE —
 * each pattern isolates one mechanical failure axis and makes the diagnosis
 * readable off the paper:
 *
 * - Registration probe: which-axis / how-much for steps lost under travel
 *   stress. A "+" is drawn FIRST, a "✕" at the same center LAST, with a
 *   heavy fast-travel batch between. Any offset between their centers is
 *   the accumulated position error (open-loop skips that QS cannot see).
 * - Backlash squares: separates reversal slop from step loss. The left
 *   square overtraces every edge twice in the SAME direction; the right
 *   square traces each edge there-and-back. Backlash doubles edges only on
 *   the right square; lost steps shift both equally.
 * - Corner ringing: the same sharp comb at three feeds. The lowest feed
 *   whose corners wiggle is the machine's cornering ceiling — the number
 *   the junction-deviation setting encodes.
 */

import type { PenDef } from 'occlude';

export interface Diagnostic {
  plan: Float64Array;
  pens: PenDef[];
}

interface Chain {
  pen: number;
  pts: [number, number][];
}

/** Synthetic pen for a pattern, inheriting the PHYSICAL pen's tuning —
 * penDelay especially: diagnostics are dominated by short strokes, and a
 * settle shorter than the servo's real travel time means the pen is
 * ordered back up before it ever reaches the paper. */
const pen = (name: string, feed: number, base?: PenDef): PenDef => ({
  name,
  width: base?.width ?? 0.3,
  color: '#000',
  feed,
  penDown: base?.penDown ?? 0,
  penUp: base?.penUp ?? 5,
  penDelay: Math.max(base?.penDelay ?? 300, 300),
});

function encode(chains: Chain[]): Float64Array {
  const out: number[] = [];
  for (const c of chains) out.push(c.pen, 0, c.pts.length, ...c.pts.flat());
  return new Float64Array(out);
}

function encodeDots(pts: [number, number][]): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(0, 1, 1, p[0], p[1]);
  return out;
}

/**
 * Timing-calibration plots: each isolates ONE cost axis, so the recorded
 * (model breakdown, wall time) pairs form a well-conditioned system for
 * fitting correction coefficients (plotstats --fit). ~1–3 min each.
 *
 * - dots: 120 taps → pen-cycle truth (settle + tap overhead).
 * - lines: 40 long parallel strokes → draw feed + full-lift travel truth.
 * - segments: dense zigzags → per-command serial overhead (many short
 *   segments, little ink).
 * - hatch: a tightly hatched square → the mixed regime real fills live in.
 */
export function calDots(base?: PenDef): Diagnostic {
  const pts: [number, number][] = [];
  for (let j = 0; j < 10; j++) for (let i = 0; i < 12; i++) pts.push([4 + i * 4, 4 + j * 4]);
  return { plan: new Float64Array(encodeDots(pts)), pens: [pen('cal-dots', 3000, base)] };
}

export function calLines(base?: PenDef): Diagnostic {
  const chains: Chain[] = [];
  for (let i = 0; i < 40; i++) {
    const y = 4 + i * 1.5;
    chains.push({ pen: 0, pts: i % 2 ? [[64, y], [4, y]] : [[4, y], [64, y]] });
  }
  return { plan: encode(chains), pens: [pen('cal-lines', 3000, base)] };
}

export function calSegments(base?: PenDef): Diagnostic {
  const chains: Chain[] = [];
  for (let i = 0; i < 12; i++) {
    const y = 4 + i * 4;
    const pts: [number, number][] = [];
    for (let x = 0; x <= 60; x += 1) pts.push([4 + x, y + (x % 2 ? 1.2 : 0)]);
    chains.push({ pen: 0, pts });
  }
  return { plan: encode(chains), pens: [pen('cal-segments', 3000, base)] };
}

export function calHatch(base?: PenDef): Diagnostic {
  const chains: Chain[] = [];
  for (let i = 0; i < 50; i++) {
    const y = 4 + i * 0.8;
    chains.push({ pen: 0, pts: i % 2 ? [[44, y], [4, y]] : [[4, y], [44, y]] });
  }
  return { plan: encode(chains), pens: [pen('cal-hatch', 3000, base)] };
}

/** "+" first, stress travels, "✕" last — centers coincide iff no steps were
 * lost. Footprint ~120×64mm from the origin. */
export function registrationProbe(base?: PenDef): Diagnostic {
  const chains: Chain[] = [];
  const c = 6; // shared center of + and ✕
  chains.push({ pen: 0, pts: [[c - 4, c], [c + 4, c]] });
  chains.push({ pen: 0, pts: [[c, c - 4], [c, c + 4]] });
  // Stress batch: short ticks on alternating sides force ~100mm fast
  // travels between every pair — the motion most likely to skip.
  for (let i = 0; i < 24; i++) {
    const y = 4 + (i % 6) * 10;
    const x0 = i % 2 === 0 ? 15 : 115;
    chains.push({ pen: 0, pts: [[x0, y], [x0 + 4, y]] });
  }
  chains.push({ pen: 0, pts: [[c - 3, c - 3], [c + 3, c + 3]] });
  chains.push({ pen: 0, pts: [[c - 3, c + 3], [c + 3, c - 3]] });
  return { plan: encode(chains), pens: [pen('probe', base?.feed ?? 3000, base)] };
}

/** Left square: every edge drawn twice from the same end. Right square:
 * every edge there-and-back in one stroke. Footprint ~45×20mm. */
export function backlashSquares(base?: PenDef): Diagnostic {
  const chains: Chain[] = [];
  const square = (x: number, bidirectional: boolean): void => {
    const s = 15;
    const edges: [number, number][][] = [
      [[x, 5], [x + s, 5]],
      [[x, 5 + s], [x + s, 5 + s]],
      [[x, 5], [x, 5 + s]],
      [[x + s, 5], [x + s, 5 + s]],
    ];
    for (const [p0, p1] of edges) {
      if (bidirectional) chains.push({ pen: 0, pts: [p0, p1, p0] });
      else {
        chains.push({ pen: 0, pts: [p0, p1] });
        chains.push({ pen: 0, pts: [p0, p1] });
      }
    }
  };
  square(5, false);
  square(30, true);
  return { plan: encode(chains), pens: [pen('backlash', base?.feed ?? 3000, base)] };
}

/** The same 8-tooth right-angle comb at three feeds, slow to fast bottom to
 * top, 1–3 tick marks on the left counting the row. Footprint ~66×70mm. */
export function cornerRinging(base?: PenDef): Diagnostic {
  const feeds = [2000, 4000, 6000]; // the sweep IS the diagnostic — no base feed
  const chains: Chain[] = [];
  feeds.forEach((_, row) => {
    const y0 = 5 + row * 25;
    for (let t = 0; t <= row; t++) {
      chains.push({ pen: row, pts: [[2 + t * 2, y0], [2 + t * 2, y0 + 6]] });
    }
    const comb: [number, number][] = [[10, y0]];
    for (let i = 0; i < 8; i++) {
      const x = 10 + i * 7;
      comb.push([x, y0 + 10], [x + 3.5, y0 + 10], [x + 3.5, y0], [x + 7, y0]);
    }
    chains.push({ pen: row, pts: comb });
  });
  return {
    plan: encode(chains),
    pens: feeds.map((f) => pen(`comb-${f}`, f, base)),
  };
}

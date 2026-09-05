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

import type { ServoOverride } from './ebb.js';

export interface Diagnostic {
  plan: Float64Array;
  pens: PenDef[];
  /** Per-pen servo pulses (indexed like `pens`) for the pen-height cards.
   * Passed to `ebb.plot()` as its `servoFor` hook. */
  servo?: (ServoOverride | undefined)[];
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

// ---- pen-height calibration -------------------------------------------------
//
// The servo is open loop and the gantry sags, so the only sensor is ink:
// put the pen on paper at a known pulse and see what comes back. These three
// cards pin the two servo registers per block (Diagnostic.servo) and let the
// paper answer, in PULSE units, the questions the pen-height model needs.
// Nothing here is measured in millimetres.

/** Options shared by the pen-height cards. Pulses are EBB SC units. */
export interface LiftGridOpts {
  /** Bed extent, paper mm — the grid covers it with a margin. */
  bedW: number;
  bedH: number;
  /** Lift pulses (SC,4) to try in each cell, most lift first (ascending). */
  pulses: number[];
  cols: number;
  rows: number;
}

/**
 * Lift grid — where on the bed does each lift pulse still clear the paper?
 *
 * Each cell is framed first (full-lift travel into the cell), then holds one
 * strip per pulse, left → right in the given order. A strip is a short stack
 * of dashes drawn alternately left→right and right→left, so every travel
 * inside it is a short diagonal over blank paper AT THAT STRIP'S LIFT. Where
 * the lift does not clear, the pen drags and a zigzag joins the dash ends.
 *
 * Read per cell: the last clean strip is the highest pulse (smallest lift)
 * that clears there — that cell's clearance threshold. Entering those per
 * cell gives the clearance map; the driver interpolates between cells.
 */
export function liftGrid(base: PenDef | undefined, o: LiftGridOpts): Diagnostic {
  const pens: PenDef[] = [pen('lift-frame', base?.feed ?? 3000, base)];
  const servo: (ServoOverride | undefined)[] = [undefined];
  for (const p of o.pulses) {
    pens.push(pen(`lift-${p}`, base?.feed ?? 3000, base));
    servo.push({ up: p });
  }
  const chains: Chain[] = [];
  const margin = 8;
  const cw = (o.bedW - 2 * margin) / o.cols;
  const ch = (o.bedH - 2 * margin) / o.rows;
  const pad = Math.min(cw, ch) * 0.12;
  const fw = cw - 2 * pad;
  const fh = ch - 2 * pad;
  const sw = fw / o.pulses.length;
  const dashes = Math.max(3, Math.min(6, Math.floor(fh / 4)));
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      const x0 = margin + c * cw + pad;
      const y0 = margin + r * ch + pad;
      chains.push({
        pen: 0,
        pts: [[x0, y0], [x0 + fw, y0], [x0 + fw, y0 + fh], [x0, y0 + fh], [x0, y0]],
      });
      o.pulses.forEach((_, k) => {
        const sx0 = x0 + k * sw + sw * 0.2;
        const sx1 = x0 + (k + 1) * sw - sw * 0.2;
        const g = fh / (dashes + 1);
        for (let i = 0; i < dashes; i++) {
          const y = y0 + (i + 1) * g;
          chains.push({ pen: k + 1, pts: i % 2 ? [[sx1, y], [sx0, y]] : [[sx0, y], [sx1, y]] });
        }
      });
    }
  }
  return { plan: encode(chains), pens, servo };
}

export interface SettleLiftOpts {
  /** Lift pulses (SC,4), one column each. */
  pulses: number[];
  /** Settle delays (ms), one row each. */
  settles: number[];
}

/**
 * Settle × lift — how much settle does each lift need? Columns are lift
 * pulses, rows are settle delays. Each cell has three long-travel dashes
 * (spread apart) above six tight ones, both alternating direction. Travel
 * into and inside a cell is at that column's lift; the landing settle is
 * that row's. A too-short settle shows as dashes missing their first
 * millimetre. The lowest clean row per column is settle(lift) — the curve
 * the time model needs to price variable lift. Footprint ≈ 22mm × columns
 * by 30mm × rows from the origin.
 */
export function settleLift(base: PenDef | undefined, o: SettleLiftOpts): Diagnostic {
  const pens: PenDef[] = [];
  const servo: (ServoOverride | undefined)[] = [];
  const chains: Chain[] = [];
  const cellW = 22;
  const cellH = 30;
  o.settles.forEach((settle, r) => {
    o.pulses.forEach((p, c) => {
      const idx = pens.length;
      pens.push({ ...pen(`settle-${settle}-lift-${p}`, base?.feed ?? 3000, base), penDelay: settle });
      servo.push({ up: p });
      const x0 = 4 + c * cellW;
      const y0 = 4 + r * cellH;
      const x1 = x0 + cellW - 6;
      // sparse: three dashes 8mm apart
      for (let i = 0; i < 3; i++) {
        const y = y0 + i * 8;
        chains.push({ pen: idx, pts: i % 2 ? [[x1, y], [x0, y]] : [[x0, y], [x1, y]] });
      }
      // dense: six dashes 1.2mm apart
      for (let i = 0; i < 6; i++) {
        const y = y0 + 18 + i * 1.2;
        chains.push({ pen: idx, pts: i % 2 ? [[x1, y], [x0, y]] : [[x0, y], [x1, y]] });
      }
    });
  });
  return { plan: encode(chains), pens, servo };
}

export interface DownSweepOpts {
  /** Pen-down pulses (SC,5) to try, one hatch patch each, ascending. */
  pulses: number[];
}

/**
 * Down sweep — at which pen-down pulse does the horn fully release the pen?
 * One tightly hatched patch per pulse, left → right. While the horn still
 * carries part of the pen's weight the lines go faint or skip; the first
 * fully solid patch is the down pulse, and the last patch that is NOT
 * solid marks the horn's engagement. Travel is at full lift. Footprint
 * ≈ 20mm × patches by 18mm from the origin.
 */
export function downSweep(base: PenDef | undefined, o: DownSweepOpts): Diagnostic {
  const pens: PenDef[] = [];
  const servo: (ServoOverride | undefined)[] = [];
  const chains: Chain[] = [];
  o.pulses.forEach((p, c) => {
    pens.push(pen(`down-${p}`, base?.feed ?? 3000, base));
    servo.push({ down: p });
    const x0 = 4 + c * 20;
    const x1 = x0 + 15;
    for (let i = 0; i < 19; i++) {
      const y = 4 + i * 0.8;
      chains.push({ pen: c, pts: i % 2 ? [[x1, y], [x0, y]] : [[x0, y], [x1, y]] });
    }
  });
  return { plan: encode(chains), pens, servo };
}

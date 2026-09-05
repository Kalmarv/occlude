/**
 * The pen-height map: for every cell of the bed, the highest lift pulse
 * (SC,4 — LOWER pulse = MORE lift on the iDraw) at which a raised pen still
 * clears the paper, read off the lift-grid card in PULSE units. Nothing here
 * is in millimetres. A travel between two points takes the smallest lift
 * that clears everywhere along it, minus a margin.
 *
 * Cells the card could not resolve (clean at every rung) are `null` and
 * count as `unresolvedAbove` — the top of the ladder they were plotted
 * with. A refinement pass with a higher ladder fills them in.
 */

export interface LiftMap {
  /** Grid the card was laid out with (row-major thresholds, row 0 nearest the origin). */
  cols: number;
  rows: number;
  /** Bed extent and edge margin the card used, paper mm — cell centres follow. */
  bedW: number;
  bedH: number;
  margin: number;
  /** Last clean pulse per cell; null = clean at every rung → ≥ unresolvedAbove. */
  thresholds: (number | null)[];
  unresolvedAbove: number;
}

export interface CellGeometry {
  cols: number;
  rows: number;
  bedW: number;
  bedH: number;
  margin: number;
}

/** Centre of cell (r, c) in paper mm — the lift grid's layout, one place. */
export function cellCentre(g: CellGeometry, r: number, c: number): [number, number] {
  const cw = (g.bedW - 2 * g.margin) / g.cols;
  const ch = (g.bedH - 2 * g.margin) / g.rows;
  return [g.margin + (c + 0.5) * cw, g.margin + (r + 0.5) * ch];
}

/**
 * Build a map from the card as it is read off the paper: per cell, the
 * number of diagonals (= the number of ladder rungs, from the least lift
 * up, that dragged). `ladder` ascending = most lift first, as plotted.
 * n diagonals → the last clean rung is ladder[len-1-n]; n = 0 → unresolved;
 * n = len → every rung failed → one rung below the ladder, flagged low.
 */
export function liftMapFromCounts(
  counts: number[][],
  ladder: number[],
  g: CellGeometry,
): LiftMap {
  if (counts.length !== g.rows || counts.some((row) => row.length !== g.cols)) {
    throw new Error(`lift map: expected ${g.rows} rows × ${g.cols} counts, got ${counts.length} rows of ${counts.map((r) => r.length).join('/')}`);
  }
  const rung = ladder.length > 1 ? ladder[1] - ladder[0] : 0;
  const thresholds: (number | null)[] = [];
  for (const row of counts) {
    for (const n of row) {
      if (n <= 0) thresholds.push(null);
      else if (n >= ladder.length) thresholds.push(ladder[0] - rung);
      else thresholds.push(ladder[ladder.length - 1 - n]);
    }
  }
  return { ...g, thresholds, unresolvedAbove: ladder[ladder.length - 1] };
}

/** Fill unresolved cells from a refinement pass plotted with a higher ladder;
 * resolved cells are left alone. `counts` may cover only the unresolved
 * cells (others ignored) but must have the map's shape. */
export function refineLiftMap(map: LiftMap, counts: number[][], ladder: number[]): LiftMap {
  const fresh = liftMapFromCounts(counts, ladder, map);
  const thresholds = map.thresholds.map((t, i) => (t === null ? fresh.thresholds[i] : t));
  return { ...map, thresholds, unresolvedAbove: Math.max(map.unresolvedAbove, fresh.unresolvedAbove) };
}

/** Effective threshold of a cell: unresolved counts as the ladder top. */
function cellValue(map: LiftMap, r: number, c: number): number {
  const rr = Math.min(map.rows - 1, Math.max(0, r));
  const cc = Math.min(map.cols - 1, Math.max(0, c));
  return map.thresholds[rr * map.cols + cc] ?? map.unresolvedAbove;
}

/** Bilinear threshold at a paper point; outside the grid the edge cells extend. */
export function liftAt(map: LiftMap, x: number, y: number): number {
  const cw = (map.bedW - 2 * map.margin) / map.cols;
  const ch = (map.bedH - 2 * map.margin) / map.rows;
  const u = (x - map.margin) / cw - 0.5; // in cell-centre units
  const v = (y - map.margin) / ch - 0.5;
  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const fu = Math.min(1, Math.max(0, u - c0));
  const fv = Math.min(1, Math.max(0, v - r0));
  const a = cellValue(map, r0, c0);
  const b = cellValue(map, r0, c0 + 1);
  const d = cellValue(map, r0 + 1, c0);
  const e = cellValue(map, r0 + 1, c0 + 1);
  return (a * (1 - fu) + b * fu) * (1 - fv) + (d * (1 - fu) + e * fu) * fv;
}

/**
 * The lift pulse for a travel: the smallest threshold sampled along the
 * segment (ends plus every half cell), less `marginPulses`, never more lift
 * than `fullUpPulse` (the mechanism's limit) — lower pulse = more lift, so
 * the result is clamped from below.
 */
export function liftForTravel(
  map: LiftMap,
  from: [number, number],
  to: [number, number],
  marginPulses: number,
  fullUpPulse: number,
): number {
  const cell = Math.min((map.bedW - 2 * map.margin) / map.cols, (map.bedH - 2 * map.margin) / map.rows);
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const n = Math.max(1, Math.ceil(len / (cell / 2)));
  let min = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const v = liftAt(map, from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
    if (v < min) min = v;
  }
  return Math.round(Math.max(fullUpPulse, min - marginPulses));
}

/** Parse the card as typed: rows of counts separated by newlines, dashes or
 * semicolons; counts by commas or spaces. */
export function parseCounts(text: string): number[][] {
  return text
    .split(/[\n;]|\s-\s/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/[\s,]+/).filter(Boolean).map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0) throw new Error(`lift map: bad count "${s}"`);
      return n;
    }));
}

// ---- settle by lift ----------------------------------------------------------

/** One reading off the settle×lift card: at this lift pulse, the shortest
 * settle (ms) that landed clean. */
export interface SettlePoint {
  pulse: number;
  ms: number;
}

/**
 * Everything the pen-cycle needs to know about lifting on one machine: the
 * mechanism's full lift, the clearance map (absent = full lift everywhere),
 * the margin below each cell's last-clean pulse, and the settle curve
 * (absent = the pen's penDelay at every lift).
 */
export interface LiftModel {
  penUpPulse: number;
  map?: LiftMap;
  marginPulses: number;
  settleCurve?: SettlePoint[];
}

/** The lift pulse for a travel under this model: from the map, else full. */
export function travelLiftPulse(m: LiftModel, from: [number, number], to: [number, number]): number {
  if (!m.map) return Math.round(m.penUpPulse);
  return liftForTravel(m.map, from, to, m.marginPulses, Math.round(m.penUpPulse));
}

/** Piecewise-linear settle curve, clamped at both ends. */
export function curveMs(curve: SettlePoint[], pulse: number): number {
  const pts = [...curve].sort((a, b) => a.pulse - b.pulse);
  if (pts.length === 0) throw new Error('settle curve: no points');
  if (pulse <= pts[0].pulse) return pts[0].ms;
  if (pulse >= pts[pts.length - 1].pulse) return pts[pts.length - 1].ms;
  for (let i = 1; i < pts.length; i++) {
    if (pulse <= pts[i].pulse) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = (pulse - a.pulse) / (b.pulse - a.pulse);
      return a.ms + (b.ms - a.ms) * t;
    }
  }
  return pts[pts.length - 1].ms;
}

/** Hard physical floor: below this the servo has not moved at all (ms). */
export const SETTLE_FLOOR_MS = 150;

/**
 * THE settle for one pen cycle at one lift — driver and estimator both call
 * this, so there is one clock. The pen's penDelay is its settle at FULL
 * lift; the curve scales it down for smaller lifts (a wetter or heavier pen
 * keeps its own tuning, in proportion). No curve: penDelay at every lift.
 */
export function settleAtLift(penDelay: number, pulse: number, m: LiftModel): number {
  const full = Math.max(penDelay, SETTLE_FLOOR_MS);
  if (!m.settleCurve || m.settleCurve.length === 0) return full;
  const ref = curveMs(m.settleCurve, m.penUpPulse);
  if (ref <= 0) return full;
  const scaled = full * (curveMs(m.settleCurve, pulse) / ref);
  return Math.max(SETTLE_FLOOR_MS, Math.round(scaled));
}

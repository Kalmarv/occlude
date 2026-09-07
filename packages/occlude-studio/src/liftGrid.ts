/**
 * The lift map as a grid you can look at and edit: one cell per map cell,
 * its threshold, the travel lift the driver will actually use there, and a
 * heat value for colouring. Pure — the Machine page renders it and writes
 * edits back into the active profile.
 *
 * Units: EBB servo pulses (SC,4). On the iDraw a LOWER pulse is a HIGHER
 * horn, so a lower threshold means the cell needs more lift. There is no
 * measured pulse-to-millimetre figure for the horn, so the map's natural
 * step is the ladder rung the card was plotted with (800 by default): a pen
 * that drags in a cell wants that cell one rung lower.
 */
import type { LiftMap } from 'occlude';

/** One rung of the default ladder — the step the ± buttons take. */
export const RUNG = 800;

export interface LiftCell {
  r: number;
  c: number;
  /** Last clean pulse, or null = clean at every rung (≥ unresolvedAbove). */
  threshold: number | null;
  /** What the cell counts as: its threshold, or the ladder top when unresolved. */
  value: number;
  /** The lift the driver travels at through this cell: value − margin, never
   * more lift than the mechanism's full-up pulse. */
  travel: number;
  /** 0 = the cell needing the least lift in this map, 1 = the most. */
  heat: number;
}

/** The map, cell by cell, row-major (row 0 nearest the bed origin). */
export function liftCells(map: LiftMap, marginPulses: number, fullUpPulse: number): LiftCell[] {
  const values = map.thresholds.map((t) => t ?? map.unresolvedAbove);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  return map.thresholds.map((threshold, i) => {
    const value = values[i];
    return {
      r: Math.floor(i / map.cols),
      c: i % map.cols,
      threshold,
      value,
      travel: Math.round(Math.max(fullUpPulse, value - marginPulses)),
      heat: span > 0 ? (hi - value) / span : 0,
    };
  });
}

/** A copy of the map with one cell's threshold replaced (null = unresolved). */
export function setCellThreshold(map: LiftMap, r: number, c: number, threshold: number | null): LiftMap {
  if (r < 0 || r >= map.rows || c < 0 || c >= map.cols) {
    throw new Error(`lift map: no cell ${r},${c} in a ${map.cols}×${map.rows} map`);
  }
  if (threshold !== null && !Number.isFinite(threshold)) throw new Error('lift map: threshold must be a number');
  const thresholds = map.thresholds.slice();
  thresholds[r * map.cols + c] = threshold === null ? null : Math.round(threshold);
  return { ...map, thresholds };
}

/** Move one cell by `delta` pulses; an unresolved cell starts from the ladder top. */
export function nudgeCell(map: LiftMap, r: number, c: number, delta: number): LiftMap {
  const current = map.thresholds[r * map.cols + c] ?? map.unresolvedAbove;
  return setCellThreshold(map, r, c, current + delta);
}

/**
 * The two pulses a single-cell check plots, most lift first: the travel lift
 * the driver will use there (should be clean) and the cell's own threshold
 * (the last clean rung — the margin between them is the safety). Equal when
 * the margin has run into the mechanism's full lift.
 */
export function cellTestPulses(cell: LiftCell): number[] {
  return cell.travel === cell.value ? [cell.travel] : [cell.travel, cell.value];
}

/** CSS colour for a heat value: cool where little lift is needed, warm where much. */
export function heatColour(heat: number): string {
  const h = 205 - 185 * Math.min(1, Math.max(0, heat));
  return `hsl(${h.toFixed(0)} 55% 62%)`;
}

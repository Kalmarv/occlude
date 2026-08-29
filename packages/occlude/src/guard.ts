/**
 * Live-coding guards. The editor re-renders on every keystroke, so sketches
 * execute mid-edit transients — `STEP = 0.0` on the way to `0.05` turns a
 * count into Infinity and a spacing into zero. Fail fast with a message the
 * status bar can show instead of freezing the tab allocating an infinite
 * grid.
 */

import { Len } from './units.js';

/** Most repetitions any single combinator may produce. */
export const MAX_REPEAT = 100_000;

/** Validate a repetition count: finite, capped, floored to an integer. */
export function finiteCount(name: string, n: number): number {
  if (!Number.isFinite(n)) {
    throw new Error(`${name}: count is ${n} — check for a zero step or divisor`);
  }
  if (n > MAX_REPEAT) {
    throw new Error(
      `${name}: ${Math.floor(n)} repetitions exceeds the ${MAX_REPEAT} cap`,
    );
  }
  return Math.floor(n);
}

/** Validate an optional length used as a spacing/step: finite and > 0. */
export function positiveLength(name: string, l: number | Len | undefined): void {
  if (l === undefined) return;
  const value = typeof l === 'number' ? l : l.value;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name}: spacing must be a positive length, got ${value}`);
  }
}

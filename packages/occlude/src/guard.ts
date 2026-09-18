/**
 * Live-coding guards. The editor re-renders on every keystroke, so sketches
 * execute mid-edit transients — `STEP = 0.0` on the way to `0.05` turns a
 * count into Infinity and a spacing into zero. A transient like that is a
 * degenerate input, not a mistake: the piece draws nothing and the sketch
 * keeps rendering. Only the repetition cap still throws, because it is the
 * one that stops the tab freezing on an infinite grid.
 */

import { Len } from './units.js';

/** Most repetitions any single combinator may produce. */
export const MAX_REPEAT = 100_000;

/** A repetition count: capped, floored to an integer. A count that cannot
 * be walked — NaN, ±Infinity, or below one — is zero repetitions, so a zero
 * step or divisor draws nothing instead of failing the sketch. */
export function finiteCount(name: string, n: number): number {
  if (!Number.isFinite(n) || n < 1) return 0;
  if (n > MAX_REPEAT) {
    throw new Error(
      `${name}: ${Math.floor(n)} repetitions exceeds the ${MAX_REPEAT} cap`,
    );
  }
  return Math.floor(n);
}

/** Can an optional length be used as a spacing/step? Absent (the caller's
 * default applies) or a finite length above zero. A spacing at or below zero
 * yields no samples — the one rule behind sample, scatter, settle, the
 * fills, ridges, isolines and streamlines. */
export function usableLength(l: number | Len | undefined): boolean {
  if (l === undefined) return true;
  const value = typeof l === 'number' ? l : l.value;
  return Number.isFinite(value) && value > 0;
}

/** A per-sample value from a user field, or `fallback` where the field does
 * not answer with a finite number. One bad sample degrades that sample, not
 * the drawing. */
export function valueAt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

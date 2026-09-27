/**
 * Live-coding guards. The editor re-renders on every keystroke, so sketches
 * execute mid-edit transients — `STEP = 0.0` on the way to `0.05` turns a
 * count into Infinity and a spacing into zero. A transient like that is a
 * degenerate input, not a mistake: the piece draws nothing and the sketch
 * keeps rendering. Only the repetition cap still throws, because it is the
 * one that stops the tab freezing on an infinite grid.
 */

import { Len } from './units.js';
import type { XY } from './vec.js';

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

/** @internal Is this argument a POINT — a pair or an `{ x, y }` record —
 * rather than a number or a length? A word with a point form (a shape
 * word, an `sdf.*` word) decides its form by the first argument. Any other
 * object is refused by name: it is neither a point nor a length. */
export function isPointArg(v: unknown, who: string): v is XY {
  if (Array.isArray(v)) return true;
  if (typeof v !== 'object' || v === null || v instanceof Len) return false;
  const p = v as { x?: unknown; y?: unknown };
  if (typeof p.x === 'number' && typeof p.y === 'number') return true;
  throw new Error(`${who}: this object is not a point — give [x, y] or { x, y } with numbers`);
}

/**
 * A drawn remap of the unit range: the tone curve from image editors, as a
 * value. `shaper(points)` takes knots on the unit square and returns a
 * function 0–1 → 0–1 through them — lift the middle and midtones brighten,
 * pull the ends in and it clips, an S adds contrast. Generic: a field's
 * contrast, an easing for a sweep, the spacing of streamlines by tone.
 *
 * The knots are a literal in the sketch; the studio gives that literal a
 * curve editor the way `ui()` gives numbers a slider, and every drag
 * rewrites the array in the code, so the sketch stays the spec.
 *
 * Interpolation is commons-math-interpolation (MIT): Akima by default (the
 * tone-curve standard — local, no ringing), with cubic and linear on
 * request; fewer knots than a method needs fall back to a simpler one.
 */

import { createInterpolatorWithFallback, type InterpolationMethod } from 'commons-math-interpolation';

export type ShaperPoint = [number, number];

export interface ShaperOpts {
  /** 'akima' (default), 'cubic', or 'linear'. */
  method?: 'akima' | 'cubic' | 'linear';
}

export type Shaper = ((v: number) => number) & {
  /** The knots, sorted by x — what the editor edits. */
  readonly points: readonly ShaperPoint[];
  readonly method: 'akima' | 'cubic' | 'linear';
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function shaper(points: readonly ShaperPoint[], opts: ShaperOpts = {}): Shaper {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('shaper: at least two [x, y] points');
  }
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      throw new Error('shaper: points are [x, y] numbers');
    }
  }
  const sorted: ShaperPoint[] = [...points]
    .map(([x, y]) => [clamp01(x), clamp01(y)] as ShaperPoint)
    .sort((a, b) => a[0] - b[0]);
  // Strictly increasing x: nudge exact duplicates apart rather than throw —
  // a knot dragged onto another mid-edit must not blank the sketch.
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] <= sorted[i - 1][0]) sorted[i][0] = Math.min(1, sorted[i - 1][0] + 1e-6);
  }
  const method = opts.method ?? 'akima';
  const interp = createInterpolatorWithFallback(
    method as InterpolationMethod,
    sorted.map((p) => p[0]),
    sorted.map((p) => p[1]),
  );
  const x0 = sorted[0][0];
  const x1 = sorted[sorted.length - 1][0];
  const fn = ((v: number): number => {
    if (!Number.isFinite(v)) return NaN;
    const x = v < x0 ? x0 : v > x1 ? x1 : v;
    return clamp01(interp(x));
  }) as Shaper;
  Object.defineProperty(fn, 'points', { value: sorted, enumerable: true });
  Object.defineProperty(fn, 'method', { value: method, enumerable: true });
  return fn;
}

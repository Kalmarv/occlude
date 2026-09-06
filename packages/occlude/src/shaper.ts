/**
 * A drawn remap: the tone curve from image editors, as a value.
 * `shaper(points)` takes knots and returns a function through them. The
 * knots define the area: the input runs from the first knot's x to the
 * last's, the output stays between the lowest and highest knot — so
 * `[[0, 0], [1, 1]]` is a unit tone curve, `[[0, 0.65], [1, 3.75]]` turns a
 * 0–1 luminance straight into millimetres, and `[[0, 0], [2, 2]]` is an
 * identity over 0–2. Lift the middle and midtones rise, flatten an end and
 * it clips, an S adds contrast. Generic: a field's contrast, an easing for
 * a sweep, the spacing of streamlines by tone.
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
  /** The area, `[[x0, y0], [x1, y1]]`: the input runs x0–x1 and the output
   * is clamped to y0–y1, whatever the knots do. Without it the knots' own
   * span is the area — which moves when a knot at an edge moves; give the
   * area explicitly when the box should stay put (the studio's editor
   * draws it as the box). */
  bounds?: [[number, number], [number, number]];
}

export type Shaper = ((v: number) => number) & {
  /** The knots, sorted by x — what the editor edits. */
  readonly points: readonly ShaperPoint[];
  readonly method: 'akima' | 'cubic' | 'linear';
  /** Input extent: first knot's x to last knot's x. */
  readonly domain: readonly [number, number];
  /** Output extent: lowest to highest knot y — the curve never leaves it. */
  readonly range: readonly [number, number];
};

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
    .map(([x, y]) => [x, y] as ShaperPoint)
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
  let x0 = sorted[0][0];
  let x1 = sorted[sorted.length - 1][0];
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, y] of sorted) {
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  if (opts.bounds) {
    const [[bx0, by0], [bx1, by1]] = opts.bounds;
    if (![bx0, by0, bx1, by1].every(Number.isFinite) || bx1 <= bx0 || by1 <= by0) {
      throw new Error('shaper: bounds are [[x0, y0], [x1, y1]] with x1 > x0 and y1 > y0');
    }
    x0 = bx0;
    x1 = bx1;
    lo = by0;
    hi = by1;
  }
  // Inputs outside the knots hold the end knots' values (the interpolator
  // is not asked to extrapolate); outputs stay within the range.
  const kx0 = sorted[0][0];
  const kx1 = sorted[sorted.length - 1][0];
  const fn = ((v: number): number => {
    if (!Number.isFinite(v)) return NaN;
    const c = v < x0 ? x0 : v > x1 ? x1 : v;
    const x = c < kx0 ? kx0 : c > kx1 ? kx1 : c;
    const y = interp(x);
    return y < lo ? lo : y > hi ? hi : y;
  }) as Shaper;
  Object.defineProperty(fn, 'points', { value: sorted, enumerable: true });
  Object.defineProperty(fn, 'method', { value: method, enumerable: true });
  Object.defineProperty(fn, 'domain', { value: [x0, x1], enumerable: true });
  Object.defineProperty(fn, 'range', { value: [lo, hi], enumerable: true });
  return fn;
}

/**
 * The escape-time field as a field: the artist's own map, iterated per
 * sample, answered as a plain `(x, y) => number` — `t.isolines`,
 * `t.within` and `t.scatter` read it with no change to those words. The
 * Mandelbrot and Julia families are two-line recipes the sketch writes;
 * this module names neither. Pure: same input, same double, no randomness.
 */

import type { FieldFn } from './shapes.js';
import { asXY, type Vec, type XY } from './vec.js';

/** The artist's map: one iteration, pairs in and a fresh pair out. */
export type EscapeStep = (z: Vec, c: Vec) => Vec;

export type EscapeOpts = {
  /** The maximum count of iterations per sample. */
  iterations: number;
  /** The escape radius: an orbit is out once `|z|` passes it, so it must
   * sit above 1 for the log-log normalisation to mean anything. */
  bailout: number;
  /** The map's degree — what the smooth count's log-log divides by.
   * Default 2, the quadratic family's. */
  degree?: number;
} & (
  | {
    /** The input point IS `c`; `z` starts at `z0`. */
    input: 'c';
    /** Where `z` starts under `input: 'c'`. Default `[0, 0]`. */
    z0?: XY;
  }
  | {
    /** The input point IS `z`; `c` is the fixed parameter. */
    input: 'z';
    /** The fixed `c` of the iteration under `input: 'z'`. */
    c: XY;
  }
);

/** The escape field, called: the smooth iteration count. `potential` is
 * the same iteration read the other way. */
export interface EscapeField {
  (x: number, y: number): number;
  /** The potential, `log|z| / degree^n` — a field of the same iteration.
   * Give it a LARGE `bailout`: across the escape step it jumps by
   * `log(R²/|z*² + c|)/degree^(n+1)`, about `|c|/R²` — half a contour
   * spacing at `R = 4`, about 1e-12 at `R = 1e6`. */
  readonly potential: FieldFn;
}

/**
 * `step` iterated from each sample until `|z|` passes `bailout` or
 * `iterations` run out. The field answers with the SMOOTH iteration count
 * `n + 1 − log(log|z|)/log(degree)`, so contours flow across iteration
 * boundaries instead of stepping a whole unit; `.potential` answers with
 * `log|z| / degree^n`.
 *
 * THE NEVER-ESCAPES RULE: a point that exhausts `iterations` still inside
 * the bailout answers `NaN`, in both accessors. `NaN` is what every
 * consumer of a field already reads as "not a place" (a `within` bound
 * makes a field absent outside, `isolines` truncates at absence,
 * `scatter` finds no density), while the iteration cap would be a finite
 * value that moves whenever the artist retunes `iterations` — and would
 * make `scatter` fill the set's interior at full density. Deterministic
 * either way: a pure function of the inputs.
 *
 * `input: 'c'` runs the point as `c` from `z0` (the Mandelbrot-style
 * family); `input: 'z'` runs it as `z` against the fixed `c` (the
 * Julia-style family). Both are the sketch's own recipe.
 */
export function escape(step: EscapeStep, opts: EscapeOpts): EscapeField {
  const degree = opts.degree ?? 2;
  const logDegree = Math.log(degree);
  const iterations = opts.iterations;
  const b2 = opts.bailout * opts.bailout;
  const inputIsC = opts.input === 'c';
  // Read once, at build: `z0` exists only on the 'c' spelling, `c` only
  // on the 'z' one, and the sample below just reads the two it needs.
  const z0: Vec = opts.input === 'c' ? (opts.z0 !== undefined ? asXY(opts.z0) : [0, 0]) : [0, 0];
  const fixedC: Vec = opts.input === 'z' ? asXY(opts.c) : [0, 0];

  /** One sample: `smooth` picks the count or the potential — the same
   * orbit, so the two can never disagree about what escaped. */
  const sample = (x: number, y: number, smooth: boolean): number => {
    const c: Vec = inputIsC ? [x, y] : fixedC;
    let z: Vec = inputIsC ? z0 : [x, y];
    let n = 0;
    let r2 = z[0] * z[0] + z[1] * z[1];
    while (n < iterations && r2 <= b2) {
      z = step(z, c);
      n++;
      r2 = z[0] * z[0] + z[1] * z[1];
    }
    if (r2 <= b2) return Number.NaN; // never escaped: not a place
    const r = Math.sqrt(r2);
    return smooth
      ? n + 1 - Math.log(Math.log(r)) / logDegree
      : Math.log(r) / Math.pow(degree, n);
  };

  return Object.assign((x: number, y: number): number => sample(x, y, true), {
    potential: (x: number, y: number): number => sample(x, y, false),
  });
}

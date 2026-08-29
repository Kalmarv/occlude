/**
 * Fill specs. Fills are texture, not solid black. Built-ins are executed in
 * the Rust core; custom fills are plain functions run at render time and fed
 * through the normal occlusion path. A mask is opaque with zero ink — the
 * primitive of hidden-line rendering.
 */

import type { Prim } from './prims.js';
import { positiveLength } from './guard.js';
import { Len, mm, type L } from './units.js';

export interface HatchPassSpec {
  angle: number;
  /** mm (resolved). */
  spacing: L | undefined;
  offset: number;
}

export type FillSpec =
  | { type: 'hatch'; passes: HatchPassSpec[] }
  | { type: 'stipple'; density: number; minDist: L | undefined }
  | { type: 'custom'; fn: CustomFillFn }
  | { type: 'mask' };

/** The region handed to a custom fill, in paper mm. */
export interface FillRegion {
  bbox: { x: number; y: number; w: number; h: number };
  /** The actual outline: contours of exact primitives, paper mm. */
  path: Prim[][];
  /** Point-in-region test (respects the shape's winding rule). */
  contains(x: number, y: number): boolean;
  /** Region area in mm² (holes subtracted). */
  area: number;
}

/**
 * Custom fill: returns primitives in paper mm. They are clipped to the
 * region and occluded like everything else, so overshooting the boundary is
 * fine — `contains` is for generation efficiency, not correctness.
 */
export type CustomFillFn = (
  region: FillRegion,
  ctx: { penWidth: number; rnd: () => number },
) => CustomPrimitive[];

export type CustomPrimitive =
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'arc'; cx: number; cy: number; r: number; start: number; sweep: number }
  | {
      type: 'cubic';
      x1: number; y1: number;
      cx1: number; cy1: number;
      cx2: number; cy2: number;
      x2: number; y2: number;
    }
  /** Connected line run — one entry instead of n-1 line objects. */
  | { type: 'polyline'; pts: [number, number][] };

export interface HatchOptions {
  angle?: number;
  spacing?: L;
  offset?: number;
}

/** Parallel lines. Spacing defaults to 3× the fill pen's width (mm). */
export function hatch(angle?: number, spacing?: L, offset?: number): FillSpec;
export function hatch(opts: HatchOptions): FillSpec;
export function hatch(a: number | HatchOptions = 0, spacing?: L, offset = 0): FillSpec {
  positiveLength('hatch', typeof a === 'object' ? a.spacing : spacing);
  if (typeof a === 'object') {
    return {
      type: 'hatch',
      passes: [{ angle: a.angle ?? 0, spacing: a.spacing, offset: a.offset ?? 0 }],
    };
  }
  return { type: 'hatch', passes: [{ angle: a, spacing, offset }] };
}

export interface CrosshatchOptions {
  angles?: number[];
  spacing?: L;
  offset?: number;
}

/** n hatch passes. */
export function crosshatch(angles?: number[], spacing?: L, offset?: number): FillSpec;
export function crosshatch(opts: CrosshatchOptions): FillSpec;
export function crosshatch(
  a: number[] | CrosshatchOptions = [0, 90],
  spacing?: L,
  offset = 0,
): FillSpec {
  const opts: CrosshatchOptions = Array.isArray(a) ? { angles: a, spacing, offset } : a;
  positiveLength('crosshatch', opts.spacing);
  return {
    type: 'hatch',
    passes: (opts.angles ?? [0, 90]).map((angle) => ({
      angle,
      spacing: opts.spacing,
      offset: opts.offset ?? 0,
    })),
  };
}

export interface StippleOptions {
  density?: number;
  minDist?: L;
}

/** Poisson-disk dots. minDist defaults to 2× the fill pen's width (mm). */
export function stipple(density?: number, minDist?: L): FillSpec;
export function stipple(opts: StippleOptions): FillSpec;
export function stipple(a: number | StippleOptions = 0.5, minDist?: L): FillSpec {
  positiveLength('stipple', typeof a === 'object' ? a.minDist : minDist);
  if (typeof a === 'object') {
    return { type: 'stipple', density: a.density ?? 0.5, minDist: a.minDist };
  }
  return { type: 'stipple', density: a, minDist };
}

/** Wrap a custom fill function. `.fill(f)` also accepts the function directly. */
export function customFill(fn: CustomFillFn): FillSpec {
  return { type: 'custom', fn };
}

/** Default hatch spacing for a pen: 3× nib width, in mm. */
export function defaultHatchSpacing(penWidth: number): Len {
  return mm(3 * penWidth);
}

/** Default stipple min distance for a pen: 2× nib width, in mm. */
export function defaultStippleMinDist(penWidth: number): Len {
  return mm(2 * penWidth);
}

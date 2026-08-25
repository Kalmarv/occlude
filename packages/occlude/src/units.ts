/**
 * Units. A bare number is percent of the short side of the drawable area
 * (inside the margin). Tagged wrappers resolve at render time, when paper is
 * known — sketches stay paper-independent.
 */

export type UnitKind = 'short' | 'w' | 'h' | 'long' | 'mm';

export class Len {
  constructor(
    readonly kind: UnitKind,
    readonly value: number,
  ) {}
}

/** Anything accepted as a length/coordinate. */
export type L = number | Len;

/** Percent of drawable width. */
export const w = (n: number): Len => new Len('w', n);
/** Percent of drawable height. */
export const h = (n: number): Len => new Len('h', n);
/**
 * Percent of the long side ("scale"): isotropic, so it works for sizes AND
 * coordinates — s(100) spans the long axis; the short axis ends at
 * s(100 × short/long).
 */
export const s = (n: number): Len => new Len('long', n);
/** Alias of `s(n)`. */
export const long = (n: number): Len => new Len('long', n);
/** Real millimetres — for anything physical. */
export const mm = (n: number): Len => new Len('mm', n);

/** Resolution context: the drawable (inner) area in mm. */
export interface UnitCtx {
  innerW: number;
  innerH: number;
}

export function resolveLen(v: L, ctx: UnitCtx): number {
  if (typeof v === 'number') {
    return (v / 100) * Math.min(ctx.innerW, ctx.innerH);
  }
  switch (v.kind) {
    case 'short':
      return (v.value / 100) * Math.min(ctx.innerW, ctx.innerH);
    case 'w':
      return (v.value / 100) * ctx.innerW;
    case 'h':
      return (v.value / 100) * ctx.innerH;
    case 'long':
      return (v.value / 100) * Math.max(ctx.innerW, ctx.innerH);
    case 'mm':
      return v.value;
  }
}

/** 2D affine transforms: [a c e; b d f; 0 0 1]. */

export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function mul(m: Mat, n: Mat): Mat {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function translate(x: number, y: number): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function rotate(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

export function scale(sx: number, sy: number): Mat {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** True when the transform preserves circles (uniform scale + rotation). */
export function isConformal(m: Mat): boolean {
  // Columns must be orthogonal and equal length.
  const dot = m.a * m.c + m.b * m.d;
  const l1 = m.a * m.a + m.b * m.b;
  const l2 = m.c * m.c + m.d * m.d;
  return Math.abs(dot) < 1e-12 && Math.abs(l1 - l2) < 1e-9 * Math.max(l1, l2, 1e-12);
}

/** Uniform scale factor (valid when conformal). */
export function conformalScale(m: Mat): number {
  return Math.hypot(m.a, m.b);
}

/** Signed determinant — negative means the transform flips orientation. */
export function det(m: Mat): number {
  return m.a * m.d - m.b * m.c;
}

/** Inverse affine. A singular matrix (zero scale) inverts to the identity
 * rather than NaN — a degenerate use samples somewhere, not nowhere. */
export function invert(m: Mat): Mat {
  const D = det(m);
  if (!(Math.abs(D) > 1e-18) || !Number.isFinite(D)) return IDENTITY;
  const a = m.d / D;
  const b = -m.b / D;
  const c = -m.c / D;
  const d = m.a / D;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

/** Smallest singular value of the linear part: the tightest factor by
 * which the map shrinks any direction. */
export function minScale(m: Mat): number {
  const S = m.a * m.a + m.b * m.b + m.c * m.c + m.d * m.d;
  const D = det(m);
  const disc = Math.max(0, S * S - 4 * D * D);
  return Math.sqrt(Math.max(0, (S - Math.sqrt(disc)) / 2));
}

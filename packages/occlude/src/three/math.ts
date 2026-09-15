/** Anonymous world/camera vertices; no paper-unit interpretation. */
export type Vec3 = readonly [number, number, number];
export type Triangle3 = readonly [Vec3, Vec3, Vec3];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => add3(mul3(a, 1 - t), mul3(b, t));
export function finite3(v: Vec3): void {
  if (v.length !== 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) throw new Error('3D coordinates must be finite triples');
}
export function unit3(v: Vec3): Vec3 {
  const length = Math.hypot(...v);
  if (!(length > 0) || !Number.isFinite(length)) throw new Error('3D direction must have finite nonzero length');
  return mul3(v, 1 / length);
}

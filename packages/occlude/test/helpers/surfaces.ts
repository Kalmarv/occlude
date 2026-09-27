import { expect } from 'vitest';
import { Material } from '../../src/material.js';
import { parametricCurve } from '../../src/three/api/index.js';
import { surface3, type Surface3 } from '../../src/three/geometry/surface.js';
import { surfaceOf } from '../../src/three/geometry/value.js';
import { cross3, dot3, sub3, type Vec3 } from '../../src/three/math.js';

/** A flat grid of `columns × rows` quads, `size` across and centred on the
 * origin, as a raw `Surface3`: the fixture the kernel tests build their
 * inputs from. A sketch builds the same sheet with `plane().subdivide()`. */
export function gridSurface(columns: number, rows: number, size: readonly [number, number] = [1, 1]): Surface3 {
  const positions: Vec3[] = [], faces: number[][] = [];
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) positions.push([(x / columns - 0.5) * size[0], (y / rows - 0.5) * size[1], 0]);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) { const p = y * (columns + 1) + x; faces.push([p, p + 1, p + columns + 2, p + columns + 1]); }
  return surface3(positions, faces);
}

/** A circle of radius `r` in the XY plane, centred on the origin, as a
 * closed 3D curve: the profile the construction tests sweep and revolve,
 * written with the public words. */
export const circle3 = (r = 1, options: { segments?: number; key?: string } = {}): Material =>
  parametricCurve((u) => [r * Math.cos(2 * Math.PI * u), r * Math.sin(2 * Math.PI * u), 0], { ...options, closed: true });

/** The signed volume a closed surface encloses (divergence theorem over its
 * triangles): positive when the faces wind outward. Takes a 3D value or a
 * raw `Surface3`. */
export function volume(source: Material | Surface3): number {
  const s = source instanceof Material ? surfaceOf(source) : source;
  let total = 0;
  for (const t of s.triangles) {
    const [a, b, c] = t.vertices.map((i) => s.points[i].position);
    total += dot3(a, cross3(b, c)) / 6;
  }
  return total;
}

/** Assert that `m` is a closed, consistently wound, non-degenerate
 * manifold that encloses a positive volume, and — when `chi` is given —
 * that its Euler characteristic (V − E + F) is `chi`. Answers the volume. */
export function manifold(m: Material, chi?: number): number {
  const s = surfaceOf(m);
  expect(s.edges.every((e) => e.faces.length === 2)).toBe(true);
  if (chi !== undefined) expect(m.points.length - m.edges.length + m.faces.length).toBe(chi);
  // every edge is walked once each way by the faces beside it
  const directions = new Map<string, number>();
  for (const f of s.faces) for (let i = 0; i < f.vertices.length; i++) {
    const a = f.vertices[i], b = f.vertices[(i + 1) % f.vertices.length], key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    directions.set(key, (directions.get(key) ?? 0) + (a < b ? 1 : -1));
  }
  expect([...directions.values()].every((n) => n === 0)).toBe(true);
  for (const t of s.triangles) {
    const [a, b, c] = t.vertices.map((i) => s.points[i].position);
    expect(Math.hypot(...cross3(sub3(b, a), sub3(c, a)))).toBeGreaterThan(0);
  }
  const enclosed = volume(s);
  expect(enclosed).toBeGreaterThan(0);
  return enclosed;
}

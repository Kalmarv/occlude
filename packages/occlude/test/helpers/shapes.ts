/** Small 2D fixtures the material tests build their inputs from. */

import { curve, material, type Edge, type Material } from '../../src/index.js';

/** The closed square of side `s` with its low corner at (x, y), as one
 * ring; `columns` go to `curve` (one value per column: `{ age: 0 }`). */
export const square = (x = 0, y = 0, s = 10, columns: Record<string, number> = {}): Material =>
  curve([[x, y], [x + s, y], [x + s, y + s], [x, y + s]], { closed: true, ...columns });

/** One edge from `a` to `b`; `columns` go to `material`. */
export const seg = (a: [number, number], b: [number, number], columns: Record<string, number> = {}): Material =>
  material([a, b], { edges: [[0, 1]], ...columns });

/** Does `p` lie on the segment of `e` (to rounding)? */
export const onEdge = (p: { x: number; y: number }, e: Edge): boolean => {
  const ax = e.a.x; const ay = e.a.y; const bx = e.b.x; const by = e.b.y;
  const cross = (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax);
  const dot = (p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay);
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  return Math.abs(cross) / Math.sqrt(len2) < 1e-9 && dot >= -1e-9 && dot <= len2 + 1e-9;
};

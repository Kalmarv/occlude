/** Layout helpers. */

import { finiteCount } from './guard.js';
import { path, type Shape } from './shapes.js';
import { bounds, getState, noise } from './state.js';
import { Len, resolveLen, type L } from './units.js';

export interface GridCell {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cell centre — the point most stamps actually want. */
  cx: number;
  cy: number;
  i: number;
  j: number;
}

export interface GridOptions {
  cols: number;
  rows: number;
  /** Gap between cells, default units (percent of short side). */
  gap?: number;
}

/**
 * Cell rectangles covering the WHOLE drawable area, in bare units (percent
 * of the short side — the long axis runs past 100 on non-square drawables,
 * exactly like `bounds()`). Pass the values straight to shape functions.
 */
export function grid(opts: GridOptions): GridCell[] {
  const { cols, rows, gap = 0 } = opts;
  finiteCount('grid', cols * rows);
  const b = bounds();
  const cells: GridCell[] = [];
  const cw = (b.w - gap * (cols - 1)) / cols;
  const ch = (b.h - gap * (rows - 1)) / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * (cw + gap);
      const y = j * (ch + gap);
      cells.push({
        x,
        y,
        w: cw,
        h: ch,
        cx: x + cw / 2,
        cy: y + ch / 2,
        i,
        j,
      });
    }
  }
  return cells;
}

export interface NoisyLineOptions {
  /** Number of polyline points. */
  points?: number;
  /** Noise frequency along the line. */
  scale?: number;
  /** Perpendicular displacement amplitude, default units. */
  amplitude?: number;
  /** Noise offset (use different values for uncorrelated lines). */
  offset?: number;
}

/** A hand-drawn-looking line: polyline displaced by seeded noise. */
export function noisyLine(
  x1: L,
  y1: L,
  x2: L,
  y2: L,
  opts: NoisyLineOptions = {},
): Shape {
  const { points = 64, scale = 3, amplitude = 1, offset = 0 } = opts;
  // Work in default-unit percent space: resolve L against a nominal 100×100
  // context so mixed units still combine (they resolve exactly at render for
  // plain numbers; tagged units are resolved proportionally here).
  const nominal = { innerW: 100, innerH: 100 };
  const ax = resolveLen(x1, nominal);
  const ay = resolveLen(y1, nominal);
  const bx = resolveLen(x2, nominal);
  const by = resolveLen(y2, nominal);
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const p = path();
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const falloff = Math.sin(Math.PI * t) ** 0.5; // pin the endpoints
    const n = noise(offset + t * scale, offset * 7.31) * amplitude * falloff;
    const px = ax + dx * t + nx * n;
    const py = ay + dy * t + ny * n;
    if (i === 0) p.moveTo(px, py);
    else p.lineTo(px, py);
  }
  return p;
}

/** Resolve a Len against the current drawable for advanced layout math. */
export function resolve(v: L, innerW: number, innerH: number): number {
  void getState();
  return resolveLen(v instanceof Len ? v : v, { innerW, innerH });
}

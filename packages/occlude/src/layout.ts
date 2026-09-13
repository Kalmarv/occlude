/** Layout helpers. */

import { finiteCount } from './guard.js';

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
export function grid(b: { w: number; h: number }, opts: GridOptions): GridCell[] {
  const { cols, rows, gap = 0 } = opts;
  finiteCount('grid', cols * rows);
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

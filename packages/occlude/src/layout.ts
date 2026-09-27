/** Layout: the rect record, and the grid. */

import { finiteCount } from './guard.js';
import type { IsoContour } from './isolines.js';
import { Material, material, mintIds, withFaces } from './material.js';
import { statedColumns } from './faces.js';

/**
 * A rectangle as a record: its corner, its size and its middle. It is an
 * AREA, so it answers the area protocol and every area consumer takes it as
 * it takes a face: `polygon(b)`, `t.within(m, b)`, `t.distanceTo(b)`, the
 * `within` of a point operation. `t.bounds()` answers one, and so does
 * every face's `bounds`.
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The middle — the point most stamps actually want. */
  cx: number;
  cy: number;
  /** The rectangle as one closed loop, counter-clockwise in a y-up reading. */
  contours(): IsoContour[];
}

/** The four corners, read off the record the method belongs to. */
const BOX_PROTO = {
  contours(this: Box): IsoContour[] {
    const { x, y, w, h } = this;
    return [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
  },
};

/** A rect record at `(x, y)` of size `w × h`, answering `contours()`. */
export function box(x: number, y: number, w: number, h: number): Box {
  const b = Object.create(BOX_PROTO) as { -readonly [K in keyof Box]: Box[K] };
  b.x = x;
  b.y = y;
  b.w = w;
  b.h = h;
  b.cx = x + w / 2;
  b.cy = y + h / 2;
  return b;
}

/** A rectangle as the words that lay out over one read it: the corner
 * defaults to the origin. */
export interface Rect {
  x?: number;
  y?: number;
  w: number;
  h: number;
}

/** The corner of a rect, the origin when it names none. */
const cornerOf = (r: Rect): [number, number] => [r.x ?? 0, r.y ?? 0];

export interface GridOptions {
  cols: number;
  rows: number;
  /** Gap between cells, default units (percent of short side). With a
   * gap, cells touch nothing and share no wall. */
  gap?: number;
}

/**
 * A grid of cells covering the WHOLE drawable, as ONE geometry: its faces
 * are the cells, in row-major order (`i` across, then `j` down), each
 * carrying `i` and `j` as face columns, and each face's `bounds` is the
 * cell's rectangle, in bare units (percent of the short side — the long
 * axis runs past 100 on non-square drawables, exactly like `bounds()`), in
 * the sketch's own frame: the first cell sits at the drawable's corner
 * `b.x, b.y`. Neighbouring cells share their wall, so `strokes` draws it
 * once and `f.adjacent` answers; a `gap` parts them.
 */
export function grid(b: Rect, opts: GridOptions): Material {
  const { gap = 0 } = opts;
  // No cells to lay out (a zero or non-finite count): an empty grid.
  if (finiteCount('grid', opts.cols * opts.rows) === 0) return material([]);
  const cols = Math.floor(opts.cols);
  const rows = Math.floor(opts.rows);
  if (!(cols >= 1) || !(rows >= 1)) return material([]);
  const [x0, y0] = cornerOf(b);
  const cw = (b.w - gap * (cols - 1)) / cols;
  const ch = (b.h - gap * (rows - 1)) / rows;
  // A gap that eats the cell, or a drawable with no area: nothing to lay out.
  if (!(cw > 0) || !(ch > 0)) return material([]);
  const xs: number[] = [];
  const ys: number[] = [];
  const edges: number[] = [];
  const cycles: number[][][] = [];
  const at: [number, number][] = [];
  if (gap === 0) {
    // One lattice of corners: a wall two cells share is one edge.
    const corner = (i: number, j: number) => j * (cols + 1) + i;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        xs.push(i === cols ? x0 + b.w : x0 + i * cw);
        ys.push(j === rows ? y0 + b.h : y0 + j * ch);
      }
    }
    for (let j = 0; j <= rows; j++) for (let i = 0; i < cols; i++) edges.push(corner(i, j), corner(i + 1, j));
    for (let j = 0; j < rows; j++) for (let i = 0; i <= cols; i++) edges.push(corner(i, j), corner(i, j + 1));
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        cycles.push([[corner(i, j), corner(i + 1, j), corner(i + 1, j + 1), corner(i, j + 1)]]);
        at.push([i, j]);
      }
    }
  } else {
    // Parted cells: four corners and four walls each.
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = x0 + i * (cw + gap);
        const y = y0 + j * (ch + gap);
        const v = xs.length;
        xs.push(x, x + cw, x + cw, x);
        ys.push(y, y, y + ch, y + ch);
        edges.push(v, v + 1, v + 1, v + 2, v + 2, v + 3, v + 3, v);
        cycles.push([[v, v + 1, v + 2, v + 3]]);
        at.push([i, j]);
      }
    }
  }
  const edgeList = Uint32Array.from(edges);
  const edgeIds = mintIds(edgeList.length / 2);
  const m = new Material(Float64Array.from(xs), Float64Array.from(ys), {}, edgeList, {
    ids: { edges: edgeIds },
    faceAttrs: statedColumns(cycles, xs.length, edgeList, edgeIds, { i: (f) => at[f][0], j: (f) => at[f][1] }),
  });
  return withFaces(m, { cycles });
}

/** Layout helpers. */

import { finiteCount, usableLength } from './guard.js';
import type { IsoContour } from './isolines.js';
import { Material, material } from './material.js';
import type { L } from './units.js';

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
  /**
   * The cell as one closed loop, counter-clockwise in a y-up reading.
   *
   * A cell is an AREA, so it answers the area protocol and every area
   * consumer takes it as it takes a face: `polygon(cell, { fill })`,
   * `t.within(m, cell)`, `t.distanceTo(cell)`.
   */
  contours(): IsoContour[];
}

/** The four corners, read off the cell the method belongs to. */
const CELL_PROTO = {
  contours(this: GridCell): IsoContour[] {
    const { x, y, w, h } = this;
    return [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
  },
};

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
  // No cells to lay out (a zero or non-finite count): an empty grid.
  if (finiteCount('grid', cols * rows) === 0) return [];
  const cells: GridCell[] = [];
  const cw = (b.w - gap * (cols - 1)) / cols;
  const ch = (b.h - gap * (rows - 1)) / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * (cw + gap);
      const y = j * (ch + gap);
      cells.push(Object.assign(Object.create(CELL_PROTO) as GridCell, {
        x,
        y,
        w: cw,
        h: ch,
        cx: x + cw / 2,
        cy: y + ch / 2,
        i,
        j,
      }));
    }
  }
  return cells;
}

// ---- cell materials ---------------------------------------------------------------

/** What a layout function needs of the run: the drawable, and lengths. */
export interface LayoutEnv {
  bounds: { w: number; h: number };
  len(l: L): number;
}

export interface HexOptions {
  /** Centre-to-centre distance between neighbouring cells. */
  spacing: L;
  /** `'pointy'` (default) puts a vertex at the top of each cell; `'flat'`
   * puts an edge there. */
  orientation?: 'pointy' | 'flat';
  /** Shrink every cell about its own centre until neighbouring walls stand
   * this far apart. Gapped cells touch nothing, so nothing is shared. */
  gap?: L;
}

export interface TriangleOptions {
  /** Side length of one triangle. */
  size: L;
  /** Shrink every cell about its own centre until neighbouring walls stand
   * this far apart. Gapped cells touch nothing, so nothing is shared. */
  gap?: L;
}

/** One cell on the way to a material: its corners and its two indices. */
interface Cell {
  pts: [number, number][];
  i: number;
  j: number;
}

/** Vertices a hair apart are the same vertex: the wall two cells share is
 * computed from two different centres, so the two answers differ in the
 * last bits. A bucket per WELD square, and the eight neighbours searched
 * too, so a pair that straddles a bucket edge still meets. */
const WELD = 1e-6;

/** Shrink a polygon about its centroid. */
function shrink(pts: [number, number][], k: number): [number, number][] {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k] as [number, number]);
}

/** Sutherland–Hodgman against one half-plane of the drawable rectangle. */
function clipHalf(pts: [number, number][], inside: (p: [number, number]) => boolean, cut: (a: [number, number], b: [number, number]) => [number, number]): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % pts.length];
    const ain = inside(a);
    const bin = inside(b);
    if (ain) out.push(a);
    if (ain !== bin) out.push(cut(a, b));
  }
  return out;
}

/** A cell cut to the drawable, or null when nothing of it is left. */
function clipToDrawable(pts: [number, number][], w: number, h: number): [number, number][] | null {
  let p = pts;
  const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  p = clipHalf(p, (q) => q[0] >= 0, (a, b) => lerp(a, b, (0 - a[0]) / (b[0] - a[0])));
  if (p.length < 3) return null;
  p = clipHalf(p, (q) => q[0] <= w, (a, b) => lerp(a, b, (w - a[0]) / (b[0] - a[0])));
  if (p.length < 3) return null;
  p = clipHalf(p, (q) => q[1] >= 0, (a, b) => lerp(a, b, (0 - a[1]) / (b[1] - a[1])));
  if (p.length < 3) return null;
  p = clipHalf(p, (q) => q[1] <= h, (a, b) => lerp(a, b, (h - a[1]) / (b[1] - a[1])));
  if (p.length < 3) return null;
  return p;
}

/** Twice the signed area of a loop. */
function area2(pts: [number, number][]): number {
  let s = 0;
  for (let k = 0; k < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[(k + 1) % pts.length];
    s += ax * by - bx * ay;
  }
  return s;
}

/**
 * Cells to one material: every cell cut to the drawable, every wall minted
 * ONCE however many cells own it, and each face carrying the cell's two
 * indices. The walls are shared because the vertices are welded, which is
 * what makes `sel.adjacent()` answer on cells and `strokes()` draw a shared
 * wall a single time.
 */
function cellMaterial(cells: Cell[], w: number, h: number, name: string): Material {
  const xs: number[] = [];
  const ys: number[] = [];
  const buckets = new Map<string, number[]>();
  const vertexAt = (x: number, y: number): number => {
    const bi = Math.floor(x / WELD);
    const bj = Math.floor(y / WELD);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const list = buckets.get(`${bi + di},${bj + dj}`);
        if (!list) continue;
        for (const r of list) if (Math.abs(xs[r] - x) <= WELD && Math.abs(ys[r] - y) <= WELD) return r;
      }
    }
    const row = xs.length;
    xs.push(x);
    ys.push(y);
    const key = `${bi},${bj}`;
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
    return row;
  };
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  const bucketOf = (x: number, y: number, s: number): string => `${Math.floor(x / s)},${Math.floor(y / s)}`;
  const sites: { x: number; y: number; i: number; j: number }[] = [];
  for (const cell of cells) {
    const cut = clipToDrawable(cell.pts, w, h);
    // Nothing of the cell reached the drawable, or the cut left a sliver
    // with no area. Judged BEFORE any vertex is minted: a discarded cell
    // must leave no loose vertex behind.
    if (!cut || Math.abs(area2(cut)) < WELD) continue;
    const rows: number[] = [];
    for (const [x, y] of cut) {
      const r = vertexAt(x, y);
      if (rows.length === 0 || rows[rows.length - 1] !== r) rows.push(r);
    }
    while (rows.length > 1 && rows[0] === rows[rows.length - 1]) rows.pop();
    if (rows.length < 3) continue;
    const loop: [number, number][] = rows.map((r) => [xs[r], ys[r]]);
    if (Math.abs(area2(loop)) < WELD) continue;
    for (let k = 0; k < rows.length; k++) {
      const a = rows[k];
      const b = rows[(k + 1) % rows.length];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a, b]);
    }
    let cx = 0;
    let cy = 0;
    let s = 0;
    for (let k = 0; k < loop.length; k++) {
      const [ax, ay] = loop[k];
      const [bx, by] = loop[(k + 1) % loop.length];
      const f = ax * by - bx * ay;
      s += f;
      cx += (ax + bx) * f;
      cy += (ay + by) * f;
    }
    sites.push({ x: cx / (3 * s), y: cy / (3 * s), i: cell.i, j: cell.j });
  }
  // Only vertices a wall reached: a cell the weld collapsed is gone, and a
  // cell material never carries a loose point.
  const row = new Int32Array(xs.length).fill(-1);
  const pts: [number, number][] = [];
  for (const e of edges) {
    for (const v of e) {
      if (row[v] === -1) {
        row[v] = pts.length;
        pts.push([xs[v], ys[v]]);
      }
    }
  }
  const m = material(pts, { edges: edges.map(([a, b]) => [row[a], row[b]] as [number, number]) });
  if (sites.length === 0 || m.edgeCount === 0) return m;
  // A face is found by the cell whose centroid is nearest: a face IS one
  // clipped cell, so the nearest centroid is its own.
  const span = Math.max(WELD, Math.sqrt((w * h) / sites.length));
  const index = new Map<string, { x: number; y: number; i: number; j: number }[]>();
  for (const site of sites) {
    const key = bucketOf(site.x, site.y, span);
    const list = index.get(key);
    if (list) list.push(site);
    else index.set(key, [site]);
  }
  const nearest = (x: number, y: number): { i: number; j: number } => {
    const bi = Math.floor(x / span);
    const bj = Math.floor(y / span);
    let best = sites[0];
    let bestD = Infinity;
    for (let ring = 0; ring < 4; ring++) {
      for (let di = -ring; di <= ring; di++) {
        for (let dj = -ring; dj <= ring; dj++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
          const list = index.get(`${bi + di},${bj + dj}`);
          if (!list) continue;
          for (const s of list) {
            const d = (s.x - x) ** 2 + (s.y - y) ** 2;
            if (d < bestD) {
              bestD = d;
              best = s;
            }
          }
        }
      }
      // Nothing outside the rings walked so far can be nearer than
      // `ring · span`, so a hit inside that radius is the answer.
      if (bestD <= (ring * span) ** 2) break;
    }
    if (bestD === Infinity) for (const s of sites) {
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  };
  try {
    return m.faceAttributes({
      i: (f) => nearest(f.centroid[0], f.centroid[1]).i,
      j: (f) => nearest(f.centroid[0], f.centroid[1]).j,
    });
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}

/**
 * Hexagonal cells covering the drawable, as ONE material: `m.faces()` are
 * the cells, every shared wall is one edge, and each face carries its axial
 * `i` and `j`. The lattice is anchored on the drawable's origin — the cell
 * `i = 0, j = 0` is centred there — and every cell is cut to the drawable,
 * so the outermost cells are partial and the material's outline is the
 * drawable itself.
 */
export function hexes(env: LayoutEnv, opts: HexOptions): Material {
  const spacing = env.len(opts.spacing);
  const gap = opts.gap === undefined ? 0 : env.len(opts.gap);
  const flat = opts.orientation === 'flat';
  if (opts.orientation !== undefined && opts.orientation !== 'pointy' && opts.orientation !== 'flat') {
    throw new Error(`hexes: orientation must be 'pointy' or 'flat', got '${String(opts.orientation)}'`);
  }
  // A mid-edit zero or a gap that eats the cell: nothing to lay out.
  if (!usableLength(spacing)) return material([]);
  const k = 1 - gap / spacing;
  if (!(k > 0)) return material([]);
  const { w, h } = env.bounds;
  const R = spacing / Math.sqrt(3);
  const dx = flat ? spacing * (Math.sqrt(3) / 2) : spacing;
  const dy = flat ? spacing : spacing * (Math.sqrt(3) / 2);
  const cols = Math.ceil(w / dx) + 3;
  const rows = Math.ceil(h / dy) + 3;
  finiteCount('hexes', cols * rows);
  const cells: Cell[] = [];
  for (let b = -1; b < rows - 1; b++) {
    for (let a = -1; a < cols - 1; a++) {
      // Lattice index to axial: the staggered row (or column) is the axial
      // coordinate shifted by half a step, which is what `floor` undoes.
      const i = flat ? a : a - Math.floor(b / 2);
      const j = flat ? b - Math.floor(a / 2) : b;
      const cx = flat ? R * 1.5 * i : spacing * (i + j / 2);
      const cy = flat ? spacing * (j + i / 2) : R * 1.5 * j;
      const pts: [number, number][] = [];
      for (let v = 0; v < 6; v++) {
        const angle = ((flat ? 60 * v : 60 * v + 30) * Math.PI) / 180;
        pts.push([cx + R * Math.cos(angle), cy + R * Math.sin(angle)]);
      }
      cells.push({ pts: k === 1 ? pts : shrink(pts, k), i, j });
    }
  }
  return cellMaterial(cells, w, h, 'hexes');
}

/**
 * Triangular cells covering the drawable, as ONE material: `m.faces()` are
 * the cells, every shared wall is one edge, and each face carries its row
 * `j` and its index `i` along that row — an even `i` points up, an odd one
 * points down. Cut to the drawable exactly as `hexes` is.
 */
export function triangles(env: LayoutEnv, opts: TriangleOptions): Material {
  const size = env.len(opts.size);
  const gap = opts.gap === undefined ? 0 : env.len(opts.gap);
  if (!usableLength(size)) return material([]);
  // The gap opens between two cells that shared a wall, so each gives up
  // half of it: an inradius of size/(2√3) shrinks by gap/2.
  const k = 1 - (gap * Math.sqrt(3)) / size;
  if (!(k > 0)) return material([]);
  const { w, h } = env.bounds;
  const H = (size * Math.sqrt(3)) / 2;
  const rows = Math.ceil(h / H) + 2;
  const cols = Math.ceil(w / size) + 2;
  finiteCount('triangles', rows * cols * 2);
  const cells: Cell[] = [];
  for (let j = -1; j < rows - 1; j++) {
    const y0 = j * H;
    const y1 = y0 + H;
    // Consecutive rows are offset by half a side: the vertices of one row's
    // lower line are the apexes of the next row's upward cells.
    const ox = (j & 1) === 0 ? 0 : size / 2;
    for (let i = -2; i < 2 * cols; i++) {
      const c = Math.floor(i / 2);
      const x0 = ox + c * size;
      const pts: [number, number][] = (i & 1) === 0
        ? [[x0 + size / 2, y0], [x0 + size, y1], [x0, y1]]
        : [[x0 + size / 2, y0], [x0 + 1.5 * size, y0], [x0 + size, y1]];
      cells.push({ pts: k === 1 ? pts : shrink(pts, k), i, j });
    }
  }
  return cellMaterial(cells, w, h, 'triangles');
}

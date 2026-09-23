/** Layout helpers. */

import { finiteCount, usableLength } from './guard.js';
import type { IsoContour } from './isolines.js';
import { Material, material } from './material.js';
import type { Face, Faces } from './faces.js';
import type { L } from './units.js';
import { vx, vy, type XY } from './vec.js';
import type { Origin } from './shapes.js';

/**
 * A rectangle as a record: its corner, its size and its middle. It is an
 * AREA, so it answers the area protocol and every area consumer takes it as
 * it takes a face: `polygon(b)`, `t.within(m, b)`, `t.distanceTo(b)`, the
 * `within` of a point operation. `t.bounds()` answers one, and a grid cell
 * is one with its two indices.
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

export interface GridCell extends Box {
  i: number;
  j: number;
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
  return Object.assign(Object.create(BOX_PROTO) as Box, { x, y, w, h, cx: x + w / 2, cy: y + h / 2 });
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
  /** Gap between cells, default units (percent of short side). */
  gap?: number;
}

/**
 * Cell rectangles covering the WHOLE drawable, in bare units (percent of
 * the short side — the long axis runs past 100 on non-square drawables,
 * exactly like `bounds()`), in the sketch's own frame: the first cell sits
 * at the drawable's corner `b.x, b.y`. Pass the values straight to shape
 * functions.
 */
export function grid(b: Rect, opts: GridOptions): GridCell[] {
  const { cols, rows, gap = 0 } = opts;
  // No cells to lay out (a zero or non-finite count): an empty grid.
  if (finiteCount('grid', cols * rows) === 0) return [];
  const cells: GridCell[] = [];
  const [x0, y0] = cornerOf(b);
  const cw = (b.w - gap * (cols - 1)) / cols;
  const ch = (b.h - gap * (rows - 1)) / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = x0 + i * (cw + gap);
      const y = y0 + j * (ch + gap);
      cells.push(Object.assign(box(x, y, cw, ch) as GridCell, { i, j }));
    }
  }
  return cells;
}

// ---- cell materials ---------------------------------------------------------------

/** What a layout function needs of the run: the drawable, and lengths. */
export interface LayoutEnv {
  /** The drawable in the sketch's frame. */
  bounds: Rect;
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
  /** The point cell `i = 0, j = 0` is centred on (see `Origin`): a pair
   * or an `{ x, y }` record, or `'center'`/`'centroid'` for the middle of
   * the lattice's own bounds, which are the drawable. Default the user
   * origin. */
  origin?: Origin;
  /** Turn the whole lattice about `origin`, in degrees counter-clockwise.
   * `orientation` still picks the cell before the turn. */
  rotate?: number;
}

export interface TriangleOptions {
  /** Side length of one triangle. */
  size: L;
  /** Shrink every cell about its own centre until neighbouring walls stand
   * this far apart. Gapped cells touch nothing, so nothing is shared. */
  gap?: L;
  /** The point the lattice's own (0, 0) stands on (see `Origin`): a pair
   * or an `{ x, y }` record, or `'center'`/`'centroid'` for the middle of
   * the drawable, default the user origin. Row 0's top line runs through
   * it, and the upward cell `i = 0, j = 0` has its apex half a side along. */
  origin?: Origin;
  /** Turn the whole lattice about `origin`, in degrees counter-clockwise. */
  rotate?: number;
}

/** A face of a cell material: every cell carries its two indices. */
export type CellFace = Face & { i: number; j: number };

/** What `t.hexes` and `t.triangles` answer: a material whose faces carry
 * `i` and `j` on every face, so a held face reads them as numbers. */
export interface CellMaterial extends Material {
  faces(): Faces<CellFace>;
}

/** One cell on the way to a material: its corners and its two indices. */
interface Cell {
  pts: [number, number][];
  i: number;
  j: number;
}

/**
 * Where a lattice stands: `place` carries a point of the lattice's own
 * frame — cell (0, 0) at its origin, unturned — to the sketch, and `box` is
 * the drawable seen from that frame, so the cells laid over the box cover
 * the drawable after the turn. The cut to the drawable comes after, so the
 * coverage and the outline are the drawable's whatever the placement, and
 * the `i`, `j` a face carries stay the lattice's own coordinates.
 *
 * With no origin and no turn nothing moves: `place` is the identity and the
 * box is the drawable, so the default lattice is the one it always was.
 * Null when the placement is not a finite point and angle — a mid-edit
 * value, which lays out nothing.
 */
function latticeFrame(
  who: string, r: Rect, origin: Origin | undefined, rotate: number | undefined,
): { place: (p: [number, number]) => [number, number]; x0: number; y0: number; x1: number; y1: number } | null {
  if (rotate !== undefined && typeof rotate !== 'number') throw new Error(`${who}: rotate is an angle in degrees, got ${typeof rotate}`);
  // A lattice's own bounds are the drawable it covers, so its middle and
  // its centroid are one point.
  const middle = origin === 'center' || origin === 'centroid';
  if (typeof origin === 'string' && !middle) {
    throw new Error(`${who}: origin is a point ([x, y] or { x, y }), 'center' or 'centroid' — got '${origin}'`);
  }
  const [rx, ry] = cornerOf(r);
  const ox = origin === undefined ? 0 : middle ? rx + r.w / 2 : vx(origin as XY);
  const oy = origin === undefined ? 0 : middle ? ry + r.h / 2 : vy(origin as XY);
  const deg = rotate ?? 0;
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(deg)) return null;
  if (ox === 0 && oy === 0 && deg === 0) return { place: (p) => p, x0: rx, y0: ry, x1: rx + r.w, y1: ry + r.h };
  // A quarter turn is exact: a wall that should stand upright does.
  const quarter = deg % 90 === 0 ? (((deg / 90) % 4) + 4) % 4 : -1;
  const cos = quarter >= 0 ? [1, 0, -1, 0][quarter] : Math.cos((deg * Math.PI) / 180);
  const sin = quarter >= 0 ? [0, 1, 0, -1][quarter] : Math.sin((deg * Math.PI) / 180);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of [[rx, ry], [rx + r.w, ry], [rx + r.w, ry + r.h], [rx, ry + r.h]]) {
    // The inverse placement: shift back, then turn back.
    const dx = x - ox;
    const dy = y - oy;
    const lx = cos * dx + sin * dy;
    const ly = -sin * dx + cos * dy;
    x0 = Math.min(x0, lx);
    y0 = Math.min(y0, ly);
    x1 = Math.max(x1, lx);
    y1 = Math.max(y1, ly);
  }
  return { place: ([x, y]) => [ox + cos * x - sin * y, oy + sin * x + cos * y], x0, y0, x1, y1 };
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
function clipToDrawable(pts: [number, number][], r: Rect): [number, number][] | null {
  let p = pts;
  const [x0, y0] = cornerOf(r);
  const w = x0 + r.w;
  const h = y0 + r.h;
  const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  p = clipHalf(p, (q) => q[0] >= x0, (a, b) => lerp(a, b, (x0 - a[0]) / (b[0] - a[0])));
  if (p.length < 3) return null;
  p = clipHalf(p, (q) => q[0] <= w, (a, b) => lerp(a, b, (w - a[0]) / (b[0] - a[0])));
  if (p.length < 3) return null;
  p = clipHalf(p, (q) => q[1] >= y0, (a, b) => lerp(a, b, (y0 - a[1]) / (b[1] - a[1])));
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
function cellMaterial(cells: Cell[], r: Rect, name: string): CellMaterial {
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
    const cut = clipToDrawable(cell.pts, r);
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
  if (sites.length === 0 || m.edgeCount === 0) return m as CellMaterial;
  // A face is found by the cell whose centroid is nearest: a face IS one
  // clipped cell, so the nearest centroid is its own.
  const span = Math.max(WELD, Math.sqrt((r.w * r.h) / sites.length));
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
    }) as CellMaterial;
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
}

/**
 * Hexagonal cells covering the drawable, as ONE material: `m.faces()` are
 * the cells, every shared wall is one edge, and each face carries its axial
 * `i` and `j`. The lattice is anchored on `origin` — the cell
 * `i = 0, j = 0` is centred there, the user origin by default — and turned
 * about it by `rotate`; then every cell is cut to the drawable, so the
 * outermost cells are partial and the material's outline is the drawable
 * itself.
 */
export function hexes(env: LayoutEnv, opts: HexOptions): CellMaterial {
  const spacing = env.len(opts.spacing);
  const gap = opts.gap === undefined ? 0 : env.len(opts.gap);
  const flat = opts.orientation === 'flat';
  if (opts.orientation !== undefined && opts.orientation !== 'pointy' && opts.orientation !== 'flat') {
    throw new Error(`hexes: orientation must be 'pointy' or 'flat', got '${String(opts.orientation)}'`);
  }
  // A mid-edit zero or a gap that eats the cell: nothing to lay out.
  if (!usableLength(spacing)) return material([]) as CellMaterial;
  const k = 1 - gap / spacing;
  if (!(k > 0)) return material([]) as CellMaterial;
  const frame = latticeFrame('hexes', env.bounds, opts.origin, opts.rotate);
  if (!frame) return material([]) as CellMaterial;
  const R = spacing / Math.sqrt(3);
  const dx = flat ? spacing * (Math.sqrt(3) / 2) : spacing;
  const dy = flat ? spacing : spacing * (Math.sqrt(3) / 2);
  // The lattice steps that cover the drawable as the lattice sees it, with
  // a step to spare on every side for the stagger and the cell's reach.
  const a0 = Math.floor(frame.x0 / dx);
  const b0 = Math.floor(frame.y0 / dy);
  const cols = Math.ceil((frame.x1 - frame.x0) / dx) + 3;
  const rows = Math.ceil((frame.y1 - frame.y0) / dy) + 3;
  finiteCount('hexes', cols * rows);
  const cells: Cell[] = [];
  for (let b = b0 - 1; b < b0 + rows - 1; b++) {
    for (let a = a0 - 1; a < a0 + cols - 1; a++) {
      // Lattice index to axial: the staggered row (or column) is the axial
      // coordinate shifted by half a step, which is what `floor` undoes.
      const i = flat ? a : a - Math.floor(b / 2);
      const j = flat ? b - Math.floor(a / 2) : b;
      const cx = flat ? R * 1.5 * i : spacing * (i + j / 2);
      const cy = flat ? spacing * (j + i / 2) : R * 1.5 * j;
      const pts: [number, number][] = [];
      for (let v = 0; v < 6; v++) {
        const angle = ((flat ? 60 * v : 60 * v + 30) * Math.PI) / 180;
        pts.push(frame.place([cx + R * Math.cos(angle), cy + R * Math.sin(angle)]));
      }
      cells.push({ pts: k === 1 ? pts : shrink(pts, k), i, j });
    }
  }
  return cellMaterial(cells, env.bounds, 'hexes');
}

/**
 * Triangular cells covering the drawable, as ONE material: `m.faces()` are
 * the cells, every shared wall is one edge, and each face carries its row
 * `j` and its index `i` along that row — an even `i` points up, an odd one
 * points down. Anchored on `origin`, turned by `rotate` and cut to the
 * drawable exactly as `hexes` is.
 */
export function triangles(env: LayoutEnv, opts: TriangleOptions): CellMaterial {
  const size = env.len(opts.size);
  const gap = opts.gap === undefined ? 0 : env.len(opts.gap);
  if (!usableLength(size)) return material([]) as CellMaterial;
  // The gap opens between two cells that shared a wall, so each gives up
  // half of it: an inradius of size/(2√3) shrinks by gap/2.
  const k = 1 - (gap * Math.sqrt(3)) / size;
  if (!(k > 0)) return material([]) as CellMaterial;
  const frame = latticeFrame('triangles', env.bounds, opts.origin, opts.rotate);
  if (!frame) return material([]) as CellMaterial;
  const H = (size * Math.sqrt(3)) / 2;
  const c0 = Math.floor(frame.x0 / size);
  const j0 = Math.floor(frame.y0 / H);
  const rows = Math.ceil((frame.y1 - frame.y0) / H) + 2;
  const cols = Math.ceil((frame.x1 - frame.x0) / size) + 2;
  finiteCount('triangles', rows * cols * 2);
  const cells: Cell[] = [];
  for (let j = j0 - 1; j < j0 + rows - 1; j++) {
    const y0 = j * H;
    const y1 = y0 + H;
    // Consecutive rows are offset by half a side: the vertices of one row's
    // lower line are the apexes of the next row's upward cells.
    const ox = (j & 1) === 0 ? 0 : size / 2;
    for (let i = 2 * c0 - 2; i < 2 * (c0 + cols); i++) {
      const c = Math.floor(i / 2);
      const x0 = ox + c * size;
      const pts: [number, number][] = (i & 1) === 0
        ? [[x0 + size / 2, y0], [x0 + size, y1], [x0, y1]]
        : [[x0 + size / 2, y0], [x0 + 1.5 * size, y0], [x0 + size, y1]];
      cells.push({ pts: (k === 1 ? pts : shrink(pts, k)).map(frame.place), i, j });
    }
  }
  return cellMaterial(cells, env.bounds, 'triangles');
}

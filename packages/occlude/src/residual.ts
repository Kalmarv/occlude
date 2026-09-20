/**
 * Ink as a budget: a tone surface the drawing pays down.
 *
 * Every tonal recipe in the library is open-loop. A field says how dark a
 * place should be, a word puts marks there, and nothing ever measures what
 * was laid down: the second pass cannot know what the first one already
 * paid, so overlapping passes double the ink and a greedy line has no idea
 * where it is still owed. A residual closes that loop. It holds the target
 * darkness on a cell grid, `spend` subtracts the nib footprint of the marks
 * that were drawn, and what is left is the debt — which is a field, so
 * `scatter`, `isolines`, `streamlines` and a decimate amount all read it
 * unchanged.
 *
 * This is a raster, and the "raster-based coverage" refusal in CLAUDE.md is
 * not about this. That refusal is about the engine judging what is HIDDEN:
 * occlusion is exact and stays exact, computed on the strokes this produces
 * like any others. What is rastered here is the TONE the artist is paying
 * down — a bookkeeping surface over the picture, never a decision about
 * visibility.
 *
 * Conventions follow the rest of the raster code. Cell `(i, j)` has its
 * centre at `bounds.x + (i + ½)·spacing`, row-major, exactly as `lattice`
 * and `densityRaster` place theirs. Values are `Float32Array`: a residual is
 * a picture of a quantity, not a coordinate.
 *
 * MUTATION, stated plainly. `spend` changes the surface in place, and it is
 * the one deliberate exception in the library. Every other value in occlude
 * is immutable, and a residual cannot be: it is a ledger, the whole point is
 * that the next choice reads what the last stroke paid, and copying a raster
 * per stroke would make a four-thousand-stroke loop quadratic. `snapshot()`
 * is the immutable door — a frozen copy as a plain field. Law 3 is
 * untouched: the ledger is a pure function of the seeded sequence of spends,
 * so the same program and the same seed still make the same ink.
 */

import { areaFill } from './area.js';
import { numericLoops, type AreaInput, type Geometry } from './boundary.js';
import { usableLength } from './guard.js';
import type { Curve } from './material.js';
import type { IsoContour } from './isolines.js';
import type { Bounds, FieldFn2 } from './points.js';
import { mm, type L } from './units.js';
import { vx, vy, type XY } from './vec.js';
// Type-only (erased): a shape is recognised and refused here, never
// lowered — the toolkit does that, where the sketch frame is known.
import type { ShapeValue } from './api.js';

/** Environment handed in by the toolkit: drawable bounds and sketch-time
 * length resolution, both in user units — the pair `isolines` and `lattice`
 * take. */
export interface ResidualEnv {
  bounds: Bounds;
  len(l: L): number;
}

export interface ResidualOpts {
  /** Cell size in user units (`mm(0.8)` allowed). Default the grid step
   * `t.isolines` uses: `mm(1)`, or the long side over 256 where that is
   * coarser. */
  spacing?: L;
  /** The area that owes anything, default the drawable. Outside it the
   * residual is 0 — nothing owed, so a mark there takes nothing. A shape is
   * lowered by the toolkit, where the sketch frame exists. */
  area?: AreaInput | ShapeValue;
}

/** What `spend` accepts: a material or a selection (its chains stroked, and
 * a point no chain touches dotted), a contour record or a list of them, or a
 * plain polyline of positions — one position on its own is a dot. */
export type SpendMarks =
  | Geometry
  | IsoContour
  | readonly IsoContour[]
  | readonly XY[];

export interface SpendOpts {
  /** The nib: a stroke covers a band this wide, a dot a disc this across. */
  width: L;
}

/**
 * The tone still owed, as a field you can also pay down.
 *
 * Call it like any field — `r(x, y)` is what is still owed there, 0 to 1,
 * bilinear between cell centres and 0 outside the area. `spend` is the one
 * mutating word in the library; see the module header for why.
 */
export interface Residual {
  (x: number, y: number): number;
  /**
   * Subtract the nib footprint of `marks` from the surface, and answer with
   * the darkness actually taken.
   *
   * The unit is CELL AREAS: a cell paid from 1 down to 0 contributes 1, and
   * a cell half covered by a nib over a tone of 0.5 contributes 0.25.
   * Multiply by `spacing²` for sketch-area units. A cell never goes below
   * 0, so a mark over a cell that owes nothing takes nothing and the answer
   * is what was there to take, not what the nib would have covered.
   */
  spend(marks: SpendMarks, opts: SpendOpts): number;
  /** What is still owed over the whole surface, in the same cell-area
   * units — the number a stopping test watches. */
  total(): number;
  /** What is owed at one place: the same as calling the residual. */
  peek(x: number, y: number): number;
  /** A frozen copy of the surface as a plain field. Later spends do not
   * change it — this is the immutable door out of the ledger. */
  snapshot(): FieldFn2;
}

/** Memory sanity, the bound `lattice` keeps: 4M cells is a 16MB buffer. */
const MAX_CELLS = 4_194_304;

/** Scan lines per cell row when a footprint is measured. Along a line the
 * overlap with each cell is exact, so the only error is the vertical
 * quantisation of a boundary cell — an eighth of a cell at worst, and it is
 * the same eighth whichever way the stroke runs. */
const SCANLINES = 8;

/** A position pair, either spelling, as a plain pair. */
type Pt = [number, number];

/**
 * Build a residual. The toolkit's `t.residual` is this with the drawable and
 * the sketch's length resolution filled in; a shape area is already lowered
 * to loops by the time it arrives.
 */
export function residualOf(env: ResidualEnv, field: FieldFn2, opts: ResidualOpts = {}): Residual {
  if (typeof field !== 'function') {
    throw new Error(
      `residual: the first argument is the target darkness as a field, (x, y) => 0…1 — got ${describe(field)}`,
    );
  }
  const b = env.bounds;

  // A spacing at or below zero yields no cells — the rule sample, scatter,
  // settle, isolines and the fills all read.
  const spacing = usableLength(opts.spacing)
    ? opts.spacing !== undefined
      ? env.len(opts.spacing)
      : Math.max(env.len(mm(1)), Math.max(b.w, b.h) / 256)
    : 0;

  let box: Bounds = { x: b.x, y: b.y, w: b.w, h: b.h };
  let loops: Pt[][] | null = null;
  if (opts.area !== undefined) {
    const area = opts.area;
    if (typeof area === 'object' && area !== null && '__occludeShape' in area) {
      throw new Error(
        'residual: a shape area is lowered by the toolkit (t.residual), where the sketch frame is known — pass loops, a face or a material here',
      );
    }
    loops = numericLoops(area as AreaInput, 'residual');
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const loop of loops) for (const [x, y] of loop) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    box = Number.isFinite(x0) && x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
  }

  const usable = spacing > 0 && Number.isFinite(spacing) && box.w > 0 && box.h > 0;
  const cols = usable ? Math.ceil(box.w / spacing) : 0;
  const rows = usable ? Math.ceil(box.h / spacing) : 0;
  const cells = cols * rows;
  if (cells > MAX_CELLS) {
    throw new Error(`residual: ${cells} cells (spacing too fine) — capped at ${MAX_CELLS} (16MB)`);
  }
  // Whole cells, centred on the area's box, so the overhang is the same on
  // both sides and a cell centre is always `bounds.x + (i + ½)·spacing`.
  const bounds: Bounds = cells === 0
    ? { x: 0, y: 0, w: 0, h: 0 }
    : {
      x: box.x - (cols * spacing - box.w) / 2,
      y: box.y - (rows * spacing - box.h) / 2,
      w: cols * spacing,
      h: rows * spacing,
    };

  const mask = new Uint8Array(cells);
  const owed = new Float32Array(cells);
  if (cells > 0) {
    // Loops carry no winding rule of their own, so they read even-odd —
    // exactly as `distanceTo` and the other loop consumers document.
    const inside = loops === null ? null : areaFill(loops, 'evenodd').at;
    for (let j = 0; j < rows; j++) {
      const cy = bounds.y + (j + 0.5) * spacing;
      for (let i = 0; i < cols; i++) {
        const cx = bounds.x + (i + 0.5) * spacing;
        if (inside !== null && !(inside(cx, cy) > 0)) continue;
        mask[j * cols + i] = 1;
        // A sample that is not a number owes nothing: one bad sample
        // degrades that cell, not the drawing.
        const v = field(cx, cy);
        owed[j * cols + i] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
      }
    }
  }

  const read = reader(owed, cols, rows, spacing, bounds, mask);

  // One scratch surface for coverage, reused by every spend: a spend touches
  // a few cells and clears exactly those, so a long loop allocates nothing.
  const cover = new Float32Array(cells);
  const touched: number[] = [];

  const residual = ((x: number, y: number): number => read(x, y)) as Residual;

  residual.spend = (marks: SpendMarks, how: SpendOpts): number => {
    if (!how || typeof how !== 'object' || how.width === undefined) {
      throw new Error('residual.spend: { width } is required — the nib the marks are drawn with, such as mm(0.3)');
    }
    if (cells === 0 || !usableLength(how.width)) return 0;
    const width = env.len(how.width);
    if (!(width > 0) || !Number.isFinite(width)) return 0;
    const r = width / 2;

    const stamp = (idx: number, c: number): void => {
      if (cover[idx] === 0) touched.push(idx);
      cover[idx] += c;
    };
    for (const line of markLines(marks)) {
      if (line.length === 1) {
        capsule(line[0], line[0], r, cols, rows, spacing, bounds, stamp);
        continue;
      }
      for (let k = 1; k < line.length; k++) capsule(line[k - 1], line[k], r, cols, rows, spacing, bounds, stamp);
    }

    let taken = 0;
    for (const idx of touched) {
      const c = Math.min(1, cover[idx]);
      cover[idx] = 0;
      if (!mask[idx]) continue;
      // Clamped at what is owed: a mark over a paid cell takes nothing.
      const dec = Math.min(owed[idx], c);
      if (dec > 0) {
        owed[idx] -= dec;
        taken += dec;
      }
    }
    touched.length = 0;
    return taken;
  };

  residual.total = (): number => {
    let sum = 0;
    for (let idx = 0; idx < cells; idx++) if (mask[idx]) sum += owed[idx];
    return sum;
  };

  residual.peek = (x: number, y: number): number => read(x, y);

  residual.snapshot = (): FieldFn2 => reader(Float32Array.from(owed), cols, rows, spacing, bounds, mask);

  return residual;
}

/**
 * A surface as a field: bilinear between cell centres, 0 outside the area —
 * nothing is owed there, which is what every consumer of this field wants to
 * read. Near an edge the stencil borrows the containing cell's value for a
 * corner that is off the grid, so the boundary does not fall away and grow a
 * contour that is not there.
 */
function reader(
  values: Float32Array,
  cols: number,
  rows: number,
  spacing: number,
  bounds: Bounds,
  mask: Uint8Array,
): FieldFn2 {
  if (cols === 0 || rows === 0 || !(spacing > 0)) return () => 0;
  const bx = bounds.x;
  const by = bounds.y;
  return (x: number, y: number): number => {
    const ci = Math.floor((x - bx) / spacing);
    const cj = Math.floor((y - by) / spacing);
    if (ci < 0 || cj < 0 || ci >= cols || cj >= rows) return 0;
    const home = cj * cols + ci;
    if (!mask[home]) return 0;
    const u = (x - bx) / spacing - 0.5;
    const v = (y - by) / spacing - 0.5;
    const i0 = Math.floor(u);
    const j0 = Math.floor(v);
    const fx = u - i0;
    const fy = v - j0;
    const at = (i: number, j: number): number => {
      if (i < 0 || j < 0 || i >= cols || j >= rows) return values[home];
      const idx = j * cols + i;
      return mask[idx] ? values[idx] : values[home];
    };
    const v00 = at(i0, j0);
    const v10 = at(i0 + 1, j0);
    const v01 = at(i0, j0 + 1);
    const v11 = at(i0 + 1, j0 + 1);
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
  };
}

/**
 * The nib footprint of one segment: the segment swept by a disc of diameter
 * `2r` — a stadium, which is convex, so a horizontal line crosses it in one
 * interval. Each cell row is measured on `SCANLINES` lines; across a line
 * the overlap with each cell is exact, so what a cell is handed is its
 * covered fraction and the sum over cells is the footprint's area in cell
 * areas. A zero-length segment is a dot.
 */
function capsule(
  a: Pt,
  b: Pt,
  r: number,
  cols: number,
  rows: number,
  spacing: number,
  bounds: Bounds,
  stamp: (idx: number, c: number) => void,
): void {
  const [ax, ay] = a;
  const [bx, by] = b;
  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) return;
  const ox = bounds.x;
  const oy = bounds.y;
  let j0 = Math.floor((Math.min(ay, by) - r - oy) / spacing);
  let j1 = Math.floor((Math.max(ay, by) + r - oy) / spacing);
  if (j1 < 0 || j0 >= rows) return;
  j0 = Math.max(0, j0);
  j1 = Math.min(rows - 1, j1);

  // The straight part, as a quad; a dot has none.
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  let qx: Pt[] | null = null;
  if (len > 0) {
    const nx = (-dy / len) * r;
    const ny = (dx / len) * r;
    qx = [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
  }
  const share = 1 / SCANLINES;

  for (let j = j0; j <= j1; j++) {
    const base = oy + j * spacing;
    const row = j * cols;
    for (let s = 0; s < SCANLINES; s++) {
      const y = base + ((s + 0.5) / SCANLINES) * spacing;
      let lo = Infinity;
      let hi = -Infinity;
      // The two end discs.
      const da = r * r - (y - ay) * (y - ay);
      if (da >= 0) {
        const h = Math.sqrt(da);
        lo = Math.min(lo, ax - h);
        hi = Math.max(hi, ax + h);
      }
      const db = r * r - (y - by) * (y - by);
      if (db >= 0) {
        const h = Math.sqrt(db);
        lo = Math.min(lo, bx - h);
        hi = Math.max(hi, bx + h);
      }
      // The straight part: a convex quad, so its crossings bound the slice.
      if (qx) {
        for (let k = 0; k < 4; k++) {
          const [x1, y1] = qx[k];
          const [x2, y2] = qx[(k + 1) % 4];
          if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
            const x = x1 + ((x2 - x1) * (y - y1)) / (y2 - y1);
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
          }
        }
      }
      if (!(hi > lo)) continue;
      let i0 = Math.floor((lo - ox) / spacing);
      let i1 = Math.floor((hi - ox) / spacing);
      if (i1 < 0 || i0 >= cols) continue;
      i0 = Math.max(0, i0);
      i1 = Math.min(cols - 1, i1);
      for (let i = i0; i <= i1; i++) {
        const x0 = ox + i * spacing;
        const overlap = Math.min(hi, x0 + spacing) - Math.max(lo, x0);
        if (overlap > 0) stamp(row + i, (overlap / spacing) * share);
      }
    }
  }
}

/**
 * The marks as polylines. A value that says where its chains are has them
 * stroked, and any point no chain touches is a dot (so a scatter is dots and
 * a chain material is strokes, with no flag to say which). A contour record
 * is one chain, an array of them is several, and a plain array of positions
 * is one polyline — one position on its own is a dot.
 */
function markLines(marks: SpendMarks): Pt[][] {
  if (marks === null || marks === undefined) return [];
  if (typeof marks === 'object' && '__occludeShape' in (marks as object)) {
    throw new Error(
      'residual.spend: a shape is not marks — how many points it has would be decided by a flattening tolerance. Use t.material(shape) for the boundary\'s own vertices, or t.sample(shape, { count }) for a number you choose.',
    );
  }
  if (Array.isArray(marks)) {
    if (marks.length === 0) return [];
    // Positions are one polyline; anything else is a list of marks, each
    // read the same way as one.
    if (isPoint(marks[0])) {
      const line = (marks as readonly XY[]).map((p) => [vx(p), vy(p)] as Pt);
      return [line];
    }
    return (marks as readonly SpendMarks[]).flatMap(markLines);
  }
  // The protocol first: a value that can say where its chains and points are
  // is read by what it answers, never by a field that looks like a record.
  const g = marks as Geometry;
  const hasCurves = typeof g === 'object' && typeof g.curves === 'function';
  const hasPoints = typeof g === 'object' && g !== null && g.points !== undefined;
  if (!hasCurves && !hasPoints) {
    if (isContourRecord(marks)) {
      const line = contourLine(marks);
      return line.length > 0 ? [line] : [];
    }
    throw new Error(
      `residual.spend: ${describe(marks)} cannot say where its marks are — pass a material, a point selection, a contour record, or an [x, y][] polyline`,
    );
  }
  const out: Pt[][] = [];
  const used = new Set<number>();
  if (hasCurves) {
    for (const c of (g.curves as () => Curve[])()) {
      for (const i of c.indices) used.add(i);
      const line = contourLine(c);
      if (line.length > 0) out.push(line);
    }
  }
  if (hasPoints) {
    // A point no chain walked is a mark of its own: a dot.
    for (const p of g.points as Iterable<{ index: number; x: number; y: number }>) {
      if (!used.has(p.index)) out.push([[p.x, p.y]]);
    }
  }
  return out;
}

/** A contour as a polyline; a closed one comes back to where it started. */
function contourLine(c: IsoContour): Pt[] {
  const pts = c.pts.map((p) => [vx(p as XY), vy(p as XY)] as Pt);
  if (c.closed && pts.length > 2) pts.push(pts[0]);
  return pts;
}

const isContourRecord = (v: unknown): v is IsoContour =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as IsoContour).pts);

const isPoint = (v: unknown): boolean => {
  if (Array.isArray(v)) return typeof v[0] === 'number' && typeof v[1] === 'number';
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { x?: unknown; y?: unknown };
  return typeof o.x === 'number' && typeof o.y === 'number';
};

/** What a refusal calls the thing it was handed. */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return `a ${(v as object).constructor?.name ?? 'object'}`;
  return `a ${typeof v}`;
}

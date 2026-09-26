/**
 * A grid of values you can step.
 *
 * A field is a pure function of position, which is the right shape for
 * noise, distance and gradients, and the wrong one for anything that has to
 * remember what it was a moment ago. Reaction-diffusion, physarum trails,
 * erosion, "draw where the pen has been" — each of those is a local rule
 * applied over and over to a substrate, and each of them was, until now, a
 * hand-rolled Float32Array and a hand-rolled five-tap blur inside the
 * sketch.
 *
 * `t.lattice` is that substrate: named channels on a cell grid over an
 * area, one table of cells with the write `set` (every function reads the
 * cells as they were, so a pass over the whole grid is one instant), a
 * run that steps it (`t.steps(n, lat, (l) => l.set(…))`), and
 * `field(channel)` back out, so everything that reads a field —
 * `isolines`, `scatter`, a fill, `decimate` — reads a lattice too. A
 * cell answers its `laplacian`, which is what diffusion is written with.
 *
 * Recipes stay recipes. There is no `reactionDiffusion()` and no
 * `physarum()`: those are four lines of a pass each, written in the sketch.
 *
 * Conventions follow the rest of the raster code. Cell `(i, j)` has its
 * centre at `bounds.x + (i + ½)·spacing`, row-major, exactly as
 * `densityRaster` (points.ts) places its samples. Values are `Float32Array`
 * — a lattice is a picture of a quantity, not a coordinate, and half the
 * memory means twice the grid.
 *
 * The value never mutates: `set` and `add` return a new lattice, and the
 * one it came from still reads what it read before.
 */

import { areaFill } from './area.js';
import { numericLoops, type AreaInput } from './boundary.js';
import { usableLength } from './guard.js';
import { Material, material as makeMaterial, type PointsLike } from './material.js';
import type { Bounds, FieldFn2 } from './points.js';
import { vx, vy, type XY } from './vec.js';
import type { L } from './units.js';
// Type-only (erased): a shape area is recognised and refused here, never
// lowered — the toolkit does that, where the sketch frame is known.
import type { ShapeValue } from './api.js';

/** Environment handed in by the toolkit: drawable bounds and sketch-time
 * length resolution, both in user units — the same pair `isolines` takes. */
export interface LatticeEnv {
  bounds: Bounds;
  len(l: L): number;
}

/** A cell's starting value: one number for the first channel, or a record
 * naming the channels it sets. Evaluated at the cell centre. */
export type LatticeInit = (x: number, y: number) => number | Record<string, number>;

export interface LatticeOpts {
  /** Cell size in user units (`mm(0.8)` allowed). */
  spacing: L;
  /** The area the lattice covers, default the drawable. Cells whose centre
   * lies outside it are not part of the lattice: they hold nothing, a write
   * cannot reach them, and the boundary is zero-flux. A shape is lowered by
   * the toolkit, where the sketch frame exists. */
  area?: AreaInput | ShapeValue;
  /** Channel names, default `['a']`. The first is what `field()` reads. */
  channels?: readonly string[];
}

/** A lattice's own numbers, for a sketch that wants the arrays: one
 * `Float32Array` per channel, row-major, `cols × rows` long. Read them; the
 * lattice hands out its own buffers and does not expect them written. */
export type LatticeValues = Record<string, Float32Array>;

/** Memory sanity, the same bound `isolines` keeps: 4M cells is a 16MB
 * buffer per channel. Past that the spacing is a mid-edit transient or a
 * mistake, and either way nothing good comes of allocating for it. */

/**
 * A grid of named channels over an area, and the writes that step it. Made
 * by `t.lattice`; every operation returns a new one.
 */
export class Lattice {
  /** Cells across. */
  readonly cols: number;
  /** Cells up. */
  readonly rows: number;
  /** Cell size in user units. */
  readonly spacing: number;
  /** The rectangle the cells cover, in user units. */
  readonly bounds: Bounds;
  /** The channel names, in the order they were declared. */
  readonly channels: readonly string[];

  /** @internal */ readonly buffers: readonly Float32Array[];
  /** @internal */ readonly mask: Uint8Array;
  /** States kept by the `t.steps` run that made this lattice when it asked
   * for `{ every }`: its start, every `every`-th state and the last, oldest
   * first. Empty otherwise. */
  readonly history: readonly Lattice[];
  private cached: LatticeValues | null = null;

  /** @internal Built by `latticeOf`; a sketch's door is `t.lattice`. */
  constructor(
    cols: number,
    rows: number,
    spacing: number,
    bounds: Bounds,
    channels: readonly string[],
    buffers: readonly Float32Array[],
    mask: Uint8Array,
    history: readonly Lattice[] = [],
  ) {
    this.cols = cols;
    this.rows = rows;
    this.spacing = spacing;
    this.bounds = bounds;
    this.channels = channels;
    this.buffers = buffers;
    this.mask = mask;
    this.history = Object.freeze([...history]);
  }

  /** Cells in the grid — `cols × rows`, 0 for an empty lattice. */
  get n(): number {
    return this.cols * this.rows;
  }

  /** One `Float32Array` per channel, row-major. */
  get values(): LatticeValues {
    if (!this.cached) {
      const out: LatticeValues = {};
      for (let k = 0; k < this.channels.length; k++) out[this.channels[k]] = this.buffers[k];
      this.cached = out;
    }
    return this.cached;
  }

  /** @internal The channel's slot, by name; the first channel by default. */
  private slot(channel: string | undefined, who: string): number {
    const names = this.channels;
    const name = channel ?? names[0];
    for (let k = 0; k < names.length; k++) if (names[k] === name) return k;
    return noChannel(names, name, who);
  }

  /** The cell a position falls in. The indices may lie outside the grid —
   * a position off the lattice has no cell, and this says which way. */
  cell(x: number, y: number): { i: number; j: number };
  /** The cell under a position or a point, as a cell view: its centre, its
   * columns, `laplacian` and `adjacent`. A place off the lattice answers a
   * cell that reads 0 in every column and that no write reaches, as
   * `sample` reads 0 there; nothing (an empty pick) answers nothing. */
  cell(p: XY | undefined): Cell | undefined;
  cell(a: number | XY | undefined, b?: number): { i: number; j: number } | Cell | undefined {
    if (typeof a === 'number') {
      if (!(this.spacing > 0)) return { i: 0, j: 0 };
      return {
        i: Math.floor((a - this.bounds.x) / this.spacing),
        j: Math.floor((b! - this.bounds.y) / this.spacing),
      };
    }
    if (a === undefined || a === null) return undefined;
    const x = vx(a);
    const y = vy(a);
    if (!(this.spacing > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return offCell(this, 0, 0);
    const i = Math.floor((x - this.bounds.x) / this.spacing);
    const j = Math.floor((y - this.bounds.y) / this.spacing);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows || !this.mask[j * this.cols + i]) return offCell(this, i, j);
    return this.cellView(j * this.cols + i);
  }

  // ---- the cells as a table (see CellSelection) ----

  /** Every cell of the lattice as a selection: iterate, `length`, `at`,
   * `filter`, `near`, `slice`, `map`, `without`, and the write `set`. The
   * rows are fixed — a lattice's cells are not added or removed. */
  get cells(): CellSelection {
    return new CellSelection(this, null);
  }

  /** `l.cells.set(...)`: a lattice is one table, so it answers the table's
   * write itself. */
  set(column: string, value: number | ((c: Cell) => number), where?: CellWhere): Lattice;
  set(values: Record<string, number | ((c: Cell) => number)>, where?: CellWhere): Lattice;
  set(...args: unknown[]): Lattice {
    return this.writeCells(null, args);
  }

  /** @internal This lattice with a history (what `t.steps` returns). */
  withHistory(history: readonly Lattice[]): Lattice {
    return new Lattice(this.cols, this.rows, this.spacing, this.bounds, this.channels, this.buffers, this.mask, history);
  }

  /** @internal Every cell row, row-major: one list for every state of
   * this table, since the states share their mask. */
  allCells(): readonly number[] {
    let rows = CELL_ROWS.get(this.mask);
    if (rows === undefined) {
      const out: number[] = [];
      for (let idx = 0; idx < this.n; idx++) if (this.mask[idx]) out.push(idx);
      rows = Object.freeze(out);
      CELL_ROWS.set(this.mask, rows);
    }
    return rows;
  }

  /** @internal The cell at row `idx` as a view of its own. */
  cellView(idx: number): Cell {
    const c = Object.create(CELL_PROTO) as Record<string | symbol, unknown>;
    Object.defineProperty(c, OWNER, { value: this, enumerable: false });
    const i = idx % this.cols;
    const j = (idx - i) / this.cols;
    c.index = idx;
    c.i = i;
    c.j = j;
    c.x = this.bounds.x + (i + 0.5) * this.spacing;
    c.y = this.bounds.y + (j + 0.5) * this.spacing;
    for (let k = 0; k < this.channels.length; k++) c[this.channels[k]] = this.buffers[k][idx];
    return c as unknown as Cell;
  }

  /** @internal The five-point Laplacian of a column at one cell, zero-flux
   * at the area's edge: west, east, south, north, in that order, because
   * float addition is not associative and the ink depends on the order. */
  laplacianAt(channel: string, idx: number, i: number, j: number): number {
    if (idx < 0) return 0;
    const names = this.channels;
    let k = 0;
    while (k < names.length && names[k] !== channel) k++;
    if (k === names.length) return noChannel(names, channel, 'cell.laplacian');
    const a = this.buffers[k];
    const cols = this.cols;
    const rows = this.rows;
    const mask = this.mask;
    const c = a[idx];
    let sum = 0;
    if (i > 0 && mask[idx - 1]) sum += a[idx - 1] - c;
    if (i + 1 < cols && mask[idx + 1]) sum += a[idx + 1] - c;
    if (j > 0 && mask[idx - cols]) sum += a[idx - cols] - c;
    if (j + 1 < rows && mask[idx + cols]) sum += a[idx + cols] - c;
    return sum;
  }

  /** @internal The cells beside one: west, east, north, south in the grid. */
  adjacentCells(idx: number): CellSelection {
    if (idx < 0) return new CellSelection(this, []);
    const { cols, rows, mask } = this;
    const i = idx % cols;
    const j = (idx - i) / cols;
    const out: number[] = [];
    if (j > 0 && mask[idx - cols]) out.push(idx - cols);
    if (i > 0 && mask[idx - 1]) out.push(idx - 1);
    if (i + 1 < cols && mask[idx + 1]) out.push(idx + 1);
    if (j + 1 < rows && mask[idx + cols]) out.push(idx + cols);
    return new CellSelection(this, out);
  }

  /** @internal The cell rows a `where` names among `members` (null: all). */
  cellRowsOf(members: readonly number[] | null, given: boolean, where: unknown, who: string): readonly number[] | null {
    if (!given) return members;
    const all = members ?? this.allCells();
    if (where === undefined || where === null) return [];
    if (typeof where === 'function') {
      const test = where as (c: Cell) => unknown;
      const fw = this.flyweight();
      const out: number[] = [];
      for (const idx of all) if (test(this.fill(fw, idx))) out.push(idx);
      return out;
    }
    let rows: readonly number[];
    if (where instanceof CellSelection) rows = this.ownRows(where.source, who) ? where.indices : [];
    else if (isCell(where)) rows = this.ownRows(where[OWNER], who) && where.index >= 0 ? [where.index] : [];
    else rows = this.cellsUnder(where, who);
    if (members === null) return rows;
    const inside = new Set(members);
    return rows.filter((r) => inside.has(r));
  }

  /** @internal The cells under points — one position, a material, a point
   * selection or a list of positions — each once, row-major, as `add`
   * finds the cell a point falls in. A point off the lattice names none. */
  private cellsUnder(points: unknown, who: string): number[] {
    let m: Material;
    if (isOnePoint(points)) m = makeMaterial([points as XY]);
    else if (points instanceof Material) m = points;
    else if (typeof points === 'object' && points !== null && (Array.isArray(points) || 'points' in points)) m = makeMaterial(points as PointsLike);
    else throw new Error(`${who}: { where } is a cell selection, one cell, a test of the cell, or points — got ${typeof points}`);
    const out = new Set<number>();
    const { cols, rows, spacing, mask } = this;
    for (let p = 0; p < m.n; p++) {
      const i = Math.floor((m.x[p] - this.bounds.x) / spacing);
      const j = Math.floor((m.y[p] - this.bounds.y) / spacing);
      if (i < 0 || j < 0 || i >= cols || j >= rows || !Number.isFinite(m.x[p]) || !Number.isFinite(m.y[p])) continue;
      const idx = j * cols + i;
      if (mask[idx]) out.add(idx);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** @internal Is `other` a state of this lattice's table — the same cells
   * of the same grid? Then its cell rows are rows here. */
  private ownRows(other: Lattice, who: string): boolean {
    if (other === this || other.mask === this.mask) return true;
    throw new Error(`${who}: those cells belong to another lattice — a lattice's cells are rows of its own grid`);
  }

  /** @internal The cell a callback of `set` reads: one view, re-pointed at
   * each cell in turn, so a write over every cell makes no view per cell.
   * It holds the cell only for the call. */
  private flyweight(extra: readonly string[] = []): Record<string, number> {
    const c = Object.create(CELL_PROTO) as Record<string | symbol, unknown>;
    Object.defineProperty(c, OWNER, { value: this, enumerable: false });
    c.index = -1;
    c.i = 0;
    c.j = 0;
    c.x = 0;
    c.y = 0;
    for (const name of this.channels) c[name] = 0;
    // A column the write declares reads 0 before it: its default.
    for (const name of extra) c[name] = 0;
    return c as Record<string, number>;
  }

  private fill(c: Record<string, number>, idx: number): Cell {
    const i = idx % this.cols;
    const j = (idx - i) / this.cols;
    c.index = idx;
    c.i = i;
    c.j = j;
    c.x = this.bounds.x + (i + 0.5) * this.spacing;
    c.y = this.bounds.y + (j + 0.5) * this.spacing;
    const names = this.channels;
    for (let k = 0; k < names.length; k++) c[names[k]] = this.buffers[k][idx];
    return c as unknown as Cell;
  }

  /**
   * @internal The write `set`: columns over the cells `where` names among
   * `members` (null: every cell), ONE instant — every callback reads this
   * lattice as it is, and the new values land together. A column not
   * declared yet is declared, 0 elsewhere. A value that is not finite
   * leaves that cell as it was.
   */
  writeCells(members: readonly number[] | null, args: readonly unknown[]): Lattice {
    const who = 'cells.set';
    let values: Record<string, number | ((c: Cell) => number)>;
    let given: boolean;
    let where: unknown;
    if (typeof args[0] === 'string') {
      if (args.length < 2) throw new Error(`${who}: '${args[0]}' needs a value — a number, or a function of the cell`);
      values = { [args[0]]: args[1] as number | ((c: Cell) => number) };
      given = args.length > 2;
      where = args[2];
    } else {
      if (typeof args[0] !== 'object' || args[0] === null || Array.isArray(args[0])) throw new Error(`${who}: give a column and a value, or a record { column: value }`);
      values = args[0] as Record<string, number | ((c: Cell) => number)>;
      given = args.length > 1;
      where = args[1];
    }
    const names = Object.keys(values);
    for (const name of names) {
      if (RESERVED_CELL_FIELDS.includes(name)) throw new Error(`${who}: '${name}' is a reserved field of a cell, not a column`);
      const v = values[name];
      if (typeof v !== 'number' && typeof v !== 'function') throw new Error(`${who}: the value of '${name}' is a number or a function of the cell — got ${typeof v}`);
    }
    const fresh = names.filter((name) => !this.channels.includes(name));
    const channels = fresh.length === 0 ? this.channels : [...this.channels, ...fresh];
    // null: every cell of the lattice.
    const rows = this.cellRowsOf(members, given, where, who);
    const cells = this.n;
    // A column this write does not name is the same numbers: its buffer is
    // shared, as the mask is — no lattice writes a buffer it holds.
    const buffers = channels.map((name, k) => {
      if (!(name in values)) return this.buffers[k];
      return k < this.buffers.length ? this.buffers[k].slice() : new Float32Array(cells);
    });
    if (rows === null || rows.length > 0) {
      const outs = names.map((name) => buffers[channels.indexOf(name)]);
      const fns = names.map((name) => values[name]);
      const anyFn = fns.some((f) => typeof f === 'function');
      const fw = anyFn ? this.flyweight(fresh) : null;
      const write = (idx: number) => {
        const c = fw === null ? null : this.fill(fw, idx);
        for (let k = 0; k < fns.length; k++) {
          const f = fns[k];
          const v = typeof f === 'number' ? f : f(c!);
          if (Number.isFinite(v)) outs[k][idx] = v;
        }
      };
      if (rows === null) {
        const mask = this.mask;
        for (let idx = 0; idx < cells; idx++) if (mask[idx]) write(idx);
      } else {
        for (let r = 0; r < rows.length; r++) write(rows[r]);
      }
    }
    return new Lattice(this.cols, this.rows, this.spacing, this.bounds, channels, buffers, this.mask);
  }

  /** One cell's value, with no interpolation; 0 off the lattice. */
  sample(channel: string, i: number, j: number): number {
    const k = this.slot(channel, 'lattice.sample');
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return 0;
    const idx = j * this.cols + i;
    return this.mask[idx] ? this.buffers[k][idx] : 0;
  }

  /**
   * A channel as a field: bilinear between cell centres, NaN outside the
   * area — which is what every field consumer already reads as absence, so
   * contours stop at the boundary and generators make nothing beyond it.
   *
   * Near the edge the stencil borrows the containing cell's value for a
   * corner that is off the lattice, so the boundary does not fall away to
   * zero and grow a contour that is not there.
   */
  field(channel?: string): FieldFn2 {
    const k = this.slot(channel, 'lattice.field');
    const { cols, rows, spacing, mask } = this;
    const a = this.buffers[k];
    const bx = this.bounds.x;
    const by = this.bounds.y;
    // An empty lattice reads 0 everywhere: a degenerate input draws
    // nothing, and a field of NaN would take the rest of the sketch with it.
    if (cols === 0 || rows === 0 || !(spacing > 0)) return () => 0;
    return (x: number, y: number): number => {
      const ci = Math.floor((x - bx) / spacing);
      const cj = Math.floor((y - by) / spacing);
      if (ci < 0 || cj < 0 || ci >= cols || cj >= rows) return NaN;
      const home = cj * cols + ci;
      if (!mask[home]) return NaN;
      const u = (x - bx) / spacing - 0.5;
      const v = (y - by) / spacing - 0.5;
      const i0 = Math.floor(u);
      const j0 = Math.floor(v);
      const fx = u - i0;
      const fy = v - j0;
      const at = (i: number, j: number): number => {
        if (i < 0 || j < 0 || i >= cols || j >= rows) return a[home];
        const idx = j * cols + i;
        return mask[idx] ? a[idx] : a[home];
      };
      const v00 = at(i0, j0);
      const v10 = at(i0 + 1, j0);
      const v01 = at(i0, j0 + 1);
      const v11 = at(i0 + 1, j0 + 1);
      return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    };
  }

  /**
   * Deposit `amount` into the cell each point falls in, and return the
   * result; this lattice is unchanged. Points off the lattice deposit
   * nothing. Takes one point, a material, a point selection, or any array
   * of positions.
   */
  add(points: PointsLike | XY, amount: number, channel?: string): Lattice {
    const k = this.slot(channel, 'lattice.add');
    const buffers = this.buffers.map((b) => Float32Array.from(b));
    const out = new Lattice(this.cols, this.rows, this.spacing, this.bounds, this.channels, buffers, this.mask);
    if (!Number.isFinite(amount) || this.n === 0) return out;
    const a = buffers[k];
    const { cols, rows, spacing, mask } = this;
    const bx = this.bounds.x;
    const by = this.bounds.y;
    const drop = (x: number, y: number): void => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const i = Math.floor((x - bx) / spacing);
      const j = Math.floor((y - by) / spacing);
      if (i < 0 || j < 0 || i >= cols || j >= rows) return;
      const idx = j * cols + i;
      if (mask[idx]) a[idx] += amount;
    };
    if (isOnePoint(points)) {
      drop(vx(points as XY), vy(points as XY));
      return out;
    }
    const m = points instanceof Material ? points : makeMaterial(points as PointsLike);
    for (let p = 0; p < m.n; p++) drop(m.x[p], m.y[p]);
    return out;
  }
}

/** A channel this lattice does not have, refused by name. It is its own
 * function so the lookups that call it stay small enough to inline. */
function noChannel(channels: readonly string[], name: string | undefined, who: string): never {
  const known = channels.map((c) => `'${c}'`).join(', ');
  throw new Error(`${who}: no channel '${String(name)}' — this lattice has ${known}`);
}

/** One position rather than a collection of them: `[x, y]` or `{ x, y }`.
 * A material, a selection and an array of points are collections. */
function isOnePoint(v: unknown): boolean {
  if (Array.isArray(v)) return typeof v[0] === 'number' && typeof v[1] === 'number';
  if (v instanceof Material) return false;
  if (typeof v !== 'object' || v === null) return false;
  const o = v as { x?: unknown; y?: unknown };
  return typeof o.x === 'number' && typeof o.y === 'number';
}

/** The empty lattice: what a degenerate input makes. Its field reads 0
 * everywhere and every operation on it is a no-op. */
function emptyLattice(channels: readonly string[], spacing: number): Lattice {
  return new Lattice(0, 0, spacing, { x: 0, y: 0, w: 0, h: 0 }, channels, channels.map(() => new Float32Array(0)), new Uint8Array(0));
}

/**
 * Build a lattice. The toolkit's `t.lattice` is this with the drawable and
 * the sketch's length resolution filled in; a shape area is already lowered
 * to loops by the time it arrives.
 */
export function latticeOf(env: LatticeEnv, opts: LatticeOpts, init?: LatticeInit): Lattice {
  if (!opts || typeof opts !== 'object') throw new Error('lattice: { spacing } is required');
  if (opts.spacing === undefined) throw new Error('lattice: { spacing } is required');
  const channels = opts.channels === undefined ? ['a'] : [...opts.channels];
  if (channels.length === 0) throw new Error('lattice: { channels } must name at least one channel');
  for (const c of channels) {
    if (typeof c !== 'string' || c.length === 0) throw new Error(`lattice: a channel name must be a non-empty string, got ${JSON.stringify(c)}`);
  }
  if (new Set(channels).size !== channels.length) throw new Error(`lattice: repeated channel name in [${channels.map((c) => `'${c}'`).join(', ')}]`);

  // A spacing at or below zero yields no cells — the same rule sample,
  // scatter, settle, isolines and the fills read.
  if (!usableLength(opts.spacing)) return emptyLattice(channels, 0);
  const spacing = env.len(opts.spacing);
  if (!(spacing > 0) || !Number.isFinite(spacing)) return emptyLattice(channels, 0);

  let box: Bounds;
  let loops: [number, number][][] | null = null;
  if (opts.area === undefined) {
    box = { x: env.bounds.x, y: env.bounds.y, w: env.bounds.w, h: env.bounds.h };
  } else {
    const area = opts.area;
    if (typeof area === 'object' && area !== null && '__occludeShape' in area) {
      throw new Error('lattice: a shape area is lowered by the toolkit (t.lattice), where the sketch frame is known — pass loops, a face or a material here');
    }
    loops = numericLoops(area as AreaInput, 'lattice');
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const loop of loops) for (const [x, y] of loop) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    // An area with no extent holds nothing.
    if (!Number.isFinite(x0) || !(x1 > x0) || !(y1 > y0)) return emptyLattice(channels, spacing);
    box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (!(box.w > 0) || !(box.h > 0)) return emptyLattice(channels, spacing);

  const cols = Math.ceil(box.w / spacing);
  const rows = Math.ceil(box.h / spacing);
  if (!(cols > 0) || !(rows > 0)) return emptyLattice(channels, spacing);
  const cells = cols * rows;
  // No cap: the spacing is the artist's. The one refusal is the machine's —
  // a raster that does not fit a Float64Array — named with the count.
  try {
    new Float64Array(cells);
  } catch (e) {
    if (e instanceof RangeError) throw new Error(`lattice: a raster of ${cols} × ${rows} = ${cells} cells does not fit a Float64Array — the spacing is too fine for this machine`);
    throw e;
  }
  // The grid is a whole number of cells, centred on the area's box, so the
  // overhang is the same on both sides and a cell centre is always
  // `bounds.x + (i + ½)·spacing`.
  const bounds: Bounds = {
    x: box.x - (cols * spacing - box.w) / 2,
    y: box.y - (rows * spacing - box.h) / 2,
    w: cols * spacing,
    h: rows * spacing,
  };

  const mask = new Uint8Array(cells);
  if (loops === null) {
    mask.fill(1);
  } else {
    // Loops carry no winding rule of their own, so they read even-odd —
    // exactly as `distanceTo` and the other loop consumers document.
    const inside = areaFill(loops, 'evenodd').at;
    for (let j = 0; j < rows; j++) {
      const cy = bounds.y + (j + 0.5) * spacing;
      for (let i = 0; i < cols; i++) {
        mask[j * cols + i] = inside(bounds.x + (i + 0.5) * spacing, cy) > 0 ? 1 : 0;
      }
    }
  }

  const buffers = channels.map(() => new Float32Array(cells));
  if (init) {
    for (let j = 0; j < rows; j++) {
      const cy = bounds.y + (j + 0.5) * spacing;
      for (let i = 0; i < cols; i++) {
        const idx = j * cols + i;
        if (!mask[idx]) continue;
        const v = init(bounds.x + (i + 0.5) * spacing, cy);
        if (typeof v === 'number') {
          // One number is the first channel — the one `field()` reads.
          buffers[0][idx] = Number.isFinite(v) ? v : 0;
          continue;
        }
        if (typeof v !== 'object' || v === null) continue;
        for (const [name, value] of Object.entries(v)) {
          const k = channels.indexOf(name);
          if (k < 0) throw new Error(`lattice: init set no channel '${name}' — this lattice has ${channels.map((c) => `'${c}'`).join(', ')}`);
          buffers[k][idx] = Number.isFinite(value) ? value : 0;
        }
      }
    }
  }
  return new Lattice(cols, rows, spacing, bounds, channels, buffers, mask);
}

// ---- cells ---------------------------------------------------------------------------

/** The cell rows of each mask: every state of one lattice shares its mask,
 * so the list is built once for all of them. */
const CELL_ROWS = new WeakMap<Uint8Array, readonly number[]>();

/** The lattice a cell view belongs to: non-enumerable, so a cell spreads
 * and serialises as its fields. */
const OWNER = Symbol('lattice');

/** The names a cell view owns; a column may not be called one of these. */
const RESERVED_CELL_FIELDS: readonly string[] = ['index', 'i', 'j', 'x', 'y', 'laplacian', 'adjacent'];

/**
 * One cell of a lattice: its row `index`, its grid place `i`, `j`, its
 * centre `x`, `y`, and every column by name. `laplacian(column)` is the
 * five-point stencil at the cell, zero-flux at the area's edge, and
 * `adjacent` the cells beside it.
 */
export type Cell = {
  readonly index: number;
  readonly i: number;
  readonly j: number;
  readonly x: number;
  readonly y: number;
  /** `Σ(neighbour − this)` over the four cells beside this one that are in
   * the lattice: what diffuses. */
  laplacian(column: string): number;
  /** The cells beside this one, in the lattice. */
  readonly adjacent: CellSelection;
} & Record<string, number>;

/** Which cells a `set` writes: a cell selection, one cell, a test of the
 * cell, or points — the cells they fall in. */
export type CellWhere = CellSelection | Cell | ((c: Cell) => unknown) | PointsLike | XY | undefined;

const CELL_PROTO = Object.freeze(Object.create(Object.prototype, {
  laplacian: {
    value(this: Cell & { [OWNER]: Lattice }, column: string): number {
      return this[OWNER].laplacianAt(column, this.index, this.i, this.j);
    },
  },
  adjacent: {
    get(this: Cell & { [OWNER]: Lattice }): CellSelection {
      return this[OWNER].adjacentCells(this.index);
    },
  },
}) as object);

const isCell = (v: unknown): v is Cell & { [OWNER]: Lattice } =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === CELL_PROTO;

/** A place off the lattice as a cell: it reads 0 everywhere, and its row
 * is -1, which no write reaches. */
function offCell(l: Lattice, i: number, j: number): Cell {
  const c = Object.create(CELL_PROTO) as Record<string | symbol, unknown>;
  Object.defineProperty(c, OWNER, { value: l, enumerable: false });
  c.index = -1;
  c.i = i;
  c.j = j;
  c.x = l.bounds.x + (i + 0.5) * l.spacing;
  c.y = l.bounds.y + (j + 0.5) * l.spacing;
  for (const name of l.channels) c[name] = 0;
  return c as unknown as Cell;
}

/**
 * Cells of one lattice: the whole table (`l.cells`) or the rows a filter
 * picked, in row-major order. It reads like a point selection — iterate,
 * `length`, `at`, `map`, `filter`, `near`, `slice`, `without` — and a
 * lattice's cells are fixed rows, so its writes are `set` alone: `add` and
 * `remove` refuse by name.
 */
export class CellSelection implements Iterable<Cell> {
  /** The lattice selected from. */
  readonly source: Lattice;
  private readonly memberRows: readonly number[] | null;

  /** @internal Use `l.cells` and `filter`. `rows` null means every cell. */
  constructor(source: Lattice, rows: readonly number[] | null) {
    this.source = source;
    this.memberRows = rows;
    Object.freeze(this);
  }

  /** The selected cell rows, row-major. */
  get indices(): readonly number[] {
    return this.memberRows ?? this.source.allCells();
  }

  get length(): number {
    return this.indices.length;
  }

  /** The member at position `i`; a negative `i` counts back from the end. */
  at(i: number): Cell {
    const rows = this.indices;
    const k = i < 0 ? rows.length + i : i;
    if (!Number.isInteger(k) || k < 0 || k >= rows.length) throw new Error(`cells.at: no member ${i} (${rows.length} members)`);
    return this.source.cellView(rows[k]);
  }

  *[Symbol.iterator](): Iterator<Cell> {
    for (const idx of this.indices) yield this.source.cellView(idx);
  }

  map<T>(fn: (c: Cell, i: number) => T): T[] {
    return this.indices.map((idx, i) => fn(this.source.cellView(idx), i));
  }

  forEach(fn: (c: Cell, i: number) => void): void {
    this.indices.forEach((idx, i) => fn(this.source.cellView(idx), i));
  }

  find(fn: (c: Cell, i: number) => unknown): Cell | undefined {
    const rows = this.indices;
    for (let i = 0; i < rows.length; i++) {
      const c = this.source.cellView(rows[i]);
      if (fn(c, i)) return c;
    }
    return undefined;
  }

  some(fn: (c: Cell, i: number) => unknown): boolean {
    return this.find(fn) !== undefined;
  }

  every(fn: (c: Cell, i: number) => unknown): boolean {
    const rows = this.indices;
    for (let i = 0; i < rows.length; i++) if (!fn(this.source.cellView(rows[i]), i)) return false;
    return true;
  }

  /** The cells `fn` picks, as a selection of the same lattice. */
  filter(fn: (c: Cell, i: number) => unknown): CellSelection {
    const rows = this.indices;
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) if (fn(this.source.cellView(rows[i]), i)) out.push(rows[i]);
    return new CellSelection(this.source, out);
  }

  /** The cells of this selection whose centre is CLOSER THAN `radius` to
   * `p`. */
  near(p: XY, opts: { radius: number }): CellSelection {
    const radius = opts.radius;
    if (!(radius > 0)) throw new Error('near: radius must be a positive distance');
    const l = this.source;
    const px = vx(p);
    const py = vy(p);
    if (l.n === 0 || !Number.isFinite(px) || !Number.isFinite(py)) return new CellSelection(l, []);
    const { cols, rows, spacing, bounds } = l;
    const i0 = Math.max(0, Math.floor((px - radius - bounds.x) / spacing));
    const i1 = Math.min(cols - 1, Math.floor((px + radius - bounds.x) / spacing));
    const j0 = Math.max(0, Math.floor((py - radius - bounds.y) / spacing));
    const j1 = Math.min(rows - 1, Math.floor((py + radius - bounds.y) / spacing));
    const inside = this.memberRows === null ? null : new Set(this.memberRows);
    const out: number[] = [];
    const r2 = radius * radius;
    for (let j = j0; j <= j1; j++) {
      const dy = py - (bounds.y + (j + 0.5) * spacing);
      for (let i = i0; i <= i1; i++) {
        const idx = j * cols + i;
        if (!l.mask[idx] || (inside !== null && !inside.has(idx))) continue;
        const dx = px - (bounds.x + (i + 0.5) * spacing);
        if (dx * dx + dy * dy < r2) out.push(idx);
      }
    }
    return new CellSelection(l, out);
  }

  /** The members at positions `start` up to `end`, as an array's `slice`. */
  slice(start?: number, end?: number): CellSelection {
    return new CellSelection(this.source, this.indices.slice(start, end));
  }

  /** The members that `other` — a cell selection or one cell — does not
   * name. Nothing takes nothing away. */
  without(other: CellSelection | Cell | undefined): CellSelection {
    const gone = new Set(this.source.cellRowsOf(null, true, other, 'cells.without') ?? []);
    if (gone.size === 0) return this;
    return new CellSelection(this.source, this.indices.filter((idx) => !gone.has(idx)));
  }

  /** A lattice's cells are fixed: there is no row to add. */
  add(): never {
    throw new Error("cells.add: a lattice's cells are fixed — set a column instead");
  }

  /** A lattice's cells are fixed: there is no row to remove. */
  remove(): never {
    throw new Error("cells.remove: a lattice's cells are fixed — set a column instead");
  }

  /**
   * The lattice with columns set on this selection's cells — every one, or
   * those `where` names: a cell selection, one cell, a test of the cell,
   * or points, which name the cells they fall in. A value is a number or a function of the cell; the record form
   * sets several columns in ONE instant, every function reading the cells
   * as they were. A column not declared yet is declared, 0 elsewhere. A
   * value that is not finite leaves that cell as it was, and a `where`
   * that names nothing writes nothing.
   */
  set(column: string, value: number | ((c: Cell) => number), where?: CellWhere): Lattice;
  set(values: Record<string, number | ((c: Cell) => number)>, where?: CellWhere): Lattice;
  set(...args: unknown[]): Lattice {
    return this.source.writeCells(this.memberRows, args);
  }
}

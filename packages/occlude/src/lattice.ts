/**
 * A grid of values you can step.
 *
 * A field is a pure function of position, which is the right shape for
 * noise, distance and gradients, and the wrong one for anything that has to
 * remember what it was a moment ago. Reaction-diffusion, physarum trails,
 * erosion, "draw where the pen has been", ink owed and paid — each of those
 * is a local rule applied over and over to a substrate, and each of them
 * was, once, a hand-rolled Float32Array and a hand-rolled five-tap blur
 * inside the sketch.
 *
 * `t.lattice` is that substrate: a regular grid of square FACES over an
 * area, with named columns. `l.faces` is the one faces interface — the
 * same row words a tiling's or a Voronoi diagram's faces answer — over a
 * storage of its own: the faces are implicit in `(i, j)`, and a column is
 * one `Float32Array`, row-major. The write is `set` (every function reads
 * the faces as they were, so a pass over the whole grid is one instant),
 * a run steps it (`t.steps(n, lat, (l) => l.set(…))`), and `field(column)`
 * hands a column back out, so everything that reads a field — `isolines`,
 * `scatter`, a fill, `decimate` — reads a lattice too. A face answers its
 * `laplacian`, which is what diffusion is written with, and `spend` takes
 * the nib footprint of drawn marks off a column: `t.residual` is a lattice
 * of the tone a drawing still owes.
 *
 * Recipes stay recipes. There is no `reactionDiffusion()` and no
 * `physarum()`: those are four lines of a pass each, written in the sketch.
 *
 * Conventions follow the rest of the raster code. Face `(i, j)` has its
 * centre at `bounds.x + (i + ½)·spacing`, row-major, exactly as
 * `densityRaster` (points.ts) places its samples. Values are `Float32Array`
 * — a lattice is a picture of a quantity, not a coordinate, and half the
 * memory means twice the grid.
 *
 * The value never mutates: `set`, `add` and `spend` return a new lattice,
 * and the one it came from still reads what it read before. A column a
 * write does not touch is the same buffer in both, as the mask is.
 */

import { areaFill } from './area.js';
import { numericLoops, type AreaInput, type Geometry } from './boundary.js';
import { chainRecordsOf } from './curves.js';
import { usableLength } from './guard.js';
import type { IsoContour } from './isolines.js';
import { box, type Box } from './layout.js';
import { Material, RowViews, material as makeMaterial, type PointsLike } from './material.js';
import { Column, at32, at64, columnOf, type ColumnLike, type ColumnWriter } from './column.js';
import type { Bounds, FieldFn2 } from './points.js';
import { Len, type L } from './units.js';
import { vx, vy, type XY } from './vec.js';
import { Selection, select, domainKind, isSelectionOf, type Domain, type DomainKind, type Types, ROW_TYPES } from './selection.js';
// Type-only (erased): a shape area is recognised and refused here, never
// lowered — the toolkit does that, where the sketch frame is known.
import type { ShapeValue } from './api.js';

/** Environment handed in by the toolkit: drawable bounds and sketch-time
 * length resolution, both in user units — the same pair `isolines` takes. */
export interface LatticeEnv {
  bounds: Bounds;
  len(l: L): number;
}

/** A face's starting value: one number for the first column, or a record
 * naming the columns it sets. Evaluated at the face's centre. */
export type LatticeInit = (x: number, y: number) => number | Record<string, number>;

export interface LatticeOpts {
  /** Face size in user units (`mm(0.8)` allowed). */
  spacing: L;
  /** The area the lattice covers, default the drawable. Faces whose centre
   * lies outside it are not part of the lattice: they hold nothing, a write
   * cannot reach them, and the boundary is zero-flux. A shape is lowered by
   * the toolkit, where the sketch frame exists. */
  area?: AreaInput | ShapeValue;
  /** Column names, default `['a']`. The first is what `field()` reads. */
  channels?: readonly string[];
}

/** A lattice's own numbers, for a sketch that wants the arrays: one
 * `Float32Array` per column, row-major, `cols × rows` long. Read them; the
 * lattice hands out its own buffers and does not expect them written. */
export type LatticeValues = Record<string, Float32Array>;

/** What `spend` accepts: a material or a selection (its chains stroked, and
 * a point no chain touches dotted), a contour record or a list of them, or a
 * plain polyline of positions — one position on its own is a dot. */
export type SpendMarks =
  | Geometry
  | IsoContour
  | readonly IsoContour[]
  | readonly XY[];

export interface SpendOpts {
  /** The nib, in the lattice's own units: a stroke covers a band this wide,
   * a dot a disc this across. A physical nib is `t.len(mm(0.35))` — a
   * lattice is resolved data, and it does not know the paper. */
  width: number;
}

/**
 * A grid of named columns over an area, and the writes that step it. Made
 * by `t.lattice` (or `t.residual`); every operation returns a new one.
 */
export class Lattice {
  /** Faces across. */
  readonly cols: number;
  /** Faces up. */
  readonly rows: number;
  /** Face size in user units. */
  readonly spacing: number;
  /** The rectangle the grid covers, in user units. */
  readonly bounds: Bounds;
  /** The column names, in the order they were declared. */
  readonly channels: readonly string[];

  /** @internal One persistent column per channel (column.ts), row-major:
   * a write copies only the leaves it touches, so a spend of a few faces
   * copies a few leaves and every state of a ledger shares the rest. */
  readonly columns: readonly Column<Float32Array>[];
  /** @internal */ readonly mask: Uint8Array;
  /** States kept by the `t.steps` run that made this lattice when it asked
   * for `{ every }`: its start, every `every`-th state and the last, oldest
   * first. Empty otherwise. */
  readonly history: readonly Lattice[];
  private cached: LatticeValues | null = null;
  /** @internal The faces as a domain, made the first time they are read. */
  private faceBox: LatticeFaceDomain | null = null;
  /** @internal `faces`, kept once read. */
  private facesSel: Selection<LatticeFace> | null = null;
  /** @internal The face views, one per face, made on first read and kept:
   * `===` names a face within a state. */
  private views: RowViews<LatticeFace> | null = null;

  /** @internal Built by `latticeOf`; a sketch's door is `t.lattice`. */
  constructor(
    cols: number,
    rows: number,
    spacing: number,
    bounds: Bounds,
    channels: readonly string[],
    columns: readonly ColumnLike<Float32Array>[],
    mask: Uint8Array,
    history: readonly Lattice[] = [],
  ) {
    this.cols = cols;
    this.rows = rows;
    this.spacing = spacing;
    this.bounds = bounds;
    this.channels = channels;
    this.columns = columns.map(columnOf);
    this.mask = mask;
    this.history = Object.freeze([...history]);
  }

  /** Squares in the grid — `cols × rows`, 0 for an empty lattice. The
   * faces are the squares the area names, `faces.length` of them. */
  get n(): number {
    return this.cols * this.rows;
  }

  /** One `Float32Array` per column, row-major. */
  get values(): LatticeValues {
    if (!this.cached) {
      const out: LatticeValues = {};
      for (let k = 0; k < this.channels.length; k++) out[this.channels[k]] = this.columns[k].flat();
      this.cached = out;
    }
    return this.cached;
  }

  /** @internal The column's slot, by name; the first column by default. */
  private slot(channel: string | undefined, who: string): number {
    const names = this.channels;
    const name = channel ?? names[0];
    for (let k = 0; k < names.length; k++) if (names[k] === name) return k;
    return noChannel(names, name, who);
  }

  /** @internal This lattice with one column replaced. */
  private withColumn(k: number, column: Column<Float32Array>): Lattice {
    const columns = this.columns.slice();
    columns[k] = column;
    return new Lattice(this.cols, this.rows, this.spacing, this.bounds, this.channels, columns, this.mask);
  }

  // ---- the faces as a table ----

  /**
   * Every face of the lattice as a selection, in row-major order: the words
   * every selection has, `near` (by the face's centre), the relations
   * across the four sides, the union outline `contours()`, and the write
   * `set`. The rows are fixed — a lattice's faces are not added or removed.
   */
  get faces(): Selection<LatticeFace> {
    return (this.facesSel ??= select(this.faceDomain(), null));
  }

  /**
   * The face under a position or a point. A place off the lattice answers
   * a face that reads 0 in every column and that no write reaches, as
   * `sample` reads 0 there; nothing (an empty pick) answers nothing.
   */
  face(p: XY | undefined): LatticeFace | undefined {
    if (p === undefined || p === null) return undefined;
    const x = vx(p);
    const y = vy(p);
    // A place that is not finite is on no cell: it reads as a place off the
    // lattice, at no grid place (-1, -1).
    if (!(this.spacing > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return offFace(this, -1, -1);
    const i = Math.floor((x - this.bounds.x) / this.spacing);
    const j = Math.floor((y - this.bounds.y) / this.spacing);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows || !this.mask[j * this.cols + i]) return offFace(this, i, j);
    return this.faceView(j * this.cols + i);
  }

  /** @internal The faces as a domain, one per lattice. */
  faceDomain(): LatticeFaceDomain {
    return (this.faceBox ??= new LatticeFaceDomain(this));
  }

  /** `l.faces.set(...)`: a lattice is one table, so it answers the table's
   * write itself. */
  set(column: string, value: number | ((f: LatticeFace) => number), where?: LatticeWhere): Lattice;
  set(values: Record<string, number | ((f: LatticeFace) => number)>, where?: LatticeWhere): Lattice;
  set(...args: unknown[]): Lattice {
    return this.writeFaces(null, args);
  }

  /** @internal This lattice with a history (what `t.steps` returns). */
  withHistory(history: readonly Lattice[]): Lattice {
    return new Lattice(this.cols, this.rows, this.spacing, this.bounds, this.channels, this.columns, this.mask, history);
  }

  /** @internal Every face row, row-major: one list for every state of
   * this table, since the states share their mask. */
  allFaces(): readonly number[] {
    let rows = FACE_ROWS.get(this.mask);
    if (rows === undefined) {
      const out: number[] = [];
      for (let idx = 0; idx < this.n; idx++) if (this.mask[idx]) out.push(idx);
      rows = Object.freeze(out);
      FACE_ROWS.set(this.mask, rows);
    }
    return rows;
  }

  /** @internal The face at row `idx` as a view: one frozen object per
   * face of this state, made the first time it is read and kept. */
  faceView(idx: number): LatticeFace {
    const views = (this.views ??= new RowViews<LatticeFace>(this.n));
    let view = views.get(idx);
    if (view === undefined) {
      const f = Object.create(FACE_PROTO) as Record<string | symbol, unknown>;
      Object.defineProperty(f, OWNER, { value: this, enumerable: false });
      const i = idx % this.cols;
      f.index = idx;
      f.i = i;
      f.j = (idx - i) / this.cols;
      for (let k = 0; k < this.channels.length; k++) f[this.channels[k]] = at32(this.columns[k], idx);
      view = views.set(idx, Object.freeze(f) as unknown as LatticeFace);
    }
    return view;
  }

  /** @internal The five-point Laplacian of a column at one face, zero-flux
   * at the area's edge: west, east, south, north, in that order, because
   * float addition is not associative and the ink depends on the order. */
  laplacianAt(channel: string, idx: number, i: number, j: number): number {
    if (idx < 0) return 0;
    const names = this.channels;
    let k = 0;
    while (k < names.length && names[k] !== channel) k++;
    if (k === names.length) return noChannel(names, channel, 'face.laplacian');
    // Every face of a pass reads its four neighbours: one flat per column
    // value, joined once.
    const a = this.columns[k].flat();
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

  /** @internal The faces beside one, in row order: north, west, east,
   * south in the grid. */
  adjacentFaces(idx: number): Selection<LatticeFace> {
    return select(this.faceDomain(), this.adjacentRows(idx), undefined, true);
  }

  /** @internal The rows of the faces beside one, in row order. */
  adjacentRows(idx: number): number[] {
    if (idx < 0) return [];
    const { cols, rows, mask } = this;
    const i = idx % cols;
    const j = (idx - i) / cols;
    const out: number[] = [];
    if (j > 0 && mask[idx - cols]) out.push(idx - cols);
    if (i > 0 && mask[idx - 1]) out.push(idx - 1);
    if (i + 1 < cols && mask[idx + 1]) out.push(idx + 1);
    if (j + 1 < rows && mask[idx + cols]) out.push(idx + cols);
    return out;
  }

  /** @internal The face rows a `where` names among `members` (null: all). */
  faceRowsOf(members: readonly number[] | null, given: boolean, where: unknown, who: string): readonly number[] | null {
    if (!given) return members;
    const all = members ?? this.allFaces();
    if (where === undefined || where === null) return [];
    if (typeof where === 'function') {
      const test = where as (f: LatticeFace) => unknown;
      const fw = this.flyweight();
      const out: number[] = [];
      for (const idx of all) if (test(this.fill(fw, idx))) out.push(idx);
      return out;
    }
    let rows: readonly number[];
    if (isSelectionOf(where, LATTICE_FACES)) rows = this.ownRows(where.source as Lattice, who) ? where.indices : [];
    else if (isLatticeFace(where)) rows = this.ownRows(where[OWNER], who) && where.index >= 0 ? [where.index] : [];
    else rows = this.facesUnder(where, who);
    if (members === null) return rows;
    const inside = new Set(members);
    return rows.filter((r) => inside.has(r));
  }

  /** @internal The faces under points — one position, a material, a point
   * selection or a list of positions — each once, row-major, as `add`
   * finds the face a point falls in. A point off the lattice names none. */
  private facesUnder(points: unknown, who: string): number[] {
    let m: Material;
    if (isOnePoint(points)) m = makeMaterial([points as XY]);
    else if (points instanceof Material) m = points;
    else if (typeof points === 'object' && points !== null && (Array.isArray(points) || 'points' in points)) m = makeMaterial(points as PointsLike);
    else throw new Error(`${who}: { where } is a face selection, one face, a test of the face, or points — got ${typeof points}`);
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

  /** @internal Is `other` a state of this lattice's table — the same faces
   * of the same grid? Then its face rows are rows here. */
  ownRows(other: Lattice, who: string): boolean {
    if (other === this || other.mask === this.mask) return true;
    throw new Error(`${who}: those faces belong to another lattice — a lattice's faces are rows of its own grid`);
  }

  /** @internal The face a callback of `set` reads: one view, re-pointed at
   * each face in turn, so a write over every face makes no view per face.
   * It holds the face only for the call. */
  private flyweight(extra: readonly string[] = []): Record<string, number> {
    const f = Object.create(FACE_PROTO) as Record<string | symbol, unknown>;
    Object.defineProperty(f, OWNER, { value: this, enumerable: false });
    f.index = -1;
    f.i = 0;
    f.j = 0;
    for (const name of this.channels) f[name] = 0;
    // A column the write declares reads 0 before it: its default.
    for (const name of extra) f[name] = 0;
    return f as Record<string, number>;
  }

  private fill(f: Record<string, number>, idx: number): LatticeFace {
    const i = idx % this.cols;
    f.index = idx;
    f.i = i;
    f.j = (idx - i) / this.cols;
    const names = this.channels;
    for (let k = 0; k < names.length; k++) f[names[k]] = at32(this.columns[k], idx);
    return f as unknown as LatticeFace;
  }

  /** `fill`, from the columns' flats: a write over every face reads every
   * face. */
  private fillFlat(f: Record<string, number>, idx: number, flats: readonly Float32Array[]): LatticeFace {
    const i = idx % this.cols;
    f.index = idx;
    f.i = i;
    f.j = (idx - i) / this.cols;
    const names = this.channels;
    for (let k = 0; k < names.length; k++) f[names[k]] = flats[k][idx];
    return f as unknown as LatticeFace;
  }

  /**
   * @internal The write `set`: columns over the faces `where` names among
   * `members` (null: every face), ONE instant — every callback reads this
   * lattice as it is, and the new values land together. A column not
   * declared yet is declared, 0 elsewhere. A value that is not finite
   * leaves that face as it was.
   */
  writeFaces(members: readonly number[] | null, args: readonly unknown[]): Lattice {
    const who = 'faces.set';
    let values: Record<string, number | ((f: LatticeFace) => number)>;
    let given: boolean;
    let where: unknown;
    if (typeof args[0] === 'string') {
      if (args.length < 2) throw new Error(`${who}: '${args[0]}' needs a value — a number, or a function of the face`);
      values = { [args[0]]: args[1] as number | ((f: LatticeFace) => number) };
      given = args.length > 2;
      where = args[2];
    } else {
      if (typeof args[0] !== 'object' || args[0] === null || Array.isArray(args[0])) throw new Error(`${who}: give a column and a value, or a record { column: value }`);
      values = args[0] as Record<string, number | ((f: LatticeFace) => number)>;
      given = args.length > 1;
      where = args[1];
    }
    const names = Object.keys(values);
    for (const name of names) {
      checkColumnName(name, who);
      const v = values[name];
      if (typeof v !== 'number' && typeof v !== 'function') throw new Error(`${who}: the value of '${name}' is a number or a function of the face — got ${typeof v}`);
    }
    const fresh = names.filter((name) => !this.channels.includes(name));
    const channels = fresh.length === 0 ? this.channels : [...this.channels, ...fresh];
    // null: every face of the lattice.
    const rows = this.faceRowsOf(members, given, where, who);
    const cells = this.n;
    // A column this write does not name is the same numbers: its column is
    // shared, as the mask is — no lattice writes a column it holds — and a
    // column it names copies only the leaves the write reaches.
    const reach = rows === null ? 'all' : rows;
    const writers = names.map((name) => {
      const k = channels.indexOf(name);
      return (k < this.columns.length ? this.columns[k] : Column.zeros(Float32Array, cells)).writer(reach);
    });
    if (rows === null || rows.length > 0) {
      const fns = names.map((name) => values[name]);
      const fw = fns.some((f) => typeof f === 'function') ? this.flyweight(fresh) : null;
      if (rows === null) this.writeEvery(fns, fw, writers.map((w) => w.array()!));
      else this.writeSome(rows, fns, fw, writers);
    }
    const columns = channels.map((name, k) => {
      const w = names.indexOf(name);
      return w >= 0 ? writers[w].done() : this.columns[k];
    });
    return new Lattice(this.cols, this.rows, this.spacing, this.bounds, channels, columns, this.mask);
  }

  /** The write over every face: it reads every face, so it reads the
   * flats, and a dense write is one array per column. */
  private writeEvery(fns: readonly (number | ((f: LatticeFace) => number))[], fw: Record<string, number> | null, outs: readonly Float32Array[]): void {
    const flats = fw === null ? [] : this.columns.map((c) => c.flat());
    const write = (idx: number) => {
      const f = fw === null ? null : this.fillFlat(fw, idx, flats);
      for (let k = 0; k < fns.length; k++) {
        const fn = fns[k];
        const v = typeof fn === 'number' ? fn : fn(f!);
        if (Number.isFinite(v)) outs[k][idx] = v;
      }
    };
    const cells = this.n;
    const mask = this.mask;
    for (let idx = 0; idx < cells; idx++) if (mask[idx]) write(idx);
  }

  /** The write over some faces: each read and written through its column. */
  private writeSome(rows: readonly number[], fns: readonly (number | ((f: LatticeFace) => number))[], fw: Record<string, number> | null, writers: readonly ColumnWriter<Float32Array>[]): void {
    for (let r = 0; r < rows.length; r++) {
      const idx = rows[r];
      const f = fw === null ? null : this.fill(fw, idx);
      for (let k = 0; k < fns.length; k++) {
        const fn = fns[k];
        const v = typeof fn === 'number' ? fn : fn(f!);
        if (Number.isFinite(v)) writers[k].set(idx, v);
      }
    }
  }

  /** One face's value by its grid place, with no interpolation; 0 off the
   * lattice. */
  sample(channel: string, i: number, j: number): number {
    const k = this.slot(channel, 'lattice.sample');
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return 0;
    const idx = j * this.cols + i;
    return this.mask[idx] ? at32(this.columns[k], idx) : 0;
  }

  /**
   * A column as a field: bilinear between face centres, NaN outside the
   * area — which is what every field consumer already reads as absence, so
   * contours stop at the boundary and generators make nothing beyond it.
   *
   * Near the edge the stencil borrows the containing face's value for a
   * corner that is off the lattice, so the boundary does not fall away to
   * zero and grow a contour that is not there.
   */
  field(channel?: string): FieldFn2 {
    const k = this.slot(channel, 'lattice.field');
    const { cols, rows, spacing, mask } = this;
    // A field reads a few faces per sample: through the column, so a
    // ledger that reads its field after every spend never joins one.
    const a = this.columns[k];
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
        if (i < 0 || j < 0 || i >= cols || j >= rows) return at32(a, home);
        const idx = j * cols + i;
        return at32(a, mask[idx] ? idx : home);
      };
      const v00 = at(i0, j0);
      const v10 = at(i0 + 1, j0);
      const v01 = at(i0, j0 + 1);
      const v11 = at(i0 + 1, j0 + 1);
      return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    };
  }

  /**
   * Deposit `amount` into the face each point falls in, and return the
   * result; this lattice is unchanged. Points off the lattice deposit
   * nothing. Takes one point, a material, a point selection, or any array
   * of positions.
   */
  add(points: PointsLike | XY, amount: number, channel?: string): Lattice {
    const k = this.slot(channel, 'lattice.add');
    const a = this.columns[k].writer('some');
    if (!Number.isFinite(amount) || this.n === 0) return this.withColumn(k, this.columns[k]);
    const { cols, rows, spacing, mask } = this;
    const bx = this.bounds.x;
    const by = this.bounds.y;
    const drop = (x: number, y: number): void => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const i = Math.floor((x - bx) / spacing);
      const j = Math.floor((y - by) / spacing);
      if (i < 0 || j < 0 || i >= cols || j >= rows) return;
      const idx = j * cols + i;
      // Summed in the column's own precision, deposit by deposit.
      if (mask[idx]) a.set(idx, a.get(idx) + amount);
    };
    if (isOnePoint(points)) {
      drop(vx(points as XY), vy(points as XY));
      return this.withColumn(k, a.done());
    }
    const m = points instanceof Material ? points : makeMaterial(points as PointsLike);
    const { x, y } = m.store;
    for (let p = 0; p < m.n; p++) drop(at64(x, p), at64(y, p));
    return this.withColumn(k, a.done());
  }

  /**
   * Take the nib footprint of `marks` off a column (the first by default),
   * and return the result; this lattice is unchanged.
   *
   * A face gives up the part of it the nib covers, 0 to 1 of its area, and
   * never goes below 0: a mark over a face that holds nothing takes nothing.
   * With a column of tone owed, 0 to 1 — what `t.residual` makes — what a
   * spend took is the drop in `faces.sum(column)`, in FACE AREAS: a face
   * paid from 1 down to 0 is 1, and a face half covered over a tone of 0.5
   * is 0.25. Multiply by `spacing²` for sketch-area units.
   */
  spend(marks: SpendMarks, how: SpendOpts, channel?: string): Lattice {
    const who = 'lattice.spend';
    if (!how || typeof how !== 'object' || how.width === undefined) {
      throw new Error(`${who}: { width } is required — the nib the marks are drawn with, such as t.len(mm(0.3))`);
    }
    if ((how.width as unknown) instanceof Len) {
      throw new Error(`${who}: width is a length in the lattice's own units — a lattice does not know the paper, so resolve the nib with t.len first: { width: t.len(mm(0.35)) }`);
    }
    const k = this.slot(channel, who);
    const lines = markLines(marks);
    const width = how.width;
    const cells = this.n;
    if (cells === 0 || typeof width !== 'number' || !(width > 0) || !Number.isFinite(width)) return this.withColumn(k, this.columns[k]);
    const r = width / 2;
    const { cols, rows, spacing, bounds, mask } = this;

    // One scratch surface for coverage, shared by every spend: a spend
    // touches a few faces and clears exactly those, so a long loop
    // allocates only the column it returns.
    if (COVER.length < cells) COVER = new Float32Array(cells);
    const cover = COVER;
    const touched: number[] = [];
    const stamp = (idx: number, c: number): void => {
      if (cover[idx] === 0) touched.push(idx);
      cover[idx] += c;
    };
    for (const line of lines) {
      if (line.length === 1) {
        capsule(line[0], line[0], r, cols, rows, spacing, bounds, stamp);
        continue;
      }
      for (let s = 1; s < line.length; s++) capsule(line[s - 1], line[s], r, cols, rows, spacing, bounds, stamp);
    }

    // Only the leaves the marks touched are copied: a spend of a short
    // chord copies a leaf or two, and the ledger's states share the rest.
    const from = this.columns[k];
    const out = from.writer(touched);
    for (const idx of touched) {
      const c = Math.min(1, cover[idx]);
      cover[idx] = 0;
      if (!mask[idx]) continue;
      const have = at32(from, idx);
      if (!(have > 0)) continue;
      // Clamped at what the face holds: a mark over a paid face takes nothing.
      out.set(idx, have - Math.min(have, c));
    }
    return this.withColumn(k, out.done());
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
 * to loops by the time it arrives. `who` names the door in a refusal.
 */
export function latticeOf(env: LatticeEnv, opts: LatticeOpts, init?: LatticeInit, who = 'lattice'): Lattice {
  if (!opts || typeof opts !== 'object') throw new Error(`${who}: { spacing } is required`);
  if (opts.spacing === undefined) throw new Error(`${who}: { spacing } is required`);
  const channels = opts.channels === undefined ? ['a'] : [...opts.channels];
  if (channels.length === 0) throw new Error(`${who}: { channels } must name at least one channel`);
  for (const c of channels) {
    if (typeof c !== 'string' || c.length === 0) throw new Error(`${who}: a channel name must be a non-empty string, got ${JSON.stringify(c)}`);
    checkColumnName(c, who);
  }
  if (new Set(channels).size !== channels.length) throw new Error(`${who}: repeated channel name in [${channels.map((c) => `'${c}'`).join(', ')}]`);

  // A spacing at or below zero yields no faces — the same rule sample,
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
      throw new Error(`${who}: a shape area is lowered by the toolkit (t.${who}), where the sketch frame is known — pass loops, a face or a material here`);
    }
    loops = numericLoops(area as AreaInput, who);
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
    if (e instanceof RangeError) throw new Error(`${who}: a raster of ${cols} × ${rows} = ${cells} faces does not fit a Float64Array — the spacing is too fine for this machine`);
    throw e;
  }
  // The grid is a whole number of faces, centred on the area's box, so the
  // overhang is the same on both sides and a face centre is always
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
          // One number is the first column — the one `field()` reads.
          buffers[0][idx] = Number.isFinite(v) ? v : 0;
          continue;
        }
        if (typeof v !== 'object' || v === null) continue;
        for (const [name, value] of Object.entries(v)) {
          const k = channels.indexOf(name);
          if (k < 0) throw new Error(`${who}: init set no channel '${name}' — this lattice has ${channels.map((c) => `'${c}'`).join(', ')}`);
          buffers[k][idx] = Number.isFinite(value) ? value : 0;
        }
      }
    }
  }
  return new Lattice(cols, rows, spacing, bounds, channels, buffers, mask);
}

// ---- faces ---------------------------------------------------------------------------

/** The face rows of each mask: every state of one lattice shares its mask,
 * so the list is built once for all of them. */
const FACE_ROWS = new WeakMap<Uint8Array, readonly number[]>();

/** The lattice a face view belongs to: non-enumerable, so a face spreads
 * and serialises as its columns and its grid place. */
const OWNER = Symbol('lattice');

/** The names a face row owns; a column may not be called one of these. */
const RESERVED_FACE_FIELDS: readonly string[] = [
  'index', 'i', 'j', 'area', 'perimeter', 'centroid', 'bounds', 'contours', 'adjacent',
  'source', 'parent', 'children', 'depth', 'leaf', 'laplacian', 'center',
];

function checkColumnName(name: string, who: string): void {
  if (RESERVED_FACE_FIELDS.includes(name)) throw new Error(`${who}: '${name}' is a reserved field of a face, not a column`);
}

/**
 * One face of a lattice: a square of the grid. It answers what every face
 * answers — its columns by name (every face has a number in every column),
 * `area`, `perimeter`, `centroid`, `bounds` (a rect record, itself an
 * area), `contours()`, `adjacent` and the hierarchy, which for a lattice
 * is flat: `parent` undefined, `children` empty, `depth` 0, `leaf` true —
 * and the lattice's own words: its grid place `i`, `j` and
 * `laplacian(column)`, the five-point stencil, zero-flux at the area's
 * edge. A lattice has no edge or point table, so a face has no `edges`,
 * `boundaryEdges` or `points`; its walls are `contours()`.
 */
export type LatticeFace = {
  /** Row in the lattice's grid, row-major — not an identity. */
  readonly index: number;
  /** Column of the grid, 0 at the left. */
  readonly i: number;
  /** Row of the grid, 0 at the top. */
  readonly j: number;
  /** `spacing²`. */
  readonly area: number;
  /** `4 · spacing`. */
  readonly perimeter: number;
  /** The face's centre. */
  readonly centroid: readonly [number, number];
  /** The square as a rect record: `x`, `y`, `w`, `h`, `cx`, `cy`. */
  readonly bounds: Box;
  /** The square as one closed contour, counter-clockwise in a y-up
   * reading — so `polygon(f)` and `t.within(x, f)` read a face as they
   * read any area. */
  contours(): IsoContour[];
  /** The faces across this face's four sides, in the lattice. */
  readonly adjacent: Selection<LatticeFace>;
  /** A lattice face comes from no row of another table. */
  readonly source: undefined;
  /** A lattice does not nest: no parent. */
  readonly parent: undefined;
  /** A lattice does not nest: no children. */
  readonly children: Selection<LatticeFace>;
  /** 0: every face of a lattice is a root. */
  readonly depth: 0;
  /** true: every face of a lattice is a leaf. */
  readonly leaf: true;
  /** `Σ(neighbour − this)` over the four faces beside this one that are in
   * the lattice: what diffuses. Counted in faces, not drawing units. */
  laplacian(column: string): number;
  readonly [ROW_TYPES]?: LatticeFaceTypes;
} & Record<string, number>;

/** Which faces a `set` writes: a face selection, one face, a test of the
 * face, or points — the faces they fall in. */
export type LatticeWhere = Selection<LatticeFace> | LatticeFace | ((f: LatticeFace) => unknown) | PointsLike | XY | undefined;

type Owned = Record<string, number> & { [OWNER]: Lattice };

const FACE_PROTO = Object.freeze(Object.create(Object.prototype, {
  laplacian: {
    value(this: Owned, column: string): number {
      return this[OWNER].laplacianAt(column, this.index, this.i, this.j);
    },
  },
  adjacent: { get(this: Owned): Selection<LatticeFace> { return this[OWNER].adjacentFaces(this.index); } },
  area: { get(this: Owned): number { const s = this[OWNER].spacing; return s * s; } },
  // One word for a face's middle, as on every face: `centroid`.
  center: { get(): never { throw new Error("face.center: a face's middle is its centroid — f.centroid"); } },
  perimeter: { get(this: Owned): number { return 4 * this[OWNER].spacing; } },
  centroid: {
    get(this: Owned): readonly [number, number] {
      const l = this[OWNER];
      return [l.bounds.x + (this.i + 0.5) * l.spacing, l.bounds.y + (this.j + 0.5) * l.spacing];
    },
  },
  bounds: {
    get(this: Owned): Box {
      const l = this[OWNER];
      return box(l.bounds.x + this.i * l.spacing, l.bounds.y + this.j * l.spacing, l.spacing, l.spacing);
    },
  },
  contours: {
    value(this: Owned): IsoContour[] {
      const l = this[OWNER];
      const x0 = l.bounds.x + this.i * l.spacing;
      const y0 = l.bounds.y + this.j * l.spacing;
      const x1 = x0 + l.spacing;
      const y1 = y0 + l.spacing;
      return [{ pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true }];
    },
  },
  source: { get(): undefined { return undefined; } },
  parent: { get(): undefined { return undefined; } },
  children: { get(this: Owned): Selection<LatticeFace> { return select(this[OWNER].faceDomain(), [], undefined, true); } },
  depth: { get(): 0 { return 0; } },
  leaf: { get(): true { return true; } },
}) as object);

const isLatticeFace = (v: unknown): v is LatticeFace & { [OWNER]: Lattice } =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === FACE_PROTO;

/** A place off the lattice as a face: it reads 0 in every column, its row
 * is -1, which no write reaches, and it has no neighbours. */
function offFace(l: Lattice, i: number, j: number): LatticeFace {
  const f = Object.create(FACE_PROTO) as Record<string | symbol, unknown>;
  Object.defineProperty(f, OWNER, { value: l, enumerable: false });
  f.index = -1;
  f.i = i;
  f.j = j;
  for (const name of l.channels) f[name] = 0;
  return f as unknown as LatticeFace;
}

/** The face write: a value or a function of the face, on these faces or
 * those `where` names — a face selection, one face, a test of the face, or
 * points, which name the faces they fall in. */
export interface LatticeSet {
  (column: string, value: number | ((f: LatticeFace) => number), where?: LatticeWhere): Lattice;
  (values: Record<string, number | ((f: LatticeFace) => number)>, where?: LatticeWhere): Lattice;
}

/** @internal What a selection of lattice faces answers (see `ROW_TYPES`). */
export type LatticeFaceTypes = Types<{
  source: Lattice;
  faces: Selection<LatticeFace>;
  contours: () => IsoContour[];
  set: LatticeSet;
}>;

/**
 * The faces of one lattice as a domain: a row is a square of the mask, in
 * row-major order. Every state of one lattice shares its mask, so a face's
 * row is its identity across them; a face of another lattice is refused.
 */
class LatticeFaceDomain implements Domain<LatticeFace> {
  readonly kind: DomainKind = LATTICE_FACES;
  readonly dense = false;
  constructor(readonly source: Lattice) {}
  get size(): number { return this.source.allFaces().length; }
  all(): readonly number[] { return this.source.allFaces(); }
  valid(r: number): boolean { return Number.isInteger(r) && r >= 0 && r < this.source.n && this.source.mask[r] !== 0; }
  row(r: number): LatticeFace { return this.source.faceView(r); }
  rowOf(v: unknown, who: string): number {
    if (!isLatticeFace(v)) throw new Error(`${who}: expected a face of a lattice — got ${v instanceof Selection ? `a ${v.domain.kind.name} selection` : v === null ? 'null' : typeof v}`);
    return this.source.ownRows(v[OWNER], who) && v.index >= 0 ? v.index : -1;
  }
  resolve(other: Selection<any>, who: string): number[] {
    if (other.domain.kind !== LATTICE_FACES) throw new Error(`${who}: expected the faces of this lattice — got ${other.domain.kind.plural} of another geometry`);
    this.source.ownRows(other.source as Lattice, who);
    return [...other.indices];
  }
  on(state: unknown, who: string): Domain<LatticeFace> {
    if (!(state instanceof Lattice)) throw new Error(`${who}: expected the lattice to read the faces on`);
    return state.faceDomain();
  }
  neighbours(r: number): number[] { return this.source.adjacentRows(r); }
  /** A reduction straight off a column's buffer (see `columnReduce`). */
  reduce(name: string, members: readonly number[] | null, op: 'sum' | 'mean' | 'min' | 'max'): number | undefined {
    return columnReduce(this.source, name, members, op);
  }
  /** The faces whose centre is CLOSER THAN `radius` to `p`. */
  near(p: unknown, radius: number, who: string): { rows: readonly number[]; distances: ArrayLike<number> } {
    if (!(typeof radius === 'number' && radius > 0)) throw new Error(`${who}: radius must be a positive distance`);
    const l = this.source;
    const px = vx(p as XY);
    const py = vy(p as XY);
    const { cols, rows, spacing, bounds } = l;
    const out: number[] = [];
    const distances: number[] = [];
    if (l.n === 0 || !Number.isFinite(px) || !Number.isFinite(py)) return { rows: out, distances };
    const i0 = Math.max(0, Math.floor((px - radius - bounds.x) / spacing));
    const i1 = Math.min(cols - 1, Math.floor((px + radius - bounds.x) / spacing));
    const j0 = Math.max(0, Math.floor((py - radius - bounds.y) / spacing));
    const j1 = Math.min(rows - 1, Math.floor((py + radius - bounds.y) / spacing));
    const r2 = radius * radius;
    for (let j = j0; j <= j1; j++) {
      const dy = py - (bounds.y + (j + 0.5) * spacing);
      for (let i = i0; i <= i1; i++) {
        const idx = j * cols + i;
        if (!l.mask[idx]) continue;
        const dx = px - (bounds.x + (i + 0.5) * spacing);
        if (dx * dx + dy * dy < r2) {
          out.push(idx);
          distances.push(Math.hypot(dx, dy));
        }
      }
    }
    return { rows: out, distances };
  }
}

/**
 * The outline of the union of some faces: every side of a member square
 * that does not face another member, linked into closed loops. Each side
 * is directed with the member on its left in a y-up reading, so an outer
 * loop is counter-clockwise there (positive signed area) and a hole
 * clockwise, as a material's faces answer. Where two members touch only at
 * a corner the walk turns toward the square it is walking around, so the
 * two are two loops, not one that crosses itself. Straight runs are one
 * segment: a loop keeps only its corners.
 */
function gridOutline(l: Lattice, rows: readonly number[], holds: (r: number) => boolean): IsoContour[] {
  const { cols, spacing, mask } = l;
  const gridRows = l.rows;
  const W = cols + 1;
  const member = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= cols || j >= gridRows) return false;
    const idx = j * cols + i;
    return mask[idx] !== 0 && holds(idx);
  };
  // Directed sides, corner key to corner key; a corner has at most two
  // sides leaving it.
  const from: number[] = [];
  const to: number[] = [];
  const out = new Map<number, number[]>();
  const side = (a: number, b: number): void => {
    const e = from.length;
    from.push(a);
    to.push(b);
    const list = out.get(a);
    if (list) list.push(e);
    else out.set(a, [e]);
  };
  for (const idx of rows) {
    const i = idx % cols;
    const j = (idx - i) / cols;
    const tl = j * W + i;
    const tr = tl + 1;
    const bl = tl + W;
    const br = bl + 1;
    if (!member(i, j - 1)) side(tl, tr);
    if (!member(i + 1, j)) side(tr, br);
    if (!member(i, j + 1)) side(br, bl);
    if (!member(i - 1, j)) side(bl, tl);
  }
  const dir = (e: number): [number, number] => {
    const d = to[e] - from[e];
    return d === 1 ? [1, 0] : d === -1 ? [-1, 0] : d === W ? [0, 1] : [0, -1];
  };
  // The side that follows one: the only side leaving its end, or — at a
  // corner two members only touch, where two leave — the left turn, which
  // keeps the member the walk goes round beside it. Each side is the
  // follower of exactly one, so every walk comes back to where it began.
  const follower = (e: number): number => {
    const leaving = out.get(to[e])!;
    if (leaving.length === 1) return leaving[0];
    const [dx, dy] = dir(e);
    for (const c of leaving) {
      const [nx, ny] = dir(c);
      if (nx === -dy && ny === dx) return c;
    }
    return leaving[0];
  };
  const used = new Uint8Array(from.length);
  const loops: IsoContour[] = [];
  for (let start = 0; start < from.length; start++) {
    if (used[start]) continue;
    const corners: number[] = [];
    let e = start;
    do {
      used[e] = 1;
      const next = follower(e);
      const [dx, dy] = dir(e);
      const [nx, ny] = dir(next);
      if (nx !== dx || ny !== dy) corners.push(to[e]);
      e = next;
    } while (e !== start && !used[e]);
    if (corners.length < 3) continue;
    const bx = l.bounds.x;
    const by = l.bounds.y;
    loops.push({
      pts: corners.map((c) => [bx + (c % W) * spacing, by + Math.floor(c / W) * spacing] as [number, number]),
      closed: true,
    });
  }
  return loops;
}

/**
 * A reduction of one column over some faces (null: every face), straight
 * off the column: the members in order — row order for the whole lattice,
 * a scan of the mask — and a value that is not finite left out, the rules
 * the shared `sum`, `mean`, `min` and `max` read by, so the numbers are the
 * same numbers added in the same order. No face is made to do it: the loop
 * that watches a residual's debt reads every face every step. Undefined for
 * a name that is not a column (`i`, `area`, …), which the shared word reads
 * through the row.
 */
function columnReduce(l: Lattice, name: string, members: readonly number[] | null, op: 'sum' | 'mean' | 'min' | 'max'): number | undefined {
  const k = l.channels.indexOf(name);
  if (k < 0) return undefined;
  const col = l.columns[k];
  const mask = l.mask;
  // The whole lattice is read leaf by leaf, in row order: a spend's new
  // column is never joined to be summed.
  if (op === 'min' || op === 'max') {
    const lower = op === 'min';
    let m = lower ? Infinity : -Infinity;
    if (members === null) {
      let idx = 0;
      for (const a of col.leaves()) {
        for (let j = 0; j < a.length; j++, idx++) {
          if (mask[idx] === 0) continue;
          const v = a[j];
          if (v - v === 0 && (lower ? v < m : v > m)) m = v;
        }
      }
    } else {
      for (let r = 0; r < members.length; r++) {
        const v = at32(col, members[r]);
        if (v - v === 0 && (lower ? v < m : v > m)) m = v;
      }
    }
    return m;
  }
  let sum = 0;
  let n = 0;
  if (members === null) {
    let idx = 0;
    for (const a of col.leaves()) {
      for (let j = 0; j < a.length; j++, idx++) {
        if (mask[idx] === 0) continue;
        const v = a[j];
        if (v - v === 0) { sum += v; n++; }
      }
    }
  } else {
    for (let r = 0; r < members.length; r++) {
      const v = at32(col, members[r]);
      if (v - v === 0) { sum += v; n++; }
    }
  }
  return op === 'mean' ? sum / n : sum;
}

const LATTICE_FACES: DomainKind = domainKind('face', 'faces', {
  /** Itself. */
  faces: { get(this: Selection<LatticeFace>) { return this; } },
  /** Closed contours around the union of the selected faces: sides between
   * two selected faces vanish, sides against an unselected face, a face off
   * the area or the grid's edge stay, holes stay holes. */
  contours: {
    value(this: Selection<LatticeFace>): IsoContour[] {
      if (this.length === 0) return [];
      const l = this.source as Lattice;
      const rows = [...this.indices].sort((a, b) => a - b);
      return gridOutline(l, rows, (r) => this.holds(r));
    },
  },
  /**
   * The lattice with columns set on these faces — every one, or those
   * `where` names: a face selection, one face, a test of the face, or
   * points, which name the faces they fall in. A value is a number or a
   * function of the face; the record form sets several columns in ONE
   * instant, every function reading the faces as they were. A column not
   * declared yet is declared, 0 elsewhere. A value that is not finite
   * leaves that face as it was, and a `where` that names nothing writes
   * nothing.
   */
  set: { value(this: Selection<LatticeFace>, ...args: unknown[]): Lattice { return (this.source as Lattice).writeFaces(this.members, args); } },
}, {
  add: "a lattice's faces are fixed — set a column instead",
  remove: "a lattice's faces are fixed — set a column instead",
  extract: "a lattice's faces are squares of its own grid — read what you need with faces.map, or the arrays with l.values",
  boundaryEdges: "a lattice has no edge table — its faces are squares of a grid, and their outline is faces.contours()",
  measure: "a lattice face answers its own area and centroid, and a field's mean over faces is faces.mean((f) => field(...f.centroid))",
});

// ---- the nib footprint ---------------------------------------------------------------

/** The coverage scratch `spend` stamps into; grown to the largest lattice
 * spent on, and left all zero between spends. */
let COVER = new Float32Array(0);

/** Scan lines per face row when a footprint is measured. Along a line the
 * overlap with each face is exact, so the only error is the vertical
 * quantisation of a boundary face — an eighth of a face at worst, and it is
 * the same eighth whichever way the stroke runs. */
const SCANLINES = 8;

/** A position pair, either spelling, as a plain pair. */
type Pt = [number, number];

/**
 * The nib footprint of one segment: the segment swept by a disc of diameter
 * `2r` — a stadium, which is convex, so a horizontal line crosses it in one
 * interval. Each face row is measured on `SCANLINES` lines; across a line
 * the overlap with each face is exact, so what a face is handed is its
 * covered fraction and the sum over faces is the footprint's area in face
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
      'lattice.spend: a shape is not marks — how many points it has would be decided by a flattening tolerance. Use t.material(shape) for the boundary\'s own vertices, or t.sample(shape, { count }) for a number you choose.',
    );
  }
  if (Array.isArray(marks)) {
    if (marks.length === 0) return [];
    // Positions are one polyline; anything else is a list of marks, each
    // read the same way as one.
    if (isOnePoint(marks[0])) {
      const line = (marks as readonly XY[]).map((p) => [vx(p), vy(p)] as Pt);
      return [line];
    }
    return (marks as readonly SpendMarks[]).flatMap(markLines);
  }
  // The protocol first: a value that can say where its chains and points are
  // is read by what it answers, never by a field that looks like a record.
  const g = marks as Geometry;
  const hasCurves = typeof g === 'object' && g !== null && 'curves' in g;
  const hasPoints = typeof g === 'object' && g !== null && g.points !== undefined;
  if (!hasCurves && !hasPoints) {
    if (isContourRecord(marks)) {
      const line = contourLine(marks);
      return line.length > 0 ? [line] : [];
    }
    throw new Error(
      `lattice.spend: ${describe(marks)} cannot say where its marks are — pass a material, a point selection, a contour record, or an [x, y][] polyline`,
    );
  }
  const out: Pt[][] = [];
  const used = new Set<number>();
  if (hasCurves) {
    for (const c of chainRecordsOf(g) ?? []) {
      if (c.indices) for (const i of c.indices) used.add(i);
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
function contourLine(c: { pts: readonly (readonly [number, number] | XY)[]; closed: boolean }): Pt[] {
  const pts = c.pts.map((p) => [vx(p as XY), vy(p as XY)] as Pt);
  if (c.closed && pts.length > 2) pts.push(pts[0]);
  return pts;
}

const isContourRecord = (v: unknown): v is IsoContour =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as IsoContour).pts);

/** What a refusal calls the thing it was handed. */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'object') return `a ${(v as object).constructor?.name ?? 'object'}`;
  return `a ${typeof v}`;
}

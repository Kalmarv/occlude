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
 * area, a rule that steps them (the shape `Material.steps` already uses —
 * a frozen `cur`, a `next` that starts as its copy, and the step number),
 * and `field(channel)` back out, so everything that reads a field
 * — `isolines`, `scatter`, a fill, `decimate` — reads a lattice too.
 *
 * Recipes stay recipes. There is no `reactionDiffusion()` and no
 * `physarum()`: those are four lines of rule each, written in the sketch.
 *
 * Conventions follow the rest of the raster code. Cell `(i, j)` has its
 * centre at `bounds.x + (i + ½)·spacing`, row-major, exactly as
 * `densityRaster` (points.ts) places its samples. Values are `Float32Array`
 * — a lattice is a picture of a quantity, not a coordinate, and half the
 * memory means twice the grid.
 *
 * The value never mutates: `steps` and `add` return a new lattice, and the
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
   * lies outside it are not part of the lattice: they hold nothing, a rule
   * cannot write them, and the boundary is zero-flux. A shape is lowered by
   * the toolkit, where the sketch frame exists. */
  area?: AreaInput | ShapeValue;
  /** Channel names, default `['a']`. The first is what `field()` reads. */
  channels?: readonly string[];
}

/** The frozen state a rule reads. */
export interface LatticeState {
  readonly cols: number;
  readonly rows: number;
  readonly spacing: number;
  readonly bounds: Bounds;
  /** Is this cell part of the lattice (in the grid and inside the area)? */
  inside(i: number, j: number): boolean;
  /** A channel's value at one cell; 0 outside the lattice. */
  at(channel: string, i: number, j: number): number;
  /** The five-point Laplacian, `Σ(neighbour − centre)`, zero-flux at the
   * area boundary: a neighbour outside the lattice contributes nothing, so
   * nothing leaves through the edge. */
  laplacian(channel: string, i: number, j: number): number;
  /** The in-lattice four-neighbourhood of a cell, as `[i, j]` pairs. */
  neighbours(i: number, j: number): [number, number][];
  /** The cells of the lattice, as `[i, j]` pairs, row-major: the
   * collection a per-cell rule walks, so the walk is the lattice's and the
   * rule is the arithmetic. */
  readonly cells: Iterable<[number, number]>;
}

/** The edits a rule batches for the next state. It starts as a copy of the
 * state the rule reads, so a rule that writes nothing changes nothing. */
export interface LatticeNext {
  /** Write one cell. A cell outside the lattice is not written. */
  set(channel: string, i: number, j: number, value: number): void;
  /** Add to one cell. A cell outside the lattice is not written. */
  add(channel: string, i: number, j: number, value: number): void;
  /** One explicit diffusion pass over the whole channel:
   * `v += rate · laplacian(v)`, zero-flux, so the channel's total is
   * unchanged. Above a rate of 0.25 the five-point stencil is unstable and
   * the values run away; that is arithmetic, not a setting. */
  diffuse(channel: string, rate: number): void;
  /** Scale the whole channel by `1 − rate`. */
  decay(channel: string, rate: number): void;
}

/** One step of a lattice: read `cur`, write `next`, `k` steps done. The
 * shape `Material.steps` uses, over cells instead of rows. */
export type LatticeRule = (cur: LatticeState, next: LatticeNext, k: number) => void;

/** A lattice's own numbers, for a sketch that wants the arrays: one
 * `Float32Array` per channel, row-major, `cols × rows` long. Read them; the
 * lattice hands out its own buffers and does not expect them written. */
export type LatticeValues = Record<string, Float32Array>;

/** Memory sanity, the same bound `isolines` keeps: 4M cells is a 16MB
 * buffer per channel. Past that the spacing is a mid-edit transient or a
 * mistake, and either way nothing good comes of allocating for it. */

/**
 * A grid of named channels over an area, and the stepping that makes it
 * worth having. Made by `t.lattice`; every operation returns a new one.
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
  ) {
    this.cols = cols;
    this.rows = rows;
    this.spacing = spacing;
    this.bounds = bounds;
    this.channels = channels;
    this.buffers = buffers;
    this.mask = mask;
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
  cell(x: number, y: number): { i: number; j: number } {
    if (!(this.spacing > 0)) return { i: 0, j: 0 };
    return {
      i: Math.floor((x - this.bounds.x) / this.spacing),
      j: Math.floor((y - this.bounds.y) / this.spacing),
    };
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
   * Apply `rule` `n` times and return the result; this lattice is
   * unchanged. Each step freezes the current values, hands the rule a
   * `next` that starts as their copy, and commits what the rule wrote.
   */
  steps(n: number, rule: LatticeRule): Lattice {
    const { cols, rows, spacing, mask } = this;
    const cells = cols * rows;
    const chans = this.channels.length;
    if (cells === 0 || chans === 0) return this;

    // Two buffer sets, swapped each step, plus one scratch row for
    // `diffuse`: allocated once, not once per step.
    let cur: Float32Array[] = this.buffers.map((b) => Float32Array.from(b));
    let next: Float32Array[] = this.buffers.map(() => new Float32Array(cells));
    const scratch = new Float32Array(cells);
    const names = this.channels;

    // A channel's slot, by name. This runs once per `cur.at`, per
    // `cur.laplacian` and per `next.set` — of the order of 10^8 times in a
    // reaction-diffusion run — so the lookup itself has to be nearly free.
    // A lattice holds a handful of named channels, so the honest structure
    // is the list of names and a pointer compare each: a rule's `'a'` is
    // the same interned string on every call, and two compares beat a hash.
    // The throw lives in `noChannel` so this body stays small enough to
    // inline into the accessors.
    const slot = (channel: string): number => {
      for (let k = 0; k < chans; k++) if (names[k] === channel) return k;
      return noChannel(names, channel, 'lattice.steps');
    };

    // The two views the rule sees, built once and re-pointed each step:
    // one shape, one call site, so the hot loop stays monomorphic.
    const state: LatticeState = {
      cols,
      rows,
      spacing,
      bounds: this.bounds,
      inside(i, j) { return i >= 0 && j >= 0 && i < cols && j < rows && mask[j * cols + i] === 1; },
      at(channel, i, j) {
        if (i < 0 || j < 0 || i >= cols || j >= rows) return 0;
        const idx = j * cols + i;
        return mask[idx] ? cur[slot(channel)][idx] : 0;
      },
      // The five-point stencil, in the order the sum was always taken —
      // west, east, south, north — because float addition is not
      // associative and the ink depends on the order.
      laplacian(channel, i, j) {
        if (i < 0 || j < 0 || i >= cols || j >= rows) return 0;
        const idx = j * cols + i;
        if (!mask[idx]) return 0;
        const a = cur[slot(channel)];
        const c = a[idx];
        let sum = 0;
        if (i > 0 && mask[idx - 1]) sum += a[idx - 1] - c;
        if (i + 1 < cols && mask[idx + 1]) sum += a[idx + 1] - c;
        if (j > 0 && mask[idx - cols]) sum += a[idx - cols] - c;
        if (j + 1 < rows && mask[idx + cols]) sum += a[idx + cols] - c;
        return sum;
      },
      neighbours(i, j) {
        const out: [number, number][] = [];
        if (i < 0 || j < 0 || i >= cols || j >= rows) return out;
        const idx = j * cols + i;
        if (i > 0 && mask[idx - 1]) out.push([i - 1, j]);
        if (i + 1 < cols && mask[idx + 1]) out.push([i + 1, j]);
        if (j > 0 && mask[idx - cols]) out.push([i, j - 1]);
        if (j + 1 < rows && mask[idx + cols]) out.push([i, j + 1]);
        return out;
      },
      cells: {
        *[Symbol.iterator](): Iterator<[number, number]> {
          for (let j = 0; j < rows; j++) {
            const row = j * cols;
            for (let i = 0; i < cols; i++) if (mask[row + i]) yield [i, j];
          }
        },
      },
    };

    const writable = (i: number, j: number): number => {
      if (i < 0 || j < 0 || i >= cols || j >= rows) return -1;
      const idx = j * cols + i;
      return mask[idx] ? idx : -1;
    };

    const edits: LatticeNext = {
      set(channel, i, j, value) {
        const idx = writable(i, j);
        if (idx >= 0) next[slot(channel)][idx] = value;
      },
      add(channel, i, j, value) {
        const idx = writable(i, j);
        if (idx >= 0) next[slot(channel)][idx] += value;
      },
      diffuse(channel, rate) {
        const a = next[slot(channel)];
        for (let j = 0; j < rows; j++) {
          const row = j * cols;
          for (let i = 0; i < cols; i++) {
            const idx = row + i;
            if (!mask[idx]) { scratch[idx] = a[idx]; continue; }
            const c = a[idx];
            let sum = 0;
            if (i > 0 && mask[idx - 1]) sum += a[idx - 1] - c;
            if (i + 1 < cols && mask[idx + 1]) sum += a[idx + 1] - c;
            if (j > 0 && mask[idx - cols]) sum += a[idx - cols] - c;
            if (j + 1 < rows && mask[idx + cols]) sum += a[idx + cols] - c;
            scratch[idx] = c + rate * sum;
          }
        }
        a.set(scratch);
      },
      decay(channel, rate) {
        const a = next[slot(channel)];
        const keep = 1 - rate;
        for (let idx = 0; idx < cells; idx++) if (mask[idx]) a[idx] *= keep;
      },
    };

    // A count that cannot be walked is no steps at all, exactly as
    // `Material.steps` reads one.
    for (let k = 0; k < n; k++) {
      for (let c = 0; c < chans; c++) next[c].set(cur[c]);
      rule(state, edits, k);
      const swap = cur;
      cur = next;
      next = swap;
    }
    return new Lattice(cols, rows, spacing, this.bounds, this.channels, cur, mask);
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

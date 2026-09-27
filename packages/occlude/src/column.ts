/**
 * A persistent column: the storage under every row a geometry holds.
 *
 * A column is a run of numbers kept as fixed-size LEAVES — `LEAF` values
 * each, the last one shorter — and a leaf is never written once a column
 * holds it. So two columns may share leaves, and a write makes a new column
 * that shares every leaf it does not touch: a write of `k` rows copies the
 * leaves those rows fall in and the leaf array, an append copies the last
 * leaf and adds new ones, and a row selection shares every whole leaf in
 * front of the first row it moves. A state kept in a run's history then
 * costs the leaves that changed, not a copy of every column.
 *
 * A kernel reads a column as ONE typed array: `flat()` joins the leaves the
 * first time it is asked for and keeps the result, which is never written
 * either. A column made from a typed array (`Column.of`) adopts it as its
 * flat and cuts its leaves out of it as views, so building a value from
 * arrays copies nothing, and asking a column that has a flat for its
 * leaves copies nothing. `Column.of` of a flat a column already answers is
 * that column: a value rebuilt from another value's arrays shares its
 * storage.
 *
 * A per-row path reads `get(i)` and writes through a `writer`, and never
 * needs the flat. Nothing here knows what a row means: a material holds its
 * point columns, its edge list (a Uint32 column, two values per edge) and
 * its edge columns this way; a lattice holds one Float32 column per channel.
 */

/** The typed arrays a column can hold. A Uint8 column is the storage
 * under a boolean column (see `kinds.boolean`). */
export type Numeric = Float64Array | Float32Array | Uint32Array | Uint8Array;

type Maker<T extends Numeric> = new (length: number) => T;

/**
 * Values per leaf, as a power of two so a row finds its leaf with a shift.
 *
 * A write of one row copies one leaf and the leaf array, so a small leaf
 * favours a sparse write and a large one a column written whole or read
 * leaf by leaf. 256, 1024 and 4096 were measured on the growth pages, the
 * residual portrait and a 2000-step split-and-move run with history: 1024
 * was within noise of the best on every one.
 */
export const LEAF_BITS = 10;
/** Values per leaf. */
export const LEAF = 1 << LEAF_BITS;
const MASK = LEAF - 1;

/** The column each flat array belongs to: a flat a column has materialised
 * or adopted. `Column.of` looks here first, so the same numbers are the same
 * column. */
const OWNER = new WeakMap<Numeric, Column<Numeric>>();

/** What a write reaches: every row (`'all'`), rows not known in advance
 * (`'some'`), or these rows. */
export type Reach = 'all' | 'some' | ArrayLike<number>;

export class Column<T extends Numeric = Float64Array> {
  /** How many values. */
  readonly length: number;
  private readonly make: Maker<T>;
  /** The leaves: all `LEAF` long but the last. Built on first ask from the
   * flat when the column was made from one. */
  private leafBox: readonly T[] | null;
  /** The whole column as one array: adopted, or joined on first ask. */
  private flatBox: T | null;

  private constructor(make: Maker<T>, length: number, leaves: readonly T[] | null, flat: T | null) {
    this.make = make;
    this.length = length;
    this.leafBox = leaves;
    this.flatBox = flat;
  }

  /** The column of these numbers. The array is adopted, not copied: it
   * must not be written after this. An array a column already answers as
   * its flat gives that column back. */
  static of<T extends Numeric>(flat: T): Column<T> {
    const known = OWNER.get(flat);
    if (known !== undefined) return known as unknown as Column<T>;
    const c = new Column<T>(flat.constructor as Maker<T>, flat.length, null, flat);
    OWNER.set(flat, c as unknown as Column<Numeric>);
    return c;
  }

  /** `length` zeros of the given kind. */
  static zeros<T extends Numeric>(make: Maker<T>, length: number): Column<T> {
    return Column.of(new make(length));
  }

  /** The value at row `i`, which must be a row of the column. One code
   * path for every kind of array: a per-row reader of one kind in a hot
   * loop takes `at64`, `at32` or `atU32`, whose reads see one kind. */
  get(i: number): number {
    const f = this.flatBox;
    if (f !== null) return f[i];
    return this.leafBox![i >>> LEAF_BITS][i & MASK];
  }

  /** @internal The flat when it is there, else null: joins nothing. */
  peekFlat(): T | null {
    return this.flatBox;
  }

  /** @internal The leaf that holds row `i`. */
  leafOf(i: number): T {
    return this.leaves()[i >>> LEAF_BITS];
  }

  /** The whole column as one typed array: joined once and kept. Read it;
   * never write it — other columns may share it. */
  flat(): T {
    const f = this.flatBox;
    if (f !== null) return f;
    const out = this.joined();
    this.flatBox = out;
    OWNER.set(out, this as unknown as Column<Numeric>);
    return out;
  }

  /** The leaves, in order: every one `LEAF` long but the last. Read them;
   * never write them. */
  leaves(): readonly T[] {
    const got = this.leafBox;
    if (got !== null) return got;
    const f = this.flatBox!;
    const out: T[] = [];
    for (let at = 0; at < this.length; at += LEAF) out.push(f.subarray(at, Math.min(this.length, at + LEAF)) as T);
    this.leafBox = out;
    return out;
  }

  /** A new array holding the values, the caller's to write. */
  copy(): T {
    const f = this.flatBox;
    return f !== null ? (f.slice() as T) : this.joined();
  }

  /** The values of `rows`, in that order, as a new array. */
  gather(rows: ArrayLike<number>): T {
    const out = new this.make(rows.length);
    const f = this.flatBox;
    if (f !== null) for (let k = 0; k < rows.length; k++) out[k] = f[rows[k]];
    else {
      const leaves = this.leafBox!;
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k];
        out[k] = leaves[r >>> LEAF_BITS][r & MASK];
      }
    }
    return out;
  }

  /** This column with `values` after its last row. Every whole leaf is
   * shared; the last, partial one is copied and filled. */
  append(values: ArrayLike<number>): Column<T> {
    const add = values.length;
    if (add === 0) return this;
    const n = this.length;
    const total = n + add;
    const old = this.leaves();
    const out = old.slice(0, n >>> LEAF_BITS) as T[];
    for (let start = out.length * LEAF; start < total; start += LEAF) {
      const size = Math.min(LEAF, total - start);
      const leaf = new this.make(size);
      let p = start;
      if (start < n) {
        leaf.set(old[start >>> LEAF_BITS]);
        p = n;
      }
      for (; p < start + size; p++) leaf[p - start] = values[p - n];
      out.push(leaf);
    }
    return new Column<T>(this.make, total, out, null);
  }

  /**
   * The rows `rows` of this column, in that order, each `stride` values
   * wide (an edge list is two values a row). The leaves in front of the
   * first row that is not its own position are shared; the rest are new.
   *
   * Each new leaf is an array of its own, never a cut of one long array:
   * a leaf a later column shares would otherwise keep the whole of that
   * array alive, and a run's history, which keeps every tenth state, kept
   * each state's whole tail for the one leaf of it the next state shared
   * (11.0 MB of columns against 10.4 MB copied whole, on a 2000-step
   * split-and-move run with `every: 10`).
   */
  keep(rows: ArrayLike<number>, stride = 1): Column<T> {
    const count = rows.length;
    let same = 0;
    while (same < count && rows[same] === same) same++;
    const total = count * stride;
    if (same === count && total === this.length) return this;
    const shared = Math.min((same * stride) >>> LEAF_BITS, total >>> LEAF_BITS);
    const f = this.flatBox;
    const leaves = f === null ? this.leafBox! : null;
    const out = shared === 0 ? [] : (this.leaves().slice(0, shared) as T[]);
    if (LEAF % stride !== 0) keepAcross(out, this.make, rows, stride, shared * LEAF, total, f, leaves);
    else {
      let k = (shared * LEAF) / stride;
      for (let start = shared * LEAF; start < total; start += LEAF) {
        const leaf = new this.make(Math.min(LEAF, total - start));
        // A leaf holds whole rows: LEAF is a multiple of the stride.
        for (let p = 0; p < leaf.length; k++) {
          const base = rows[k] * stride;
          for (let s = 0; s < stride; s++, p++) {
            const i = base + s;
            leaf[p] = f !== null ? f[i] : leaves![i >>> LEAF_BITS][i & MASK];
          }
        }
        out.push(leaf);
      }
    }
    // One leaf is its own flat.
    if (out.length === 1 && shared === 0) return Column.of(out[0]);
    return new Column<T>(this.make, total, out, null);
  }

  /**
   * One write of this column: `set` any rows, then `done()` for the new
   * column. A write that reaches more than half the leaves copies the
   * column whole — the cheaper way to write it, and the result is a flat —
   * and one that reaches few copies the leaves it touches.
   */
  writer(reach: Reach): ColumnWriter<T> {
    return new ColumnWriter(this, reach === 'all' || (reach !== 'some' && touchesMost(this.length, reach)));
  }

  /** @internal This column's kind with these leaves in place of its own. */
  withLeaves(leaves: readonly T[]): Column<T> {
    return new Column<T>(this.make, this.length, leaves, null);
  }

  /** Do the two columns hold the same values? A leaf they share is not
   * read. */
  sameValues(other: Column<T>): boolean {
    if (other === this) return true;
    if (other.length !== this.length) return false;
    const a = this.leaves();
    const b = other.leaves();
    for (let k = 0; k < a.length; k++) {
      const x = a[k];
      const y = b[k];
      if (x === y) continue;
      for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false;
    }
    return true;
  }

  private joined(): T {
    const out = new this.make(this.length);
    let at = 0;
    for (const leaf of this.leafBox!) {
      out.set(leaf, at);
      at += leaf.length;
    }
    return out;
  }
}

/**
 * One write of a column: `set` any rows, then `done()` for the new column.
 * The column written is never touched. A dense write copies it whole
 * first; a sparse one copies a leaf the first time a row in it is set, so
 * the new column shares every leaf the write did not reach. A write that
 * sets nothing is the column it started from.
 */
export class ColumnWriter<T extends Numeric> {
  private readonly base: Column<T>;
  private readonly whole: T | null;
  private own: (T | undefined)[] | null = null;
  private wrote = false;

  constructor(base: Column<T>, dense: boolean) {
    this.base = base;
    this.whole = dense ? base.copy() : null;
  }

  /** The value at row `i` as the write stands. */
  get(i: number): number {
    if (this.whole !== null) return this.whole[i];
    const leaf = this.own?.[i >>> LEAF_BITS];
    return leaf !== undefined ? leaf[i & MASK] : this.base.get(i);
  }

  /** A dense write's whole array, to write rows into directly — the
   * write then counts as made — or null for a sparse write, whose rows go
   * through `set`. */
  array(): T | null {
    if (this.whole === null) return null;
    this.wrote = true;
    return this.whole;
  }

  set(i: number, v: number): void {
    this.wrote = true;
    if (this.whole !== null) {
      this.whole[i] = v;
      return;
    }
    const own = (this.own ??= []);
    const k = i >>> LEAF_BITS;
    let leaf = own[k];
    if (leaf === undefined) {
      leaf = this.base.leaves()[k].slice() as T;
      own[k] = leaf;
    }
    leaf[i & MASK] = v;
  }

  done(): Column<T> {
    if (!this.wrote) return this.base;
    if (this.whole !== null) return Column.of(this.whole);
    const leaves = this.base.leaves().slice() as T[];
    const own = this.own!;
    for (let k = 0; k < own.length; k++) {
      const leaf = own[k];
      if (leaf !== undefined) leaves[k] = leaf;
    }
    return this.base.withLeaves(leaves);
  }
}

// One reader per kind of array: each is its own function, so the element
// read in it sees one kind of array and stays monomorphic in a hot loop.

/** The value at row `i` of a Float64 column. */
export function at64(c: Column<Float64Array>, i: number): number {
  const f = c.peekFlat();
  return f !== null ? f[i] : c.leafOf(i)[i & MASK];
}

/** The value at row `i` of a Float32 column. */
export function at32(c: Column<Float32Array>, i: number): number {
  const f = c.peekFlat();
  return f !== null ? f[i] : c.leafOf(i)[i & MASK];
}

/** The value at row `i` of a Uint32 column. */
export function atU32(c: Column<Uint32Array>, i: number): number {
  const f = c.peekFlat();
  return f !== null ? f[i] : c.leafOf(i)[i & MASK];
}

/** The value at row `i` of a Uint8 column. */
export function atU8(c: Column<Uint8Array>, i: number): number {
  const f = c.peekFlat();
  return f !== null ? f[i] : c.leafOf(i)[i & MASK];
}

/** `Column.keep` for a stride LEAF is not a multiple of (a vector of
 * three): a row may cross from one leaf into the next, so walk the values
 * from `from`, the first value of the first new leaf, which may be inside
 * a row. */
function keepAcross<T extends Numeric>(out: T[], make: Maker<T>, rows: ArrayLike<number>, stride: number, from: number, total: number, f: T | null, leaves: readonly T[] | null): void {
  let k = Math.floor(from / stride);
  let s = from - k * stride;
  for (let start = from; start < total; start += LEAF) {
    const leaf = new make(Math.min(LEAF, total - start));
    for (let p = 0; p < leaf.length; p++) {
      const i = rows[k] * stride + s;
      leaf[p] = f !== null ? f[i] : leaves![i >>> LEAF_BITS][i & MASK];
      if (++s === stride) {
        s = 0;
        k++;
      }
    }
    out.push(leaf);
  }
}

/** Would a write of `rows` of a column `length` values long reach more
 * than half its leaves? Then the write copies the column whole. */
function touchesMost(length: number, rows: ArrayLike<number>): boolean {
  const leafCount = (length + MASK) >>> LEAF_BITS;
  if (leafCount <= 1) return true;
  if (rows.length * 2 <= leafCount) return false;
  const seen = new Uint8Array(leafCount);
  let touched = 0;
  for (let k = 0; k < rows.length; k++) {
    const leaf = rows[k] >>> LEAF_BITS;
    if (seen[leaf] === 0) {
      seen[leaf] = 1;
      if (++touched * 2 > leafCount) return true;
    }
  }
  return false;
}

/** A column, or the typed array a caller hands in to be adopted as one. */
export type ColumnLike<T extends Numeric> = T | Column<T>;

/** The column of `v`: itself, or the array adopted (see `Column.of`). */
export function columnOf<T extends Numeric>(v: ColumnLike<T>): Column<T> {
  return v instanceof Column ? v : Column.of(v);
}

// ─── Typed columns ──────────────────────────────────────────────────────
//
// A geometry's column holds one KIND of value: numbers, booleans, strings,
// fixed-width numeric vectors, references to rows, or placements. Every
// kind is a persistent column with the leaf scheme above and the numeric
// column's words — `length`, `get`, `append`, `keep`, `gather`, a `writer`
// that copies the leaves it touches, `flat()` joined once and kept,
// `sameValues` — and its kind (`kinds.*`) is the door that makes one:
// `of(flat)` adopts a flat, `from(values)` copies values, `filled(n)` is
// `n` rows of the kind's default.
//
// Storage per kind, never named outside this file:
//
// | kind      | a row          | stored as                               |
// |-----------|----------------|-----------------------------------------|
// | number    | a number       | the Float64 column itself               |
// | boolean   | true / false   | a Uint8 column, 1 or 0                  |
// | string    | a string       | leaves of strings (plain arrays)        |
// | vector(k) | k numbers      | a Float64 column, k values a row        |
// | reference | a row id, null | a Float64 column, -1 for null           |
// | placement | any value      | leaves of values (plain arrays)         |

/** The kinds of value a column holds. */
export type KindName = 'number' | 'boolean' | 'string' | 'vector' | 'reference' | 'placement';

/** A persistent column of values `V`, read whole as the flat `F`. The
 * numeric `Column<Float64Array>` is one. */
export interface TypedColumn<V, F> {
  /** How many rows. */
  readonly length: number;
  /** The value at row `i`, which must be a row of the column. */
  get(i: number): V;
  /** Every row as one flat: joined once and kept. Read it; never write it. */
  flat(): F;
  /** The rows `rows`, in that order, as a new flat of this kind. */
  gather(rows: ArrayLike<number>): F;
  /** This column with `values` after its last row. */
  append(values: ArrayLike<V>): TypedColumn<V, F>;
  /** The rows `rows` of this column, in that order. */
  keep(rows: ArrayLike<number>): TypedColumn<V, F>;
  /** One write: `set` any rows, then `done()` for the new column. */
  writer(reach: Reach): TypedWriter<V, F>;
  /** Do the two columns hold the same values (by the kind's equality)? A
   * leaf they share is not read. */
  sameValues(other: TypedColumn<V, F>): boolean;
}

/** One write of a typed column (see `ColumnWriter`). */
export interface TypedWriter<V, F> {
  /** The value at row `i` as the write stands. */
  get(i: number): V;
  set(i: number, v: V): void;
  /** The new column; the column written if nothing was set. */
  done(): TypedColumn<V, F>;
}

/**
 * What a kind of column is: its name, the default a new row takes, whether
 * it interpolates, the equality that compares two columns, and the doors
 * that make a column of it.
 *
 * Only `number` and `vector` interpolate. A boolean, a string, a reference
 * or a placement never does: a row made between two rows (a split child, a
 * resampled point) takes a value one of them has — the parent's — and
 * never a blend. Which of the two is the geometry's transfer rule.
 */
export interface ColumnKind<V, F, C extends TypedColumn<V, F> = TypedColumn<V, F>> {
  readonly name: KindName;
  /** Numbers a row takes in the flat: `k` for a vector, else 1. */
  readonly width: number;
  /** The value of a row nothing has set. */
  readonly default: V;
  /** Does a row made between two rows blend their values? */
  readonly interpolates: boolean;
  /** Are two values the same? `sameValues` compares by it. */
  equal(a: V, b: V): boolean;
  /** The column of this flat, adopted, not copied: it must not be written
   * after this. The same flat is the same column. */
  of(flat: F): C;
  /** The column of these values, copied. */
  from(values: ArrayLike<V>): C;
  /** `length` rows of the default. */
  filled(length: number): C;
}

// ─── number ────────────────────────────────────────────────────────────

const numberKind: ColumnKind<number, Float64Array, Column<Float64Array>> = Object.freeze({
  name: 'number' as const,
  width: 1,
  default: 0,
  interpolates: true,
  equal: (a: number, b: number) => a === b,
  of: (flat: Float64Array) => Column.of(flat),
  from: (values: ArrayLike<number>) => Column.of(Float64Array.from(values)),
  filled: (length: number) => Column.zeros(Float64Array, length),
});

// ─── boolean and reference: a value coded as one number ────────────────

/** A kind stored as one number a row: a boolean as 1 or 0, a reference as
 * the row's id or -1. */
export class CodedKind<V, T extends Numeric> implements ColumnKind<V, T, CodedColumn<V, T>> {
  readonly name: KindName;
  readonly width = 1;
  readonly default: V;
  readonly interpolates = false;
  /** @internal The number a value is stored as. */
  readonly encode: (v: V) => number;
  /** @internal The value a stored number is. */
  readonly decode: (x: number) => V;
  private readonly make: Maker<T>;
  /** The typed column over each store, so the same store is the same
   * column. */
  private readonly over = new WeakMap<Column<T>, CodedColumn<V, T>>();

  /** @internal Use `kinds.boolean` or `kinds.reference`. */
  constructor(name: KindName, make: Maker<T>, fallback: V, encode: (v: V) => number, decode: (x: number) => V) {
    this.name = name;
    this.make = make;
    this.default = fallback;
    this.encode = encode;
    this.decode = decode;
  }

  equal(a: V, b: V): boolean {
    return a === b;
  }

  of(flat: T): CodedColumn<V, T> {
    return this.wrap(Column.of(flat));
  }

  from(values: ArrayLike<V>): CodedColumn<V, T> {
    return this.of(this.encoded(values));
  }

  filled(length: number): CodedColumn<V, T> {
    const flat = new this.make(length);
    const d = this.encode(this.default);
    if (d !== 0) flat.fill(d);
    return this.of(flat);
  }

  /** @internal The values as stored numbers, in a new array. */
  encoded(values: ArrayLike<V>): T {
    const out = new this.make(values.length);
    for (let k = 0; k < values.length; k++) out[k] = this.encode(values[k]);
    return out;
  }

  /** @internal The typed column over `store`. */
  wrap(store: Column<T>): CodedColumn<V, T> {
    let c = this.over.get(store);
    if (c === undefined) {
      c = new CodedColumn(this, store);
      this.over.set(store, c);
    }
    return c;
  }
}

/** A column of values each stored as one number (a boolean or a
 * reference). Its flat is the stored numbers. */
export class CodedColumn<V, T extends Numeric> implements TypedColumn<V, T> {
  readonly kind: CodedKind<V, T>;
  /** @internal The numbers underneath. */
  readonly store: Column<T>;
  readonly length: number;

  /** @internal Use the kind: `kinds.boolean.of(flat)`. */
  constructor(kind: CodedKind<V, T>, store: Column<T>) {
    this.kind = kind;
    this.store = store;
    this.length = store.length;
  }

  get(i: number): V {
    return this.kind.decode(this.store.get(i));
  }

  flat(): T {
    return this.store.flat();
  }

  gather(rows: ArrayLike<number>): T {
    return this.store.gather(rows);
  }

  append(values: ArrayLike<V>): CodedColumn<V, T> {
    if (values.length === 0) return this;
    return this.kind.wrap(this.store.append(this.kind.encoded(values)));
  }

  keep(rows: ArrayLike<number>): CodedColumn<V, T> {
    return this.kind.wrap(this.store.keep(rows));
  }

  writer(reach: Reach): CodedWriter<V, T> {
    return new CodedWriter(this.kind, this.store.writer(reach));
  }

  sameValues(other: CodedColumn<V, T>): boolean {
    return this.store.sameValues(other.store);
  }
}

/** One write of a coded column. */
export class CodedWriter<V, T extends Numeric> implements TypedWriter<V, T> {
  private readonly kind: CodedKind<V, T>;
  private readonly w: ColumnWriter<T>;

  constructor(kind: CodedKind<V, T>, w: ColumnWriter<T>) {
    this.kind = kind;
    this.w = w;
  }

  get(i: number): V {
    return this.kind.decode(this.w.get(i));
  }

  set(i: number, v: V): void {
    this.w.set(i, this.kind.encode(v));
  }

  done(): CodedColumn<V, T> {
    return this.kind.wrap(this.w.done());
  }
}

/** A column of booleans: a Uint8 column of 1 and 0. */
export type BooleanColumn = CodedColumn<boolean, Uint8Array>;

/**
 * A column of references to rows of the same value: a row's `id` (the
 * minted id, which is a positive whole number), or null for no row.
 *
 * The column keeps the id and nothing else. Which row an id names — and
 * that the row is still there — is the geometry's to resolve, by id and
 * never by row index, so a reference survives any write that keeps the row
 * it names; an id whose row is gone resolves to nothing.
 */
export type ReferenceColumn = CodedColumn<number | null, Float64Array>;

const booleanKind = new CodedKind<boolean, Uint8Array>(
  'boolean',
  Uint8Array,
  false,
  (v) => (v ? 1 : 0),
  (x) => x !== 0,
);

const referenceKind = new CodedKind<number | null, Float64Array>(
  'reference',
  Float64Array,
  null,
  (v) => (v === null ? -1 : v),
  (x) => (x < 0 ? null : x),
);

// ─── vector: k numbers a row ───────────────────────────────────────────

/** A kind of `width` numbers a row, stored as one Float64 column `width`
 * values a row (as an edge list is two). */
export class VectorKind implements ColumnKind<readonly number[], Float64Array, VectorColumn> {
  readonly name = 'vector' as const;
  readonly width: number;
  /** The zero vector. */
  readonly default: readonly number[];
  readonly interpolates = true;
  private readonly over = new WeakMap<Column<Float64Array>, VectorColumn>();

  /** @internal Use `kinds.vector(k)`. */
  constructor(width: number) {
    this.width = width;
    this.default = Object.freeze(new Array<number>(width).fill(0));
  }

  equal(a: readonly number[], b: readonly number[]): boolean {
    for (let s = 0; s < this.width; s++) if (a[s] !== b[s]) return false;
    return true;
  }

  /** The column of this flat, `width` values a row. */
  of(flat: Float64Array): VectorColumn {
    if (flat.length % this.width !== 0) throw new RangeError(`a vector column of width ${this.width} takes a flat whose length is a multiple of ${this.width}; got ${flat.length}`);
    return this.wrap(Column.of(flat));
  }

  from(values: ArrayLike<readonly number[]>): VectorColumn {
    return this.of(this.flatten(values));
  }

  filled(length: number): VectorColumn {
    return this.of(new Float64Array(length * this.width));
  }

  /** @internal The rows as one flat, `width` values a row. */
  flatten(values: ArrayLike<readonly number[]>): Float64Array {
    const k = this.width;
    const out = new Float64Array(values.length * k);
    for (let r = 0; r < values.length; r++) {
      const v = this.checked(values[r]);
      for (let s = 0; s < k; s++) out[r * k + s] = v[s];
    }
    return out;
  }

  /** @internal `v`, which must have `width` numbers. */
  checked(v: readonly number[]): readonly number[] {
    if (v.length !== this.width) throw new RangeError(`a vector column of width ${this.width} takes vectors of ${this.width} numbers; got ${v.length}`);
    return v;
  }

  /** @internal The vector column over `store`. */
  wrap(store: Column<Float64Array>): VectorColumn {
    let c = this.over.get(store);
    if (c === undefined) {
      c = new VectorColumn(this, store);
      this.over.set(store, c);
    }
    return c;
  }
}

/** A column of fixed-width numeric vectors. `get` makes a fresh array;
 * `component` reads one number and makes nothing. Its flat is the numbers,
 * `width` a row. */
export class VectorColumn implements TypedColumn<readonly number[], Float64Array> {
  readonly kind: VectorKind;
  /** @internal The numbers underneath, `width` a row. */
  readonly store: Column<Float64Array>;
  /** How many rows (vectors). */
  readonly length: number;

  /** @internal Use the kind: `kinds.vector(3).of(flat)`. */
  constructor(kind: VectorKind, store: Column<Float64Array>) {
    this.kind = kind;
    this.store = store;
    this.length = store.length / kind.width;
  }

  /** The vector at row `i`, as a new array. */
  get(i: number): number[] {
    const k = this.kind.width;
    const out: number[] = [];
    for (let s = 0; s < k; s++) out.push(at64(this.store, i * k + s));
    return out;
  }

  /** Number `s` of the vector at row `i`. */
  component(i: number, s: number): number {
    return at64(this.store, i * this.kind.width + s);
  }

  flat(): Float64Array {
    return this.store.flat();
  }

  gather(rows: ArrayLike<number>): Float64Array {
    const k = this.kind.width;
    const out = new Float64Array(rows.length * k);
    for (let r = 0; r < rows.length; r++) {
      const base = rows[r] * k;
      for (let s = 0; s < k; s++) out[r * k + s] = at64(this.store, base + s);
    }
    return out;
  }

  append(values: ArrayLike<readonly number[]>): VectorColumn {
    if (values.length === 0) return this;
    return this.kind.wrap(this.store.append(this.kind.flatten(values)));
  }

  keep(rows: ArrayLike<number>): VectorColumn {
    return this.kind.wrap(this.store.keep(rows, this.kind.width));
  }

  writer(reach: Reach): VectorWriter {
    const k = this.kind.width;
    let at: Reach = reach;
    if (reach !== 'all' && reach !== 'some' && k > 1) {
      const values = new Float64Array(reach.length * k);
      for (let r = 0; r < reach.length; r++) for (let s = 0; s < k; s++) values[r * k + s] = reach[r] * k + s;
      at = values;
    }
    return new VectorWriter(this.kind, this.store.writer(at));
  }

  sameValues(other: VectorColumn): boolean {
    return other.kind.width === this.kind.width && this.store.sameValues(other.store);
  }
}

/** One write of a vector column. */
export class VectorWriter implements TypedWriter<readonly number[], Float64Array> {
  private readonly kind: VectorKind;
  private readonly w: ColumnWriter<Float64Array>;

  constructor(kind: VectorKind, w: ColumnWriter<Float64Array>) {
    this.kind = kind;
    this.w = w;
  }

  get(i: number): number[] {
    const k = this.kind.width;
    const out: number[] = [];
    for (let s = 0; s < k; s++) out.push(this.w.get(i * k + s));
    return out;
  }

  set(i: number, v: readonly number[]): void {
    const k = this.kind.width;
    this.kind.checked(v);
    for (let s = 0; s < k; s++) this.w.set(i * k + s, v[s]);
  }

  /** Set number `s` of the vector at row `i`. */
  setComponent(i: number, s: number, v: number): void {
    this.w.set(i * this.kind.width + s, v);
  }

  done(): VectorColumn {
    return this.kind.wrap(this.w.done());
  }
}

const vectorKinds = new Map<number, VectorKind>();

function vectorKind(width: number): VectorKind {
  if (!Number.isInteger(width) || width < 1) throw new RangeError(`a vector column is a whole number of values wide, 1 or more; got ${width}`);
  let kind = vectorKinds.get(width);
  if (kind === undefined) {
    kind = new VectorKind(width);
    vectorKinds.set(width, kind);
  }
  return kind;
}

// ─── string and placement: leaves of values ────────────────────────────

/** The array column each flat belongs to (see `OWNER`). */
const ARRAY_OWNER = new WeakMap<readonly unknown[], ArrayColumn<unknown>>();

/** A plain, packed array of `length` copies of `v`. */
function packedFill<V>(length: number, v: V): V[] {
  const out: V[] = [];
  for (let i = 0; i < length; i++) out.push(v);
  return out;
}

/** A plain copy of `values`. */
function packedFrom<V>(values: ArrayLike<V>): V[] {
  return Array.isArray(values) ? values.slice() : Array.from(values);
}

/** A kind stored as leaves of plain arrays: strings, or an opaque value a
 * row (a placement). */
export class ArrayKind<V> implements ColumnKind<V, readonly V[], ArrayColumn<V>> {
  readonly name: KindName;
  readonly width = 1;
  readonly default: V;
  readonly interpolates = false;

  /** @internal Use `kinds.string` or `kinds.placement`. */
  constructor(name: KindName, fallback: V) {
    this.name = name;
    this.default = fallback;
  }

  /** The same value: `===`. A placement is equal to itself only. */
  equal(a: V, b: V): boolean {
    return a === b;
  }

  of(flat: readonly V[]): ArrayColumn<V> {
    const known = ARRAY_OWNER.get(flat);
    if (known !== undefined && known.kind === (this as ArrayKind<unknown>)) return known as ArrayColumn<V>;
    const c = new ArrayColumn<V>(this, flat.length, null, flat);
    if (known === undefined) ARRAY_OWNER.set(flat, c as ArrayColumn<unknown>);
    return c;
  }

  from(values: ArrayLike<V>): ArrayColumn<V> {
    return this.of(packedFrom(values));
  }

  filled(length: number): ArrayColumn<V> {
    return this.of(packedFill(length, this.default));
  }
}

/**
 * A column of any value a row, kept as leaves of plain arrays, `LEAF` a
 * leaf, with the numeric column's sharing: a write copies the leaves it
 * touches, an append the last leaf, a row selection the leaves from the
 * first row that moves.
 *
 * One difference: a plain array has no views, so a column made from a
 * flat (`of`) cuts its leaves as copies the first time a write or an
 * append needs them, and then holds both.
 */
export class ArrayColumn<V> implements TypedColumn<V, readonly V[]> {
  readonly kind: ArrayKind<V>;
  readonly length: number;
  private leafBox: readonly (readonly V[])[] | null;
  private flatBox: readonly V[] | null;

  /** @internal Use the kind: `kinds.string.of(flat)`. */
  constructor(kind: ArrayKind<V>, length: number, leaves: readonly (readonly V[])[] | null, flat: readonly V[] | null) {
    this.kind = kind;
    this.length = length;
    this.leafBox = leaves;
    this.flatBox = flat;
  }

  get(i: number): V {
    const f = this.flatBox;
    if (f !== null) return f[i];
    return this.leafBox![i >>> LEAF_BITS][i & MASK];
  }

  flat(): readonly V[] {
    const f = this.flatBox;
    if (f !== null) return f;
    const out = this.copy();
    this.flatBox = out;
    ARRAY_OWNER.set(out, this as ArrayColumn<unknown>);
    return out;
  }

  /** The leaves, in order: every one `LEAF` long but the last. Read them;
   * never write them. */
  leaves(): readonly (readonly V[])[] {
    const got = this.leafBox;
    if (got !== null) return got;
    const f = this.flatBox!;
    const out: V[][] = [];
    for (let at = 0; at < this.length; at += LEAF) out.push(f.slice(at, Math.min(this.length, at + LEAF)));
    this.leafBox = out;
    return out;
  }

  /** A new array holding the values, the caller's to write. */
  copy(): V[] {
    const f = this.flatBox;
    if (f !== null) return f.slice();
    // One concat is some five times faster than a push a value.
    return ([] as V[]).concat(...this.leafBox!);
  }

  gather(rows: ArrayLike<number>): V[] {
    const out = new Array<V>(rows.length);
    for (let k = 0; k < rows.length; k++) out[k] = this.get(rows[k]);
    return out;
  }

  append(values: ArrayLike<V>): ArrayColumn<V> {
    const add = values.length;
    if (add === 0) return this;
    const n = this.length;
    const total = n + add;
    const old = this.leaves();
    const out = old.slice(0, n >>> LEAF_BITS);
    let p = 0;
    for (let start = out.length * LEAF; start < total; start += LEAF) {
      const leaf: V[] = start < n ? old[start >>> LEAF_BITS].slice() : [];
      const size = Math.min(LEAF, total - start);
      while (leaf.length < size) leaf.push(values[p++]);
      out.push(leaf);
    }
    return new ArrayColumn<V>(this.kind, total, out, null);
  }

  keep(rows: ArrayLike<number>): ArrayColumn<V> {
    const count = rows.length;
    let same = 0;
    while (same < count && rows[same] === same) same++;
    if (same === count && count === this.length) return this;
    const shared = Math.min(same >>> LEAF_BITS, count >>> LEAF_BITS);
    const out = shared === 0 ? [] : this.leaves().slice(0, shared);
    let k = shared * LEAF;
    for (let start = shared * LEAF; start < count; start += LEAF) {
      const size = Math.min(LEAF, count - start);
      const leaf = new Array<V>(size);
      for (let p = 0; p < size; p++) leaf[p] = this.get(rows[k++]);
      out.push(leaf);
    }
    if (out.length === 1 && shared === 0) return this.kind.of(out[0]);
    return new ArrayColumn<V>(this.kind, count, out, null);
  }

  writer(reach: Reach): ArrayWriter<V> {
    return new ArrayWriter(this, reach === 'all' || (reach !== 'some' && touchesMost(this.length, reach)));
  }

  sameValues(other: ArrayColumn<V>): boolean {
    if (other === this) return true;
    if (other.length !== this.length) return false;
    const a = this.leaves();
    const b = other.leaves();
    for (let k = 0; k < a.length; k++) {
      const x = a[k];
      const y = b[k];
      if (x === y) continue;
      for (let j = 0; j < x.length; j++) if (!this.kind.equal(x[j], y[j])) return false;
    }
    return true;
  }

  /** @internal This column's kind with these leaves in place of its own. */
  withLeaves(leaves: readonly (readonly V[])[]): ArrayColumn<V> {
    return new ArrayColumn<V>(this.kind, this.length, leaves, null);
  }
}

/** One write of an array column: as `ColumnWriter`. */
export class ArrayWriter<V> implements TypedWriter<V, readonly V[]> {
  private readonly base: ArrayColumn<V>;
  private readonly whole: V[] | null;
  private own: (V[] | undefined)[] | null = null;
  private wrote = false;

  constructor(base: ArrayColumn<V>, dense: boolean) {
    this.base = base;
    this.whole = dense ? base.copy() : null;
  }

  get(i: number): V {
    if (this.whole !== null) return this.whole[i];
    const leaf = this.own?.[i >>> LEAF_BITS];
    return leaf !== undefined ? leaf[i & MASK] : this.base.get(i);
  }

  /** A dense write's whole array, to write rows into directly, or null
   * for a sparse write (see `ColumnWriter.array`). */
  array(): V[] | null {
    if (this.whole === null) return null;
    this.wrote = true;
    return this.whole;
  }

  set(i: number, v: V): void {
    this.wrote = true;
    if (this.whole !== null) {
      this.whole[i] = v;
      return;
    }
    const own = (this.own ??= []);
    const k = i >>> LEAF_BITS;
    let leaf = own[k];
    if (leaf === undefined) {
      leaf = this.base.leaves()[k].slice();
      own[k] = leaf;
    }
    leaf[i & MASK] = v;
  }

  done(): ArrayColumn<V> {
    if (!this.wrote) return this.base;
    if (this.whole !== null) return this.base.kind.of(this.whole);
    const leaves = this.base.leaves().slice();
    const own = this.own!;
    for (let k = 0; k < own.length; k++) {
      const leaf = own[k];
      if (leaf !== undefined) leaves[k] = leaf;
    }
    return this.base.withLeaves(leaves);
  }
}

/** A column of strings. */
export type StringColumn = ArrayColumn<string>;

/** A column of placements: an opaque value a row, null for none. The
 * column never reads the value; it only keeps it. */
export type PlacementColumn = ArrayColumn<unknown>;

const stringKind = new ArrayKind<string>('string', '');
const placementKind = new ArrayKind<unknown>('placement', null);

// ─── the kinds ─────────────────────────────────────────────────────────

/** The kind of every column a geometry holds, one door each. */
export const kinds = Object.freeze({
  number: numberKind,
  boolean: booleanKind,
  string: stringKind,
  /** `width` numbers a row. One kind per width: the same width is the
   * same kind. */
  vector: vectorKind,
  reference: referenceKind,
  placement: placementKind,
});

/** Any kind a geometry column is. */
export type AnyKind =
  | typeof numberKind
  | typeof booleanKind
  | typeof stringKind
  | VectorKind
  | typeof referenceKind
  | typeof placementKind;

/** Any column a geometry holds. */
export type AnyColumn = Column<Float64Array> | BooleanColumn | StringColumn | VectorColumn | ReferenceColumn | PlacementColumn;

/** The kind of a column: a numeric column is `kinds.number`; every other
 * says its own. */
export function kindOf(c: AnyColumn): AnyKind {
  return c instanceof Column ? numberKind : c.kind;
}

// ─── any column, read and written by kind ─────────────────────────────
//
// A geometry holds its columns as one record of any kind (`AnyColumn`):
// the numeric ones are plain `Column<Float64Array>`s, so a kernel that
// reads numbers reads them as it always did, and the table writes reach
// every kind through these few doors.

/** A column any kind: the words every kind shares, values untyped. */
type Untyped = TypedColumn<unknown, unknown>;

/** Is `v` a column of a kind other than numbers (a boolean, string,
 * vector, reference or placement column)? */
export function isTypedColumn(v: unknown): v is Exclude<AnyColumn, Column<Float64Array>> {
  return v instanceof CodedColumn || v instanceof VectorColumn || v instanceof ArrayColumn;
}

/** Is `v` a column of any kind a geometry holds? */
export function isAnyColumn(v: unknown): v is AnyColumn {
  return v instanceof Column || isTypedColumn(v);
}

/** The value at row `i` of any column, as its kind reads it: a number, a
 * boolean, a string, a new array of `k` numbers, a row id or null, a
 * placement. */
export function valueAt(c: AnyColumn, i: number): unknown {
  return c instanceof Column ? at64(c, i) : (c as Untyped).get(i);
}

/** `length` rows of `v`, a value of `kind` (checked by the caller). */
export function constantColumn(kind: AnyKind, length: number, v: unknown): AnyColumn {
  if (kind === kinds.number) return Column.of(new Float64Array(length).fill(v as number));
  const values = new Array<unknown>(length);
  for (let i = 0; i < length; i++) values[i] = v;
  return (kind as ColumnKind<unknown, unknown, Untyped>).from(values) as unknown as AnyColumn;
}

/** `c` with `values` (of its kind) after its last row. */
export function appendValues(c: AnyColumn, values: ArrayLike<unknown>): AnyColumn {
  return (c as Untyped).append(values) as unknown as AnyColumn;
}

/** The rows `rows` of `c`, in that order. */
export function keepRows(c: AnyColumn, rows: ArrayLike<number>): AnyColumn {
  return (c as Untyped).keep(rows) as unknown as AnyColumn;
}

/** A new column of `c`'s kind holding rows `rows` of `c`, in that order:
 * what an extraction takes, its own storage. */
export function gatherColumn(c: AnyColumn, rows: ArrayLike<number>): AnyColumn {
  if (c instanceof Column) return Column.of(c.gather(rows));
  if (c instanceof VectorColumn) return c.kind.of(c.gather(rows));
  if (c instanceof CodedColumn) return (c.kind as CodedKind<unknown, Numeric>).of(c.gather(rows)) as unknown as AnyColumn;
  return (c.kind as ArrayKind<unknown>).of(c.gather(rows)) as unknown as AnyColumn;
}

/** `a`, then every row of `b`: two columns of one kind joined. */
export function joinColumns(a: AnyColumn, b: AnyColumn): AnyColumn {
  if (a instanceof Column) return Column.of(concat64(a.flat(), (b as Column).flat()));
  const values = new Array<unknown>(b.length);
  for (let i = 0; i < b.length; i++) values[i] = (b as Untyped).get(i);
  return appendValues(a, values);
}

function concat64(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** One write of any column: `set` takes a value of the column's kind. */
export interface AnyWriter {
  get(i: number): unknown;
  set(i: number, v: unknown): void;
  done(): AnyColumn;
}

/** A writer of any column (see `Column.writer`). */
export function writerOf(c: AnyColumn, reach: Reach): AnyWriter {
  return (c as Untyped).writer(reach) as unknown as AnyWriter;
}

/** The kind's name as a message says it: `a number`, `a vector of 3`. */
export function kindWords(kind: AnyKind): string {
  switch (kind.name) {
    case 'number': return 'a number';
    case 'boolean': return 'a boolean';
    case 'string': return 'a string';
    case 'vector': return `a vector of ${kind.width}`;
    case 'reference': return 'a reference to a row';
    case 'placement': return 'a placement';
  }
}

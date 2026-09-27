/**
 * A persistent column: the storage under every row a geometry holds.
 *
 * A column is a run of values kept as fixed-size LEAVES — `LEAF` values
 * each, the last one shorter — and a leaf is never written once a column
 * holds it. So two columns may share leaves, and a write makes a new column
 * that shares every leaf it does not touch: a write of `k` rows copies the
 * leaves those rows fall in and the leaf array, an append copies the last
 * leaf and adds new ones, and a row selection shares every whole leaf in
 * front of the first row it moves. A state kept in a run's history then
 * costs the leaves that changed, not a copy of every column.
 *
 * A kernel reads a column as ONE array: `flat()` joins the leaves the first
 * time it is asked for and keeps the result, which is never written either.
 * A column made from an array (`Column.of`) adopts it as its flat and cuts
 * its leaves out of it, so building a value from arrays copies nothing.
 * `Column.of` of a flat a column already answers is that column: a value
 * rebuilt from another value's arrays shares its storage.
 *
 * The values are typed arrays of one kind (numbers) or plain arrays (any
 * value); a small storage adapter is all that differs between them. A typed
 * array cuts its leaves as views of the flat, so asking a column that has a
 * flat for its leaves copies nothing; a plain array has no views, so its
 * leaves are cut as copies the first time a write or an append needs them.
 *
 * A per-row path reads `get(i)` and writes through a `writer`, and never
 * needs the flat. Nothing here knows what a row means: a material holds its
 * point columns, its edge list (a Uint32 column, two values per edge) and
 * its edge columns this way; a lattice holds one Float32 column per channel.
 */

/** The typed arrays a column can hold. A Uint8 column is the storage
 * under a boolean column (see `kinds.boolean`). */
export type Numeric = Float64Array | Float32Array | Uint32Array | Uint8Array;

/** What a column keeps its values in: a typed array, or a plain array. */
export type Flat = Numeric | readonly unknown[];

/** The value one place of a flat holds: a number, or a plain array's item. */
export type Item<S extends Flat> = S extends Numeric ? number : S extends readonly (infer V)[] ? V : never;

type Maker<T extends Numeric> = new (length: number) => T;

/** An array of either family, as a codec writes it. */
type Out = { [i: number]: unknown; readonly length: number };

/**
 * Values per leaf, as a power of two so a row finds its leaf with a shift.
 *
 * A write of one row copies one leaf and the leaf array, so a small leaf
 * favours a sparse write and a large one a column written whole or read
 * leaf by leaf. 256, 1024 and 4096 were measured on the growth pages, the
 * residual portrait and a 2000-step split-and-move run with history: 1024
 * was within noise of the best on every one.
 */
const LEAF_BITS = 10;
/** Values per leaf. */
export const LEAF = 1 << LEAF_BITS;
const MASK = LEAF - 1;

// ─── storage ───────────────────────────────────────────────────────────
//
// What differs between a column of typed arrays and one of plain arrays:
// how an array is made, cut and joined, and the loops that read and write
// its values. The loops are written twice, the same words for each family,
// on purpose: a read or a write in a loop stays fast while it sees few kinds
// of array, and one loop shared by both families saw too many — `keep` and
// `get` ran 5 to 12 times slower once a run had held a string column. The
// typed family serves all four typed arrays, as one loop did before.

/** How a column makes, cuts and joins its arrays, and its element loops. */
interface Storage<S extends Flat> {
  /** A new array of `length` values, the caller's to fill. */
  make(length: number): S;
  /** Values `from` to `to` of `flat`: a view where the array has views,
   * else a copy. */
  cut(flat: S, from: number, to: number): S;
  /** A new array `length` long that starts with the leaves, in order. */
  join(leaves: readonly S[], length: number): S;
  /** Value `i` of the flat, or of the leaves when there is no flat. */
  at(flat: S | null, leaves: readonly S[] | null, i: number): Item<S>;
  /** Write value `i` of `out`. */
  set(out: S, i: number, v: Item<S>): void;
  /** Fill `out` with `count` values of a walk of `rows`, `stride` values a
   * row, from value `from` of the walk (which may be inside a row), read
   * from the flat, or from the leaves when there is no flat. */
  pick(out: S, count: number, flat: S | null, leaves: readonly S[] | null, rows: ArrayLike<number>, stride: number, from: number): void;
  /** Write `count` of `values` from `from` into `out` from `at`. */
  put(out: S, at: number, values: ArrayLike<Item<S>>, from: number, count: number): void;
  /** Do two leaves hold the same values? */
  same(a: S, b: S): boolean;
}

function typedStorage<T extends Numeric>(make: Maker<T>): Storage<T> {
  return {
    make: (length) => new make(length),
    cut: (flat, from, to) => flat.subarray(from, to) as T,
    join(leaves, length) {
      const out = new make(length);
      let at = 0;
      for (const leaf of leaves) {
        out.set(leaf, at);
        at += leaf.length;
      }
      return out;
    },
    at: (f, leaves, i) => (f !== null ? f[i] : leaves![i >>> LEAF_BITS][i & MASK]) as Item<T>,
    set(out, i, v) {
      out[i] = v as number;
    },
    pick(out, count, f, leaves, rows, stride, from) {
      if (stride === 1) {
        for (let p = 0; p < count; p++) {
          const i = rows[from + p];
          out[p] = f !== null ? f[i] : leaves![i >>> LEAF_BITS][i & MASK];
        }
        return;
      }
      let k = Math.floor(from / stride);
      let s = from - k * stride;
      for (let p = 0; p < count; s = 0) {
        const base = rows[k++] * stride;
        for (; s < stride && p < count; s++, p++) {
          const i = base + s;
          out[p] = f !== null ? f[i] : leaves![i >>> LEAF_BITS][i & MASK];
        }
      }
    },
    put(out, at, values, from, count) {
      for (let p = 0; p < count; p++) out[at + p] = values[from + p] as number;
    },
    same(a, b) {
      for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) return false;
      return true;
    },
  };
}

const plainStorage: Storage<unknown[]> = {
  make: (length) => new Array<unknown>(length),
  cut: (flat, from, to) => flat.slice(from, to),
  join(leaves, length) {
    // One concat is some five times faster than a push a value.
    const out = ([] as unknown[]).concat(...leaves);
    out.length = length;
    return out;
  },
  at: (f, leaves, i) => (f !== null ? f[i] : leaves![i >>> LEAF_BITS][i & MASK]),
  set(out, i, v) {
    out[i] = v;
  },
  pick(out, count, f, leaves, rows, stride, from) {
    if (stride === 1) {
      for (let p = 0; p < count; p++) {
        const i = rows[from + p];
        out[p] = f !== null ? f[i] : leaves![i >>> LEAF_BITS][i & MASK];
      }
      return;
    }
    let k = Math.floor(from / stride);
    let s = from - k * stride;
    for (let p = 0; p < count; s = 0) {
      const base = rows[k++] * stride;
      for (; s < stride && p < count; s++, p++) {
        const i = base + s;
        out[p] = f !== null ? f[i] : leaves![i >>> LEAF_BITS][i & MASK];
      }
    }
  },
  put(out, at, values, from, count) {
    for (let p = 0; p < count; p++) out[at + p] = values[from + p];
  },
  same(a, b) {
    for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) return false;
    return true;
  },
};

/** The storage of each kind of typed array, made on first use. */
const typedStorages = new Map<Maker<Numeric>, Storage<Numeric>>();

function storageFor<T extends Numeric>(make: Maker<T>): Storage<T> {
  let s = typedStorages.get(make);
  if (s === undefined) {
    s = typedStorage(make as Maker<Numeric>);
    typedStorages.set(make, s);
  }
  return s as Storage<T>;
}

function storageOf<S extends Flat>(flat: S): Storage<S> {
  if (Array.isArray(flat)) return plainStorage as unknown as Storage<S>;
  return storageFor((flat as Numeric).constructor as Maker<Numeric>) as unknown as Storage<S>;
}

/** The column each flat belongs to: a flat a column has materialised or
 * adopted. `Column.of` looks here first, so the same values are the same
 * column. */
const OWNER = new WeakMap<Flat, Column<Flat>>();

// ─── the column ────────────────────────────────────────────────────────

/** What a write reaches: every row (`'all'`), rows not known in advance
 * (`'some'`), or these rows. */
export type Reach = 'all' | 'some' | ArrayLike<number>;

export class Column<S extends Flat = Float64Array> {
  /** How many values. */
  readonly length: number;
  /** @internal How its arrays are made, and its element loops. */
  readonly storage: Storage<S>;
  /** The leaves: all `LEAF` long but the last. Built on first ask from the
   * flat when the column was made from one. */
  private leafBox: readonly S[] | null;
  /** The whole column as one array: adopted, or joined on first ask. */
  private flatBox: S | null;

  private constructor(storage: Storage<S>, length: number, leaves: readonly S[] | null, flat: S | null) {
    this.storage = storage;
    this.length = length;
    this.leafBox = leaves;
    this.flatBox = flat;
  }

  /** The column of these values. The array is adopted, not copied: it
   * must not be written after this. An array a column already answers as
   * its flat gives that column back. */
  static of<S extends Flat>(flat: S): Column<S> {
    const known = OWNER.get(flat);
    if (known !== undefined) return known as unknown as Column<S>;
    const c = new Column<S>(storageOf(flat), flat.length, null, flat);
    OWNER.set(flat, c as unknown as Column<Flat>);
    return c;
  }

  /** `length` zeros of the given kind. */
  static zeros<T extends Numeric>(make: Maker<T>, length: number): Column<T> {
    return Column.of(new make(length));
  }

  /** The value at row `i`, which must be a row of the column. A per-row
   * reader in a hot loop takes `at64`, `at32` or `atU32`, whose reads see
   * one kind of array. */
  get(i: number): Item<S> {
    return this.storage.at(this.flatBox, this.leafBox, i);
  }

  /** @internal The flat when it is there, else null: joins nothing. */
  peekFlat(): S | null {
    return this.flatBox;
  }

  /** @internal The leaf that holds row `i`. */
  leafOf(i: number): S {
    return this.leaves()[i >>> LEAF_BITS];
  }

  /** The whole column as one array: joined once and kept. Read it; never
   * write it — other columns may share it. */
  flat(): S {
    const f = this.flatBox;
    if (f !== null) return f;
    const out = this.storage.join(this.leafBox!, this.length);
    this.flatBox = out;
    OWNER.set(out, this as unknown as Column<Flat>);
    return out;
  }

  /** The leaves, in order: every one `LEAF` long but the last. Read them;
   * never write them. */
  leaves(): readonly S[] {
    const got = this.leafBox;
    if (got !== null) return got;
    const f = this.flatBox!;
    const out: S[] = [];
    for (let at = 0; at < this.length; at += LEAF) out.push(this.storage.cut(f, at, Math.min(this.length, at + LEAF)));
    this.leafBox = out;
    return out;
  }

  /** A new array holding the values, the caller's to write. */
  copy(): S {
    const f = this.flatBox;
    return f !== null ? (f.slice() as S) : this.storage.join(this.leafBox!, this.length);
  }

  /** The values of `rows`, in that order, each `stride` values wide, as a
   * new array. */
  gather(rows: ArrayLike<number>, stride = 1): S {
    const count = rows.length * stride;
    const out = this.storage.make(count);
    this.storage.pick(out, count, this.flatBox, this.leafBox, rows, stride, 0);
    return out;
  }

  /** This column with `values` after its last row. Every whole leaf is
   * shared; the last, partial one is copied and filled. */
  append(values: ArrayLike<Item<S>>): Column<S> {
    const add = values.length;
    if (add === 0) return this;
    const n = this.length;
    const total = n + add;
    const old = this.leaves();
    const out = old.slice(0, n >>> LEAF_BITS) as S[];
    for (let start = out.length * LEAF; start < total; start += LEAF) {
      const size = Math.min(LEAF, total - start);
      const leaf = start < n ? this.storage.join([old[start >>> LEAF_BITS]], size) : this.storage.make(size);
      const from = Math.max(start, n);
      this.storage.put(leaf, from - start, values, from - n, start + size - from);
      out.push(leaf);
    }
    return new Column<S>(this.storage, total, out, null);
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
  keep(rows: ArrayLike<number>, stride = 1): Column<S> {
    const count = rows.length;
    let same = 0;
    while (same < count && rows[same] === same) same++;
    const total = count * stride;
    if (same === count && total === this.length) return this;
    const shared = Math.min((same * stride) >>> LEAF_BITS, total >>> LEAF_BITS);
    const f = this.flatBox;
    const leaves = f === null ? this.leafBox : null;
    const out = shared === 0 ? [] : (this.leaves().slice(0, shared) as S[]);
    // A leaf starts at a value, which may be inside a row when LEAF is not
    // a multiple of the stride (a vector of three): a row may then cross
    // from one leaf into the next.
    for (let start = shared * LEAF; start < total; start += LEAF) {
      const size = Math.min(LEAF, total - start);
      const leaf = this.storage.make(size);
      this.storage.pick(leaf, size, f, leaves, rows, stride, start);
      out.push(leaf);
    }
    // One leaf is its own flat.
    if (out.length === 1 && shared === 0) return Column.of(out[0]);
    return new Column<S>(this.storage, total, out, null);
  }

  /**
   * One write of this column: `set` any rows, then `done()` for the new
   * column. A write that reaches more than half the leaves copies the
   * column whole — the cheaper way to write it, and the result is a flat —
   * and one that reaches few copies the leaves it touches.
   */
  writer(reach: Reach): ColumnWriter<S> {
    return new ColumnWriter(this, reach === 'all' || (reach !== 'some' && touchesMost(this.length, reach)));
  }

  /** @internal This column's storage with these leaves in place of its own. */
  withLeaves(leaves: readonly S[]): Column<S> {
    return new Column<S>(this.storage, this.length, leaves, null);
  }

  /** Do the two columns hold the same values? A leaf they share is not
   * read. */
  sameValues(other: Column<S>): boolean {
    if (other === this) return true;
    if (other.length !== this.length) return false;
    const a = this.leaves();
    const b = other.leaves();
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k] && !this.storage.same(a[k], b[k])) return false;
    return true;
  }
}

/**
 * One write of a column: `set` any rows, then `done()` for the new column.
 * The column written is never touched. A dense write copies it whole
 * first; a sparse one copies a leaf the first time a row in it is set, so
 * the new column shares every leaf the write did not reach. A write that
 * sets nothing is the column it started from.
 */
export class ColumnWriter<S extends Flat = Float64Array> {
  private readonly base: Column<S>;
  private readonly whole: S | null;
  private own: (S | undefined)[] | null = null;
  private wrote = false;

  constructor(base: Column<S>, dense: boolean) {
    this.base = base;
    this.whole = dense ? base.copy() : null;
  }

  /** The value at row `i` as the write stands. */
  get(i: number): Item<S> {
    const at = this.base.storage.at;
    if (this.whole !== null) return at(this.whole, null, i);
    const leaf = this.own?.[i >>> LEAF_BITS];
    return leaf !== undefined ? at(leaf, null, i & MASK) : this.base.get(i);
  }

  /** A dense write's whole array, to write rows into directly — the
   * write then counts as made — or null for a sparse write, whose rows go
   * through `set`. */
  array(): S | null {
    if (this.whole === null) return null;
    this.wrote = true;
    return this.whole;
  }

  set(i: number, v: Item<S>): void {
    this.wrote = true;
    const storage = this.base.storage;
    if (this.whole !== null) {
      storage.set(this.whole, i, v);
      return;
    }
    const own = (this.own ??= []);
    const k = i >>> LEAF_BITS;
    let leaf = own[k];
    if (leaf === undefined) {
      leaf = this.base.leaves()[k].slice() as S;
      own[k] = leaf;
    }
    storage.set(leaf, i & MASK, v);
  }

  done(): Column<S> {
    if (!this.wrote) return this.base;
    if (this.whole !== null) return Column.of(this.whole);
    const leaves = this.base.leaves().slice();
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

// ─── kinds ─────────────────────────────────────────────────────────────
//
// A geometry's column holds one KIND of value: numbers, booleans, strings,
// fixed-width numeric vectors, references to rows, or placements. A number
// column is the Float64 column itself; every other kind is a STORED column,
// a view over one column (its store) with a codec — `width` stored values a
// row, and how a value is written as them and read back. Every kind has the
// column's words — `length`, `get`, `append`, `keep`, `gather`, a `writer`
// that copies the leaves it touches, `flat()` joined once and kept,
// `sameValues` — and its kind (`kinds.*`) is the door that makes one:
// `of(flat)` adopts a flat, `from(values)` copies values, `filled(n, v?)`
// is `n` rows of `v` or of the kind's default.
//
// Storage per kind, never named outside this file:
//
// | kind      | a row          | stored as                               |
// |-----------|----------------|-----------------------------------------|
// | number    | a number       | the Float64 column itself               |
// | boolean   | true / false   | a Uint8 column, 1 or 0                  |
// | string    | a string       | a column of plain arrays                |
// | vector(k) | k numbers      | a Float64 column, k values a row        |
// | reference | a row id, null | a Float64 column, -1 for null           |
// | placement | any value      | a column of plain arrays                |

/** The kinds of value a column holds. */
export type KindName = 'number' | 'boolean' | 'string' | 'vector' | 'reference' | 'placement';

/**
 * What a kind of column is: its name, the default a new row takes, whether
 * it interpolates, the equality that compares two values, and the doors
 * that make a column of it.
 *
 * Only `number` and `vector` interpolate. A boolean, a string, a reference
 * or a placement never does: a row made between two rows (a split child, a
 * resampled point) takes a value one of them has — the parent's — and
 * never a blend. Which of the two is the geometry's transfer rule.
 */
export interface ColumnKind<V = unknown, F = unknown, C extends AnyColumn = AnyColumn> {
  readonly name: KindName;
  /** Values a row takes in the flat: `k` for a vector, else 1. */
  readonly width: number;
  /** The value of a row nothing has set. */
  readonly default: V;
  /** Does a row made between two rows blend their values? */
  readonly interpolates: boolean;
  /** Are two values the same? */
  equal(a: V, b: V): boolean;
  /** The column of this flat, adopted, not copied: it must not be written
   * after this. The same flat is the same column. */
  of(flat: F): C;
  /** The column of these values, copied. */
  from(values: ArrayLike<V>): C;
  /** `length` rows of `value`, the kind's default when it is not given. */
  filled(length: number, value?: V): C;
}

/** Any kind a geometry column is: the doors every kind answers, values
 * untyped. A column of any kind is made through them. */
export type AnyKind = ColumnKind;

/** Any column a geometry holds: a number column — the Float64 column
 * itself, so a kernel that reads numbers narrows to it with `instanceof
 * Column` — or a stored column. Every one answers `length`, `get`, `flat`,
 * `gather`, `keep`, `writer` and `sameValues`; `kindOf` is its kind. */
export type AnyColumn = Column<Float64Array> | StoredColumn<unknown, Flat>;

/** One write of any column: `set` takes a value of the column's kind. */
export interface AnyWriter {
  get(i: number): unknown;
  set(i: number, v: unknown): void;
  done(): AnyColumn;
}

// ─── number ────────────────────────────────────────────────────────────

type NumberKind = ColumnKind<number, Float64Array, Column<Float64Array>>;

const numberKind: NumberKind = Object.freeze({
  name: 'number' as const,
  width: 1,
  default: 0,
  interpolates: true,
  equal: (a: number, b: number) => a === b,
  of: (flat: Float64Array) => Column.of(flat),
  from: (values: ArrayLike<number>) => Column.of(Float64Array.from(values)),
  filled: (length: number, value = 0) => Column.of(Object.is(value, 0) ? new Float64Array(length) : new Float64Array(length).fill(value)),
});

// ─── stored kinds: a value written as `width` stored values ────────────

/** What reads a store: a column, or a write as it stands. */
interface Reader {
  get(i: number): unknown;
}

/** What a stored kind is: its name, storage, width and default, and how
 * it writes a value as stored values and reads it back. */
interface Codec<V, S extends Flat> {
  readonly name: KindName;
  readonly storage: Storage<S>;
  /** Stored values a row; 1 when not given. */
  readonly width?: number;
  readonly default: V;
  /** Does a row made between two rows blend their values? No when not
   * given. */
  readonly interpolates?: boolean;
  /** Write the `width` stored values of `v` into `out` from `at`. */
  encode(v: V, out: Out, at: number): void;
  /** The value whose stored values start at `at` of `read`. */
  decode(read: Reader, at: number): V;
  /** Are two values the same? `===` when not given. */
  equal?(a: V, b: V): boolean;
}

/** A kind of value written as `width` stored values a row: a boolean as 1
 * or 0, a reference as the row's id or -1, a vector as its numbers, a
 * string or a placement as itself. */
export class StoredKind<V, S extends Flat> implements ColumnKind<V, S, StoredColumn<V, S>> {
  readonly name: KindName;
  readonly width: number;
  readonly default: V;
  readonly interpolates: boolean;
  /** @internal How a value is stored and read back. */
  readonly codec: Codec<V, S>;
  /** One row's stored values, for a write or a fill. */
  private readonly row: Out;
  /** The stored column over each store, so the same store is the same
   * column. */
  private readonly over = new WeakMap<Column<S>, StoredColumn<V, S>>();

  /** @internal Use `kinds.*`. */
  constructor(codec: Codec<V, S>) {
    this.codec = codec;
    this.name = codec.name;
    this.width = codec.width ?? 1;
    this.default = codec.default;
    this.interpolates = codec.interpolates ?? false;
    this.row = codec.storage.make(this.width) as unknown as Out;
  }

  equal(a: V, b: V): boolean {
    return this.codec.equal !== undefined ? this.codec.equal(a, b) : a === b;
  }

  of(flat: S): StoredColumn<V, S> {
    const w = this.width;
    if (flat.length % w !== 0) throw new RangeError(`a ${this.name} column of width ${w} takes a flat whose length is a multiple of ${w}; got ${flat.length}`);
    return this.wrap(Column.of(flat));
  }

  from(values: ArrayLike<V>): StoredColumn<V, S> {
    return this.of(this.encoded(values));
  }

  filled(length: number, value: V = this.default): StoredColumn<V, S> {
    const w = this.width;
    const out = this.codec.storage.make(length * w) as unknown as Out;
    const row = this.encodedRow(value);
    for (let at = 0; at < out.length; at += w) for (let s = 0; s < w; s++) out[at + s] = row[s];
    return this.of(out as unknown as S);
  }

  /** @internal The values as stored values, in a new flat. */
  encoded(values: ArrayLike<V>): S {
    const w = this.width;
    const out = this.codec.storage.make(values.length * w) as unknown as Out;
    const codec = this.codec;
    for (let r = 0; r < values.length; r++) codec.encode(values[r], out, r * w);
    return out as unknown as S;
  }

  /** @internal `v`'s stored values, in a scratch row the next call reuses. */
  encodedRow(v: V): Out {
    this.codec.encode(v, this.row, 0);
    return this.row;
  }

  /** @internal The stored column over `store`. */
  wrap(store: Column<S>): StoredColumn<V, S> {
    let c = this.over.get(store);
    if (c === undefined) {
      c = new StoredColumn(this, store);
      this.over.set(store, c);
    }
    return c;
  }
}

/** A column of a stored kind: a view over its store, `width` stored values
 * a row. Its flat and its leaves are the stored values. */
export class StoredColumn<V, S extends Flat> {
  readonly kind: StoredKind<V, S>;
  /** @internal The stored values underneath. */
  readonly store: Column<S>;
  /** How many rows. */
  readonly length: number;

  /** @internal Use the kind: `kinds.boolean.of(flat)`. */
  constructor(kind: StoredKind<V, S>, store: Column<S>) {
    this.kind = kind;
    this.store = store;
    this.length = store.length / kind.width;
  }

  /** The value at row `i` (a vector as a new array). */
  get(i: number): V {
    return this.kind.codec.decode(this.store, i * this.kind.width);
  }

  /** Stored value `s` of row `i`: one number of a vector, and nothing made. */
  component(i: number, s: number): Item<S> {
    return this.store.get(i * this.kind.width + s);
  }

  flat(): S {
    return this.store.flat();
  }

  /** The leaves of stored values, in order. Read them; never write them. */
  leaves(): readonly S[] {
    return this.store.leaves();
  }

  gather(rows: ArrayLike<number>): S {
    return this.store.gather(rows, this.kind.width);
  }

  append(values: ArrayLike<V>): StoredColumn<V, S> {
    if (values.length === 0) return this;
    return this.kind.wrap(this.store.append(this.kind.encoded(values) as unknown as ArrayLike<Item<S>>));
  }

  keep(rows: ArrayLike<number>): StoredColumn<V, S> {
    return this.kind.wrap(this.store.keep(rows, this.kind.width));
  }

  writer(reach: Reach): StoredWriter<V, S> {
    const k = this.kind.width;
    let at: Reach = reach;
    if (reach !== 'all' && reach !== 'some' && k > 1) {
      const values = new Float64Array(reach.length * k);
      for (let r = 0; r < reach.length; r++) for (let s = 0; s < k; s++) values[r * k + s] = reach[r] * k + s;
      at = values;
    }
    return new StoredWriter(this.kind, this.store.writer(at));
  }

  sameValues(other: StoredColumn<V, S>): boolean {
    return other.kind === this.kind && this.store.sameValues(other.store);
  }
}

/** One write of a stored column (see `ColumnWriter`). */
export class StoredWriter<V, S extends Flat> implements AnyWriter {
  private readonly kind: StoredKind<V, S>;
  private readonly w: ColumnWriter<S>;

  constructor(kind: StoredKind<V, S>, w: ColumnWriter<S>) {
    this.kind = kind;
    this.w = w;
  }

  /** The value at row `i` as the write stands. */
  get(i: number): V {
    return this.kind.codec.decode(this.w, i * this.kind.width);
  }

  set(i: number, v: V): void {
    const k = this.kind.width;
    const row = this.kind.encodedRow(v);
    for (let s = 0; s < k; s++) this.w.set(i * k + s, row[s] as Item<S>);
  }

  done(): StoredColumn<V, S> {
    return this.kind.wrap(this.w.done());
  }
}

const F64 = storageFor(Float64Array);

/** A plain value stored as itself. */
const itself = <V>(v: V, out: Out, at: number): void => {
  out[at] = v;
};
const readItself = <V>(read: Reader, at: number): V => read.get(at) as V;

/** A column of booleans: a Uint8 column of 1 and 0. */
export type BooleanColumn = StoredColumn<boolean, Uint8Array>;

const booleanKind = new StoredKind<boolean, Uint8Array>({
  name: 'boolean',
  storage: storageFor(Uint8Array),
  default: false,
  encode: (v, out, at) => {
    out[at] = v ? 1 : 0;
  },
  decode: (read, at) => read.get(at) !== 0,
});

/**
 * A column of references to rows of the same value: a row's `id` (the
 * minted id, which is a positive whole number), or null for no row.
 *
 * The column keeps the id and nothing else. Which row an id names — and
 * that the row is still there — is the geometry's to resolve, by id and
 * never by row index, so a reference survives any write that keeps the row
 * it names; an id whose row is gone resolves to nothing.
 */
export type ReferenceColumn = StoredColumn<number | null, Float64Array>;

const referenceKind = new StoredKind<number | null, Float64Array>({
  name: 'reference',
  storage: F64,
  default: null,
  encode: (v, out, at) => {
    out[at] = v === null ? -1 : v;
  },
  decode: (read, at) => {
    const x = read.get(at) as number;
    return x < 0 ? null : x;
  },
});

/** A column of strings. */
export type StringColumn = StoredColumn<string, readonly string[]>;

const stringKind = new StoredKind<string, readonly string[]>({
  name: 'string',
  storage: plainStorage as Storage<readonly string[]>,
  default: '',
  encode: itself,
  decode: readItself,
});

/** A column of placements: an opaque value a row, null for none. The
 * column never reads the value; it only keeps it. A placement is equal to
 * itself only. */
export type PlacementColumn = StoredColumn<unknown, readonly unknown[]>;

const placementKind = new StoredKind<unknown, readonly unknown[]>({
  name: 'placement',
  storage: plainStorage,
  default: null,
  encode: itself,
  decode: readItself,
});

/** A column of fixed-width numeric vectors: `width` numbers a row, stored
 * as one Float64 column `width` values a row (as an edge list is two).
 * `get` makes a fresh array; `component` reads one number. */
export type VectorColumn = StoredColumn<readonly number[], Float64Array>;

const vectorKinds = new Map<number, StoredKind<readonly number[], Float64Array>>();

function vectorKind(width: number): StoredKind<readonly number[], Float64Array> {
  if (!Number.isInteger(width) || width < 1) throw new RangeError(`a vector column is a whole number of values wide, 1 or more; got ${width}`);
  let kind = vectorKinds.get(width);
  if (kind === undefined) {
    kind = new StoredKind<readonly number[], Float64Array>({
      name: 'vector',
      storage: F64,
      width,
      default: Object.freeze(new Array<number>(width).fill(0)),
      interpolates: true,
      equal: (a, b) => {
        for (let s = 0; s < width; s++) if (a[s] !== b[s]) return false;
        return true;
      },
      encode: (v, out, at) => {
        if (v.length !== width) throw new RangeError(`a vector column of width ${width} takes vectors of ${width} numbers; got ${v.length}`);
        for (let s = 0; s < width; s++) out[at + s] = v[s];
      },
      decode: (read, at) => {
        const out: number[] = [];
        for (let s = 0; s < width; s++) out.push(read.get(at + s) as number);
        return out;
      },
    });
    vectorKinds.set(width, kind);
  }
  return kind;
}

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

/** The kind of any column: a number column is `kinds.number`; a stored
 * column says its own. */
export function kindOf(c: AnyColumn): AnyKind {
  return c instanceof Column ? numberKind : c.kind;
}

/** Is `v` a column of a kind other than numbers (a boolean, string,
 * vector, reference or placement column)? */
export function isTypedColumn(v: unknown): v is StoredColumn<unknown, Flat> {
  return v instanceof StoredColumn;
}

/** `a`, then every row of `b`: two columns of one kind joined. Every whole
 * leaf of `a` is shared. */
export function joinColumns(a: AnyColumn, b: AnyColumn): AnyColumn {
  if (a instanceof Column) return a.append((b as Column).flat());
  return a.kind.wrap(a.store.append((b as StoredColumn<unknown, Flat>).store.flat()));
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

// ─── spec-74 handoff: kept until their callers take the words above ───

/** @deprecated spec-74 handoff: `c.get(i)`. */
export function valueAt(c: AnyColumn, i: number): unknown {
  return c.get(i);
}

/** @deprecated spec-74 handoff: `kind.filled(length, v)`. */
export function constantColumn(kind: AnyKind, length: number, v: unknown): AnyColumn {
  return kind.filled(length, v);
}

/** @deprecated spec-74 handoff: `joinColumns(c, kindOf(c).from(values))`. */
export function appendValues(c: AnyColumn, values: ArrayLike<unknown>): AnyColumn {
  return joinColumns(c, kindOf(c).from(values));
}

/** @deprecated spec-74 handoff: `c.keep(rows)`. */
export function keepRows(c: AnyColumn, rows: ArrayLike<number>): AnyColumn {
  return c.keep(rows);
}

/** @deprecated spec-74 handoff: `kindOf(c).of(c.gather(rows))`. */
export function gatherColumn(c: AnyColumn, rows: ArrayLike<number>): AnyColumn {
  return kindOf(c).of(c.gather(rows));
}

/** @deprecated spec-74 handoff: `c.writer(reach)`. */
export function writerOf(c: AnyColumn, reach: Reach): AnyWriter {
  return c.writer(reach);
}

/** @deprecated spec-74 handoff: `StringColumn`. */
export type ArrayColumn<V> = StoredColumn<V, readonly V[]>;

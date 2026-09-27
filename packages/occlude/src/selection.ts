/**
 * One selection, over any domain.
 *
 * `m.points`, `m.edges`, `m.faces`, `l.faces`, `mesh.points`,
 * `mesh.corners`, a curve's edges, a sample's points: every collection of
 * rows a geometry answers is a `Selection`, and so is every part of one a
 * sketch picks out. There is ONE implementation of the words they share —
 * iterate, `length`, `at`, `map`, `find`, `some`, `every`, `forEach`,
 * `filter`, `groupBy`, `has`, `union`, `intersect`, `without`,
 * `slice`, `rows`, the relations `adjacent()`, `connected()` and
 * `components()`, `near`, and the reductions `sum`, `mean`, `min` and `max`.
 * What differs from domain to domain is data, and a DOMAIN says it: how a
 * row reads, who a row is across states, which rows neighbour which, how
 * far a place is from a row. A domain is made once per state.
 *
 * The words only some domains have (writes, extraction, the edges'
 * `nearest` and `firstHit`, the faces' `boundaryEdges` and `measure`, …)
 * come with the domain's KIND, which puts them on the selections of that
 * kind. A word a kind does not have refuses by name: "faces have no near".
 * The words other code reads to learn what a value is — `points`, `edges`,
 * `faces`, `corners`, `contours`, `curves` — are the geometry protocol, and
 * a selection answers only the ones its kind can answer honestly: a point
 * selection has no `contours`, and `'faces' in` it is false.
 *
 * A selection holds its rows IN AN ORDER. A domain's own collection is in
 * row order. `filter`, `without`, `intersect` and `slice` keep
 * the receiver's order; `union(...others)` is the receiver's members and
 * then each other's new members, in their order; the groups of `groupBy`
 * and the pieces of `components` keep it; `near` answers NEAREST FIRST,
 * ties by row. The relations `adjacent()` and `connected()` are new
 * collections of the domain and come in row order.
 *
 * A selection belongs to one state. Handed a selection or a row of another
 * state of the same evolution — a write's `where`, a set operation's
 * operand, `has` — it finds the same rows by identity, and a row that is
 * gone is left out. It does not apply the rule that made it again.
 */

import type { XY } from './vec.js';
import { ownerOf, viewKind } from './views.js';
import type { Vertex } from './material.js';
import type { NearestHit, FirstHit } from './query.js';

/**
 * The key a row type uses to say what a selection of its rows answers per
 * domain: the cross-domain collections, the write and its result, what
 * `extract()` makes. A type-level word only — no row carries it — so one
 * `Selection<Row>` reads the right types for a vertex, a mesh face or a
 * lattice face.
 */
export const ROW_TYPES: unique symbol = Symbol('rowTypes');

/**
 * What a selection of some rows answers, by name: the protocol words
 * (`points`, `edges`, `faces`, `corners`, `contours`, `curves`), the state
 * (`source`), and the words a kind brings. A row type declares its own with
 * `Types<{ … }>` under `ROW_TYPES`; a word it leaves out is absent —
 * `undefined` for a protocol word, `never` for a kind word, so a call a
 * domain cannot answer does not compile, and refuses by name at run time.
 */
export interface DomainTypes {
  source: unknown;
  points: unknown;
  edges: unknown;
  faces: unknown;
  corners: unknown;
  contours: unknown;
  curves: unknown;
  set: unknown;
  add: unknown;
  remove: unknown;
  extract: unknown;
  boundaryEdges: unknown;
  measure: unknown;
  thicken: unknown;
  resample: unknown;
  trim: unknown;
  spline: unknown;
  oscillate: unknown;
  along: unknown;
}
/** Every word absent. */
interface Absent extends DomainTypes {
  source: object;
  points: undefined;
  edges: undefined;
  faces: undefined;
  corners: undefined;
  contours: undefined;
  curves: undefined;
  set: never;
  add: never;
  remove: never;
  extract: never;
  boundaryEdges: never;
  measure: never;
  thicken: never;
  resample: never;
  trim: never;
  spline: never;
  oscillate: never;
  along: never;
}
/** A row type's declaration: the words it names, every other word absent. */
export type Types<T extends Partial<DomainTypes>> = Omit<Absent, keyof T> & T;
/** What a row may declare: what a selection of it answers. A row that
 * declares nothing answers every word as `unknown`. */
export interface Rowish {
  readonly [ROW_TYPES]?: DomainTypes;
}
/** @internal The declaration of a row type. An indexed access, not a
 * conditional type, so `Selection<Row>` stays covariant in `Row`: a
 * selection of tiling faces is a selection of faces. */
export type RowTypes<Row> = NonNullable<(Row & Rowish)[typeof ROW_TYPES]>;

/**
 * A kind of domain: points, edges, faces, corners, instances. It
 * names the rows in messages, and it holds the words only this kind of
 * selection has — its prototype, which inherits every shared word from
 * `Selection`. One kind serves every state.
 */
export interface DomainKind {
  /** One row: `point`, `edge`, `face`, `corner`, `instance`. */
  readonly name: string;
  /** Many rows, as messages name them: `points`, `edges`, … */
  readonly plural: string;
  /** @internal The prototype of this kind's selections. */
  readonly proto: object;
  /** A refusal's own words, by the word refused: why this kind has none. */
  readonly refusals: Readonly<Record<string, string>>;
}

/**
 * The rows of one kind in one state, and what a selection needs to know
 * about them. Made once per state and kept there, so two selections of the
 * same state share it and `a.domain === b.domain` is "the same rows".
 */
export interface Domain<Row = unknown> {
  readonly kind: DomainKind;
  /** The state the rows belong to: a material, a lattice, a surface, … */
  readonly source: object;
  /** How many rows the domain holds. */
  readonly size: number;
  /** True when the rows are exactly `0 … size − 1`; a lattice's masked
   * faces are not. */
  readonly dense: boolean;
  /** Every row, in row order. Built once and kept. */
  all(): readonly number[];
  /** Is `row` one of this domain's rows? */
  valid(row: number): boolean;
  /** The view of one row. */
  row(row: number): Row;
  /**
   * The row a single member names here — a row view of this state, one of
   * another state of the same evolution (found by identity), or a value the
   * domain takes as a name — or -1 when it is gone. Anything else is the
   * wrong program, refused by name.
   */
  rowOf(value: unknown, who: string): number;
  /**
   * The rows here that another selection of this kind holds, in its order,
   * found by identity; the ones that are gone are left out. A selection of
   * another kind, or of a state that shares nothing with this one, is
   * refused by name.
   */
  resolve(other: Selection<any>, who: string): number[];
  /** The same kind of rows in another state value (`selectionIn`). */
  on(state: unknown, who: string): Domain<Row>;
  /** The rows beside one row: what `adjacent`, `connected` and
   * `components` walk. A kind with no neighbours has none. */
  neighbours?(row: number): Iterable<number>;
  /** The rows of the whole state closer than `radius` to `p`, and the
   * distance of each, position by position: what `near` reads. A kind with
   * no distance has none. */
  near?(p: unknown, radius: number, who: string): { readonly rows: readonly number[]; readonly distances: ArrayLike<number> };
  /** A reduction of a column the domain stores by row, over `members`
   * (null: every row), with the shared words' rules — a value that is not
   * finite is left out, the members are read in order — or undefined for a
   * name it does not store so. What `sum`, `mean`, `min` and `max` ask
   * first, so a raster domain answers without making a row per member. */
  reduce?(name: string, members: readonly number[] | null, op: 'sum' | 'mean' | 'min' | 'max'): number | undefined;
}

/** A key a `groupBy` or `components` gave its group. */
export type Keyed<S, K> = S & { readonly key: K };

const describe = (v: unknown): string => {
  if (v === null) return 'null';
  if (v instanceof Selection) return `a ${v.domain.kind.name} selection`;
  if (Array.isArray(v)) return `an array of ${v.length}`;
  if (typeof v === 'object') return (v as object).constructor?.name ? `a ${(v as object).constructor.name}` : 'an object';
  return typeof v;
};

/**
 * A selection of rows of one domain in one state. See the module comment:
 * one class, every domain, the words a domain lacks refused by name.
 *
 * `Row` is the row view: `Vertex`, `Edge`, `Face`, `LatticeFace`, a mesh's point
 * row, … — what iteration yields and what every predicate reads.
 */
export class Selection<Row> implements Iterable<Row> {
  /** @internal The rows these are: their kind and state. */
  declare readonly domain: Domain<Row>;
  /** @internal The members, in order — or null for every row, in row order. */
  declare readonly members: readonly number[] | null;
  /** The classification that made this group (`groupBy`, `components`);
   * undefined otherwise. */
  declare readonly key: unknown;
  /** @internal Lazy membership set, kept in a box so the selection is frozen. */
  declare readonly box: { held: Set<number> | null };

  // ---- the geometry protocol: present only on the kinds that answer it ----

  /** The points: itself for a point selection, the ends or corners for
   * edges and faces. Absent where the domain has no points. */
  declare readonly points: RowTypes<Row>['points'];
  /** The edges: itself for an edge selection; the edges among a point
   * selection's members; the edges of a face selection's faces. */
  declare readonly edges: RowTypes<Row>['edges'];
  /** The faces (3D, and a face selection itself). */
  declare readonly faces: RowTypes<Row>['faces'];
  /** The corners (3D). */
  declare readonly corners: RowTypes<Row>['corners'];
  /** The areas, for a face selection: the outline of its union. */
  declare readonly contours: RowTypes<Row>['contours'];
  /** The chains through the members (2D). */
  declare readonly curves: RowTypes<Row>['curves'];

  // ---- the words a kind brings, typed by the row ----

  /** The geometry with columns set on these rows, or on those `where`
   * names among them; see the domain's page for the forms. */
  declare readonly set: RowTypes<Row>['set'];
  /** The geometry with new rows (points and edges of a material). */
  declare readonly add: RowTypes<Row>['add'];
  /** The geometry without these rows (points and edges of a material). */
  declare readonly remove: RowTypes<Row>['remove'];
  /** Independent geometry of these rows, every column and id kept. */
  declare readonly extract: RowTypes<Row>['extract'];

  /** Selections are read from a geometry — `m.points`, `m.edges`,
   * `m.faces`, `mesh.faces` — never constructed. */
  protected constructor() {
    throw new Error('a selection is read from a geometry: m.points, m.edges, m.faces, l.faces, mesh.faces');
  }

  /** The state the rows belong to. */
  get source(): RowTypes<Row>['source'] {
    return (isInstance(this) ? this.domain.source : undefined) as RowTypes<Row>['source'];
  }

  /** The members' rows, in the selection's order. A row is a state's own
   * numbering, not an identity. */
  get indices(): readonly number[] {
    if (!isInstance(this)) return [];
    return this.members ?? this.domain.all();
  }

  get length(): number {
    if (!isInstance(this)) return 0;
    return this.members === null ? this.domain.size : this.members.length;
  }

  /** @internal The row at position `k` (already checked). */
  rowAt(k: number): number {
    const m = this.members;
    if (m !== null) return m[k];
    return this.domain.dense ? k : this.domain.all()[k];
  }

  /** @internal Does this selection hold that row of its state? */
  holds(row: number): boolean {
    if (this.members === null) return this.domain.valid(row);
    const box = this.box;
    return (box.held ??= new Set(this.members)).has(row);
  }

  /** The member at position `i`; a negative `i` counts back from the end,
   * so `at(-1)` is the last. A position past the end is refused by name. */
  at(i: number): Row {
    const n = this.length;
    const k = i < 0 ? n + i : i;
    if (!Number.isInteger(k) || k < 0 || k >= n) throw new Error(`${this.domain.kind.plural}.at: no member ${i} (${n} members)`);
    return this.domain.row(this.rowAt(k));
  }

  *[Symbol.iterator](): Iterator<Row> {
    const d = this.domain;
    const m = this.members;
    if (m !== null) {
      for (let k = 0; k < m.length; k++) yield d.row(m[k]);
    } else if (d.dense) {
      for (let i = 0; i < d.size; i++) yield d.row(i);
    } else {
      for (const i of d.all()) yield d.row(i);
    }
  }

  map<T>(fn: (row: Row, index: number) => T): T[] {
    const n = this.length;
    const out = new Array<T>(n);
    for (let k = 0; k < n; k++) out[k] = fn(this.domain.row(this.rowAt(k)), k);
    return out;
  }

  forEach(fn: (row: Row, index: number) => void): void {
    const n = this.length;
    for (let k = 0; k < n; k++) fn(this.domain.row(this.rowAt(k)), k);
  }

  find(fn: (row: Row, index: number) => unknown): Row | undefined {
    const n = this.length;
    for (let k = 0; k < n; k++) {
      const row = this.domain.row(this.rowAt(k));
      if (fn(row, k)) return row;
    }
    return undefined;
  }

  some(fn: (row: Row, index: number) => unknown): boolean {
    return this.find(fn) !== undefined;
  }

  every(fn: (row: Row, index: number) => unknown): boolean {
    const n = this.length;
    for (let k = 0; k < n; k++) if (!fn(this.domain.row(this.rowAt(k)), k)) return false;
    return true;
  }

  /** The members `fn` picks, in this selection's order; a group keeps its key. */
  filter<S extends Selection<Row>>(this: S, fn: (row: Row, index: number) => unknown): S {
    const n = this.length;
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const r = this.rowAt(k);
      if (fn(this.domain.row(r), k)) out.push(r);
    }
    return select(this.domain, out, this.key, true) as S;
  }

  /** One selection per key, in the order the keys first appear; each keeps
   * this selection's order and carries its `key`. Keys compare as a Map
   * compares them. The key is not a column: no later state knows it. */
  groupBy<K>(classify: (row: Row, index: number) => K): Keyed<Selection<Row>, K>[] {
    const groups = new Map<K, number[]>();
    const n = this.length;
    for (let k = 0; k < n; k++) {
      const r = this.rowAt(k);
      const key = classify(this.domain.row(r), k);
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    }
    return Array.from(groups, ([key, rows]) => select(this.domain, rows, key, true) as Keyed<Selection<Row>, K>);
  }

  /** True when `row` is a member. A row of another state of the same
   * evolution is asked about by identity; one that is gone is not a
   * member. A row of another kind is refused by name. */
  has(row: Row | object): boolean {
    const r = this.domain.rowOf(row, `${this.domain.kind.plural}.has`);
    return r >= 0 && this.holds(r);
  }

  /** The selection holding those rows of the state — never positions
   * within this selection: row numbers, or the rows themselves, one or a
   * list, in the order given. The door for a relation a sketch worked out
   * for itself. A row of another state is found by identity; one that is
   * gone is skipped, as every set operation skips it, and a row of an
   * unrelated geometry is refused by name. */
  rows(rows: number | Row | Iterable<number | Row>): Selection<Row> {
    const d = this.domain;
    const who = `${d.kind.plural}.rows`;
    const one = (r: number | Row): number => {
      if (typeof r === 'number') {
        if (!Number.isInteger(r) || !d.valid(r)) throw new Error(`${who}: no ${d.kind.name} ${r} in this state (${d.size} rows)`);
        return r;
      }
      return memberRow(d, r, who);
    };
    if (typeof rows === 'number') return select(d, [one(rows)], undefined, true);
    if (typeof rows !== 'object' || rows === null) throw new Error(`${who}: expected a ${d.kind.name} row, a row number, or a list of them — got ${describe(rows)}`);
    if (rows instanceof Selection) return select(d, this.operand(rows, 'rows'), undefined, true);
    // A list of rows, or one row (a row is not iterable).
    const list = typeof (rows as Iterable<unknown>)[Symbol.iterator] === 'function' ? Array.from(rows as Iterable<number | Row>, one) : [one(rows as Row)];
    return select(d, list.filter((r) => r >= 0), undefined, list.length === 1);
  }

  /** @internal The rows another selection names here, in its order. */
  operand(other: unknown, op: string): readonly number[] {
    const d = this.domain;
    const who = `${d.kind.plural}.${op}`;
    if (!(other instanceof Selection)) throw new Error(`${who}: a ${d.kind.name} selection combines only with a ${d.kind.name} selection — got ${describe(other)}`);
    if (other.domain !== d && other.domain.kind.name !== d.kind.name) {
      throw new Error(`${who}: a ${d.kind.name} selection combines only with a ${d.kind.name} selection — selection set operations require the same domain (${d.kind.plural}, got ${other.domain.kind.plural})`);
    }
    return rowsIn(d, other, who);
  }

  /** This selection's members, then each other selection's members that
   * are new, in their order. An operand of an earlier state of the same
   * evolution is read by identity. The key is kept, so a list of groups
   * folds with `groups.reduce((a, b) => a.union(b))`. */
  union<S extends Selection<Row>>(this: S, ...others: Selection<any>[]): S {
    const out = [...this.indices];
    const seen = new Set(out);
    for (const other of others) {
      for (const r of this.operand(other, 'union')) {
        if (seen.has(r)) continue;
        seen.add(r);
        out.push(r);
      }
    }
    return select(this.domain, out, this.key, true) as S;
  }

  /** The members the other selection also holds, in this order. */
  intersect<S extends Selection<Row>>(this: S, other: Selection<any>): S {
    const theirs = new Set(this.operand(other, 'intersect'));
    return select(this.domain, this.indices.filter((r) => theirs.has(r)), this.key, true) as S;
  }

  /** The members that `other` does not name — a selection, or one row or
   * value the domain takes as a name, of this state or an earlier one — in
   * this order. Nothing takes nothing away. */
  without<S extends Selection<Row>>(this: S, other: Selection<any> | Row | object | undefined): S {
    if (other === undefined || other === null) return this;
    let gone: Set<number>;
    if (other instanceof Selection) gone = new Set(this.operand(other, 'without'));
    else {
      const r = this.domain.rowOf(other, `${this.domain.kind.plural}.without`);
      if (r < 0) return this;
      gone = new Set([r]);
    }
    if (gone.size === 0) return this;
    return select(this.domain, this.indices.filter((r) => !gone.has(r)), this.key, true) as S;
  }

  /** The members at positions `start` up to `end` (not included), read as
   * an array's `slice` reads them: a negative position counts from the end. */
  slice<S extends Selection<Row>>(this: S, start?: number, end?: number): S {
    return select(this.domain, this.indices.slice(start, end), this.key, true) as S;
  }

  // ---- relations ----

  private neighbours(word: string): (row: number) => Iterable<number> {
    const d = this.domain;
    if (!d.neighbours) return refuse(this, word);
    return (row) => d.neighbours!(row);
  }

  /** Every row beside a member, the members excluded: one step out. The
   * selection grown by a ring is `sel.union(sel.adjacent())`. Row order. */
  adjacent(): Selection<Row> {
    const next = this.neighbours('adjacent');
    const out: number[] = [];
    const seen = new Set<number>();
    for (const r of this.indices) {
      for (const w of next(r)) {
        if (seen.has(w) || this.holds(w)) continue;
        seen.add(w);
        out.push(w);
      }
    }
    return select(this.domain, out.sort((a, b) => a - b), undefined, true);
  }

  /** The members and every row reachable from them: the pieces the
   * selection touches, whole. Row order. */
  connected(): Selection<Row> {
    const next = this.neighbours('connected');
    const seen = new Set<number>(this.indices);
    const stack = [...seen];
    while (stack.length) {
      const r = stack.pop()!;
      for (const w of next(r)) {
        if (seen.has(w)) continue;
        seen.add(w);
        stack.push(w);
      }
    }
    return select(this.domain, [...seen].sort((a, b) => a - b), undefined, true);
  }

  /** One selection per connected piece OF THE MEMBERS, joined through the
   * members alone: an isolated member is a piece of its own. Keyed 0, 1,
   * 2 … like `groupBy`, in the order this selection first meets them; each
   * piece in row order. */
  components(): Keyed<Selection<Row>, number>[] {
    const next = this.neighbours('components');
    const seen = new Set<number>();
    const out: Keyed<Selection<Row>, number>[] = [];
    for (const start of this.indices) {
      if (seen.has(start)) continue;
      const piece: number[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const r = stack.pop()!;
        piece.push(r);
        for (const w of next(r)) {
          if (seen.has(w) || !this.holds(w)) continue;
          seen.add(w);
          stack.push(w);
        }
      }
      out.push(select(this.domain, piece.sort((a, b) => a - b), out.length, true) as Keyed<Selection<Row>, number>);
    }
    return out;
  }

  /**
   * The members CLOSER THAN `radius` to `p`, NEAREST FIRST, ties by row.
   * The bound is strict. Proximity, not topology: `adjacent` is topology.
   * The radius is a length of the geometry's space. Distance to a point
   * is to the point; to an edge, to the whole edge; to a cell, to its
   * centre. A row of this state is never its own neighbour.
   */
  near(p: XY | { readonly x: number; readonly y: number; readonly z: number } | readonly [number, number, number], opts: { readonly radius: number }): Selection<Row> {
    const d = this.domain;
    if (!d.near) return refuse(this, 'near');
    const who = `${d.kind.plural}.near`;
    const radius = (opts as { radius?: unknown } | undefined)?.radius;
    const { rows, distances } = d.near(p, radius as number, who);
    // The positions of the members among the rows found, sorted by
    // (distance, row).
    const order: number[] = [];
    for (let k = 0; k < rows.length; k++) if (this.members === null || this.holds(rows[k])) order.push(k);
    order.sort((a, b) => distances[a] - distances[b] || rows[a] - rows[b]);
    const out = new Array<number>(order.length);
    for (let k = 0; k < order.length; k++) out[k] = rows[order[k]];
    return select(d, out, undefined, true);
  }

  // ---- reductions ----

  private numbers(of: string | ((row: Row, index: number) => number), op: string): number[] {
    const d = this.domain;
    const who = `${d.kind.plural}.${op}`;
    if (typeof of !== 'string' && typeof of !== 'function') throw new Error(`${who}: give a column name or a function of the ${d.kind.name} — got ${describe(of)}`);
    const out: number[] = [];
    const n = this.length;
    for (let k = 0; k < n; k++) {
      const row = d.row(this.rowAt(k));
      const v = typeof of === 'function' ? of(row, k) : (row as Record<string, unknown>)[of];
      if (typeof v !== 'number') {
        throw new Error(typeof of === 'function'
          ? `${who}: the function answered ${describe(v)} for ${d.kind.name} ${k}; a reduction reads numbers`
          : `${who}: '${of}' is not a number on every ${d.kind.name}`);
      }
      if (Number.isFinite(v)) out.push(v);
    }
    return out;
  }

  /** The sum of a column, or of a function of the row, over the members.
   * A value that is not finite is left out; the sum of nothing is 0. */
  sum(of: string | ((row: Row, index: number) => number)): number {
    const stored = typeof of === 'string' ? this.domain.reduce?.(of, this.members, 'sum') : undefined;
    if (stored !== undefined) return stored;
    let s = 0;
    for (const v of this.numbers(of, 'sum')) s += v;
    return s;
  }

  /** The mean, as `sum`; the mean of nothing is NaN. */
  mean(of: string | ((row: Row, index: number) => number)): number {
    const stored = typeof of === 'string' ? this.domain.reduce?.(of, this.members, 'mean') : undefined;
    if (stored !== undefined) return stored;
    const v = this.numbers(of, 'mean');
    let s = 0;
    for (const x of v) s += x;
    return s / v.length;
  }

  /** The least value, as `sum`; the least of nothing is Infinity. */
  min(of: string | ((row: Row, index: number) => number)): number {
    const stored = typeof of === 'string' ? this.domain.reduce?.(of, this.members, 'min') : undefined;
    if (stored !== undefined) return stored;
    let m = Infinity;
    for (const v of this.numbers(of, 'min')) if (v < m) m = v;
    return m;
  }

  /** The greatest value, as `sum`; the greatest of nothing is -Infinity. */
  max(of: string | ((row: Row, index: number) => number)): number {
    const stored = typeof of === 'string' ? this.domain.reduce?.(of, this.members, 'max') : undefined;
    if (stored !== undefined) return stored;
    let m = -Infinity;
    for (const v of this.numbers(of, 'max')) if (v > m) m = v;
    return m;
  }
}

/**
 * The words only some kinds have, typed here once and refused by name on
 * every other kind; a kind's prototype puts the real one in front. They
 * are not part of the geometry protocol, so a refusal here never makes a
 * value look like something it is not.
 */
export interface Selection<Row> {
  /** 2D edges: the closest member within `within` of `position` (inclusive),
   * or null; ties go to the earlier edge. `excludeIncident` skips the
   * edges that meet that vertex, so a tip senses the nearest line that is
   * not its own stem. */
  nearest(position: XY, opts: { within: number; excludeIncident?: Vertex | number }): NearestHit | null;
  /** 2D edges: the first member a straight move from `from` to `to` would
   * meet — by the distance along the move, then by row. Contact at an end
   * counts. `excludeIncident` skips the edges that meet that vertex. */
  firstHit(from: XY, to: XY, opts?: { excludeIncident?: Vertex | number }): FirstHit | null;
  /** 2D edges: the members the straight segment `a` → `b` crosses, both
   * sides strictly. */
  crossing(a: XY, b: XY): Selection<Row>;
  /** Faces: the edges between the selected union and the rest. */
  boundaryEdges: RowTypes<Row>['boundaryEdges'];
  /** 2D faces: the geometry with the faces' shape, and with a field its
   * integral and mean, as face columns. */
  measure: RowTypes<Row>['measure'];
  /** 2D points and edges: thickness around what the selection holds. */
  thicken: RowTypes<Row>['thicken'];
  /** 2D edges: the chains respaced along their length. */
  resample: RowTypes<Row>['resample'];
  /** 2D edges: each chain cut back at its ends. */
  trim: RowTypes<Row>['trim'];
  /** 2D edges: each chain through a smooth curve. */
  spline: RowTypes<Row>['spline'];
  /** 2D edges: a wave along each chain. */
  oscillate: RowTypes<Row>['oscillate'];
  /** 2D edges: points spaced along each chain, with a heading. */
  along: RowTypes<Row>['along'];
}


/** A selection, not a prototype in its chain: it holds a domain. */
const isInstance = (s: object): boolean => Object.prototype.hasOwnProperty.call(s, 'domain');

/** Refuse a word this kind does not have, by name. */
export function refuse(sel: { domain: Domain<any> }, word: string): never {
  const kind = sel.domain.kind;
  const why = kind.refusals[word];
  throw new Error(`${kind.plural}.${word}: ${why ?? `${kind.plural} have no ${word}`}`);
}

// The kind-only words, refused on every kind that does not bring its own.
for (const word of ['nearest', 'firstHit', 'crossing', 'boundaryEdges', 'measure', 'thicken', 'resample', 'trim', 'spline', 'oscillate', 'along', 'set', 'add', 'remove', 'extract']) {
  Object.defineProperty(Selection.prototype, word, {
    value: function (this: Selection<any>): never {
      return refuse(this, word);
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

/**
 * A kind of domain, with the words its selections have beyond the shared
 * ones: methods, and getters for the protocol words (`points`, `edges`,
 * `faces`, `corners`) — `this` is the selection.
 */
export function domainKind(
  name: string,
  plural: string,
  words: Record<string, PropertyDescriptor & ThisType<Selection<any>>> = {},
  refusals: Record<string, string> = {},
): DomainKind {
  const proto = Object.create(Selection.prototype) as object;
  for (const [word, desc] of Object.entries(words)) {
    // A getter read on the prototype itself — a printer walking the chain —
    // has no rows to answer about: it answers nothing.
    const get = desc.get;
    const d = get ? { ...desc, get(this: Selection<any>) { return isInstance(this) ? get.call(this) : undefined; } } : desc;
    Object.defineProperty(proto, word, { enumerable: false, configurable: false, ...d });
  }
  Object.freeze(proto);
  return Object.freeze({ name, plural, proto, refusals: Object.freeze({ ...refusals }) });
}

/**
 * A selection of `rows` of `domain`, in the order given. `unique` says the
 * rows hold no repeat, so they are taken as they are; otherwise a repeat
 * keeps its first place. `null` is every row, in row order.
 */
export function select<Row>(domain: Domain<Row>, rows: readonly number[] | null, key?: unknown, unique = false): Selection<Row> {
  const s = Object.create(domain.kind.proto) as { domain: Domain<Row>; members: readonly number[] | null; key: unknown; box: { held: Set<number> | null } };
  s.domain = domain;
  s.members = rows === null ? null : Object.freeze(unique ? (Object.isFrozen(rows) ? rows : [...rows]) : dedupe(rows));
  s.key = key;
  s.box = { held: null };
  return Object.freeze(s) as unknown as Selection<Row>;
}

/** Rows without repeats, first place kept. */
function dedupe(rows: readonly number[]): number[] {
  if (rows.length < 2) return [...rows];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const r of rows) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

/**
 * @internal The row a member — a view, or a value that names a row — is
 * in `d`: a row of this state, or of another state of the same geometry
 * found by identity; -1 when it is gone, or names no row here. A view of
 * an unrelated geometry is refused by name, as a selection of one is. The
 * one door `rows` and every write's list of members resolve a member
 * through.
 */
export function memberRow<Row>(d: Domain<Row>, r: unknown, who: string): number {
  const row = d.rowOf(r, who);
  if (row >= 0 || typeof r !== 'object' || r === null || viewKind(r) === undefined) return row;
  // Not here: gone, or of an unrelated geometry. It is asked the way a
  // selection of it is, which tells the two apart: its own domain — a
  // geometry's, or the collection's that holds it — reads it as its row.
  const owner = ownerOf(r) as Record<string, unknown> | undefined;
  if (owner === undefined || owner === d.source) return -1;
  const sel = owner[d.kind.plural];
  const theirs = sel instanceof Selection ? sel.domain : (owner.domain as Domain<unknown> | undefined);
  if (theirs === undefined || theirs.kind?.name !== d.kind.name || theirs === d) return -1;
  const at = theirs.rowOf(r, who);
  if (at >= 0) rowsIn(d, select(theirs, [at], undefined, true), who);
  return -1;
}

/** @internal The rows of `domain` another selection holds, in its order:
 * by position in the same state, by identity in another. */
export function rowsIn<Row>(domain: Domain<Row>, other: Selection<any>, who: string): readonly number[] {
  return other.domain === domain ? other.indices : domain.resolve(other, who);
}

/**
 * @internal A selection read on another state by identity: the rows that
 * are gone are dropped, the order and the key are kept. `state` is the
 * geometry that holds the rows, or a selection of it. What a write does
 * with a selection of an earlier state. Not a word of the selection: a
 * sketch says the same with a set operation on the later state
 * (`later.points.intersect(sel)`).
 */
export function selectionIn<S extends Selection<any>>(sel: S, state: unknown): S {
  const d = sel.domain;
  const who = `${d.kind.plural}: read on another state`;
  // A selection of the target state: the rows found there, among its members.
  let among: Selection<any> | null = null;
  let target: Domain<any>;
  if (state instanceof Selection) {
    if (state.domain.kind.name !== d.kind.name) throw new Error(`${who}: expected ${d.kind.plural}, got ${state.domain.kind.plural}`);
    among = state;
    target = state.domain;
  } else {
    target = d.on(state, who);
  }
  if (target === d && among === null) return sel;
  let rows = target === d ? [...sel.indices] : target.resolve(sel, who);
  if (among !== null) rows = rows.filter((r) => among!.holds(r));
  return select(target, rows, sel.key, true) as S;
}

/** Is `v` a selection of this kind? The one class plus the domain. */
export function isSelectionOf<Row = any>(v: unknown, kind: DomainKind): v is Selection<Row> {
  return v instanceof Selection && v.domain.kind === kind;
}

/** @internal The rows `0 … n − 1`, frozen: a dense domain's `all()`. */
export function rowRange(n: number): readonly number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return Object.freeze(out);
}

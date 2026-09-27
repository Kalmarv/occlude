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
 * gone is left out. It does not apply the rule that made it again. Who a
 * row is, is the domain's to say (`keyOf`, `rowOfKey`); finding it, and
 * refusing a selection or a view of an unrelated geometry, is written once
 * here (`rowOf`, `memberRow`, `resolve`).
 */

import type { XY } from './vec.js';
import { describe } from './views.js';
import { groupRows } from './groupRows.js';
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
 * it belongs to (`owner`, internal), and the words a kind brings. A row
 * type declares its own with
 * `Types<{ … }>` under `ROW_TYPES`; a word it leaves out is absent —
 * `undefined` for a protocol word, `never` for a kind word, so a call a
 * domain cannot answer does not compile, and refuses by name at run time.
 */
export interface DomainTypes {
  owner: unknown;
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
  kind: unknown;
  except: unknown;
}
/** Every word absent. */
interface Absent extends DomainTypes {
  owner: object;
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
  kind: never;
  except: never;
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
  /** A refusal's own words, by the word refused: why this kind has none.
   * `unrelated` is what this kind says of a row or a selection of a state
   * that shares no identity with this one. */
  readonly refusals: Readonly<Record<string, string>>;
}

/**
 * The rows of one kind in one state, and what a selection needs to know
 * about them. Made once per state and kept there, so two selections of the
 * same state share it and `a.domain === b.domain` is "the same rows".
 */
export interface Domain<Row = unknown> {
  readonly kind: DomainKind;
  /** The state the rows belong to: a material, a lattice, … */
  readonly owner: object;
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
  /** Who row `r` is: a key the same row answers in every state of one
   * evolution, and no other row ever does (an id, a set of wall ids). */
  keyOf(r: number): unknown;
  /** The row whose key is `key` in this state, or -1 when it is gone. */
  rowOfKey(key: unknown): number;
  /**
   * Where a single member lives: a view's own domain and row, or — for a
   * value the domain takes as a name (`point(…)`, `edge(…)`) — its key;
   * null for nothing. Anything else is the wrong program, refused by name.
   */
  locate(value: unknown, who: string): { readonly domain: Domain<Row>; readonly row: number } | { readonly key: unknown } | null;
  /** Do this state and the other state of this kind share any identity —
   * are they states of one evolution? */
  shares(other: Domain<Row>): boolean;
  /** The row a pass over `count` rows hands to a function (default `row`):
   * a kind may read many rows faster than one at a time. */
  reader?(count: number): (row: number) => Row;
  /** The rows a `where` that is not a member names, for a kind that takes
   * one (a lattice: the faces points fall in); undefined for a value the
   * kind does not take. */
  named?(where: unknown, who: string): readonly number[] | undefined;
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
  /** @internal What a selection works out about itself, once: its
   * membership set, the curves its members walk — kept in a box so the
   * selection is frozen. */
  declare readonly box: { held: Set<number> | null; curves?: unknown };

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

  /** @internal The state the rows belong to. A sketch holds it already:
   * it read the selection from it. */
  get owner(): RowTypes<Row>['owner'] {
    return (isInstance(this) ? this.domain.owner : undefined) as RowTypes<Row>['owner'];
  }

  /** A selection has no `source`: each ROW says where it came from
   * (`p.source`), and the value a selection is of is the one it was read
   * from. Refused by name. */
  get source(): never {
    if (!isInstance(this)) return undefined as never;
    throw new Error(`${this.domain.kind.plural}.source: a selection has no source — each row says where it came from (${this.domain.kind.name === 'point' ? 'p' : this.domain.kind.name === 'edge' ? 'e' : 'row'}.source), and the value it is a selection of is the one you read it from`);
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
    const d = this.domain;
    return groupRows(this.indices, (r) => r, (r, k) => classify(d.row(r), k)).map(({ key, rows }) => select(d, rows, key, true) as Keyed<Selection<Row>, K>);
  }

  /** True when `row` is a member. A row of another state of the same
   * evolution is asked about by identity; one that is gone is not a
   * member. A row of another kind is refused by name. */
  has(row: Row | object): boolean {
    const r = rowOf(this.domain, row, `${this.domain.kind.plural}.has`);
    return r >= 0 && this.holds(r);
  }

  /** The selection holding those rows of the state: the rows themselves —
   * views, or values that name rows — one, a list or a selection, in the
   * order given. The door for a relation a sketch worked out for itself. A
   * row of another state is found by identity; one that is gone is
   * skipped, as every set operation skips it, and a row of an unrelated
   * geometry is refused by name. A row is never named by its number. */
  rows(rows: Row | Iterable<Row> | Selection<any>): Selection<Row> {
    const d = this.domain;
    const who = `${d.kind.plural}.rows`;
    if (rows instanceof Selection) return select(d, this.operand(rows, who), undefined, true);
    if (typeof rows !== 'object' || rows === null) throw new Error(`${who}: expected ${article(d.kind.name)} row, or a list of them — got ${describe(rows)}`);
    // A list of rows, or one row (a row is not iterable).
    if (typeof (rows as Iterable<unknown>)[Symbol.iterator] === 'function') return select(d, memberRows(d, Array.from(rows as Iterable<unknown>), who));
    const r = memberRow(d, rows, who);
    return select(d, r < 0 ? [] : [r], undefined, true);
  }

  /** @internal The selection of rows `rows` of this state, by number, in
   * the order given, a repeat kept once: the engine's door, for a kernel
   * that worked out rows. A sketch names rows by the rows (`rows`). */
  rowsAt(rows: Iterable<number>): Selection<Row> {
    const d = this.domain;
    const list = Array.from(rows);
    for (const r of list) if (!d.valid(r)) throw new Error(`${d.kind.plural}.rowsAt: no ${d.kind.name} ${r} in this state (${d.size} rows)`);
    return select(d, list);
  }

  /** @internal The rows another selection names here, in its order; `who`
   * names the word asking in a refusal. A selection of another kind is
   * refused by name, with the word that reads this kind off it when it
   * has one. */
  operand(other: unknown, who: string): readonly number[] {
    const d = this.domain;
    const one = article(d.kind.name);
    if (!(other instanceof Selection)) throw new Error(`${who}: ${one} selection combines only with ${one} selection — got ${describe(other)}`);
    if (other.domain !== d && other.domain.kind.name !== d.kind.name) {
      const word = d.kind.plural;
      const hint = (other as unknown as Record<string, unknown>)[word] instanceof Selection ? `; its ${word} are sel.${word}` : '';
      throw new Error(`${who}: ${one} selection combines only with ${one} selection — got ${describe(other)}${hint}`);
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
      for (const r of this.operand(other, `${this.domain.kind.plural}.union`)) {
        if (seen.has(r)) continue;
        seen.add(r);
        out.push(r);
      }
    }
    return select(this.domain, out, this.key, true) as S;
  }

  /** The members the other selection also holds, in this order. */
  intersect<S extends Selection<Row>>(this: S, other: Selection<any>): S {
    const theirs = new Set(this.operand(other, `${this.domain.kind.plural}.intersect`));
    return select(this.domain, this.indices.filter((r) => theirs.has(r)), this.key, true) as S;
  }

  /** The members that `other` does not name — a selection, or one row or
   * value the domain takes as a name, of this state or an earlier one — in
   * this order. Nothing takes nothing away. */
  without<S extends Selection<Row>>(this: S, other: Selection<any> | Row | object | undefined): S {
    if (other === undefined || other === null) return this;
    let gone: Set<number>;
    if (other instanceof Selection) gone = new Set(this.operand(other, `${this.domain.kind.plural}.without`));
    else {
      const r = rowOf(this.domain, other, `${this.domain.kind.plural}.without`);
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
  /** Projected lines: the members of any of these kinds. */
  kind: RowTypes<Row>['kind'];
  /** Projected lines: the members of none of these kinds. */
  except: RowTypes<Row>['except'];
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
for (const word of ['nearest', 'firstHit', 'crossing', 'boundaryEdges', 'measure', 'thicken', 'resample', 'trim', 'spline', 'oscillate', 'along', 'kind', 'except', 'set', 'add', 'remove', 'extract']) {
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
  const s = Object.create(domain.kind.proto) as { domain: Domain<Row>; members: readonly number[] | null; key: unknown; box: { held: Set<number> | null; curves?: unknown } };
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

// ---- finding rows by identity: written once, for every domain ----------------------

/**
 * @internal The row a single member names in `d` — a view of this state,
 * a view of another state of the same evolution found by who it is, or a
 * value the domain takes as a name — or -1 when it names none here: it is
 * gone, or a row of an unrelated geometry, which names nothing here. A
 * member of another kind is refused by name. What `has` and `without` ask.
 * A view's own identity answers first, so asking about a row of another
 * state costs one lookup.
 */
export function rowOf<Row>(d: Domain<Row>, v: unknown, who: string): number {
  const at = d.locate(v, who);
  if (at === null) return -1;
  if (!('domain' in at)) return d.rowOfKey(at.key);
  if (at.domain === d) return at.row;
  if (otherRun(d.owner, at.domain.owner)) return -1;
  return d.rowOfKey(at.domain.keyOf(at.row));
}

/** Two states of different runs: both count their ids from the same
 * place, so no key of one names a row of the other (material.ts
 * `mintIds`). A state with no run — a lattice, a value made outside any
 * run — is of none. */
function otherRun(a: unknown, b: unknown): boolean {
  const x = (a as { epoch?: number }).epoch ?? 0;
  const y = (b as { epoch?: number }).epoch ?? 0;
  return x !== y && x !== 0 && y !== 0;
}

/**
 * @internal `rowOf` for a member a sketch names a row with — a `where`, a
 * list, `rows` — where a view of an unrelated geometry is the wrong
 * program: refused by name, as a selection of one is. A gone row is -1.
 */
export function memberRow<Row>(d: Domain<Row>, v: unknown, who: string): number {
  const at = d.locate(v, who);
  if (at === null) return -1;
  if (!('domain' in at)) return d.rowOfKey(at.key);
  if (at.domain === d) return at.row;
  if (otherRun(d.owner, at.domain.owner)) throw unrelated(d.kind, who, 'row');
  const r = d.rowOfKey(at.domain.keyOf(at.row));
  if (r < 0 && !d.shares(at.domain)) throw unrelated(d.kind, who, 'row');
  return r;
}

/** @internal The rows a list of members names (`memberRow`, each), each
 * once, in the order given; nothing and a gone row are skipped. */
export function memberRows<Row>(d: Domain<Row>, list: readonly unknown[], who: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of list) {
    const r = memberRow(d, v, who);
    if (r >= 0 && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

/**
 * @internal The rows of `d` another selection of its kind holds, in its
 * order, found by who each is; the ones that are gone are left out. A
 * selection of another kind, or of a state that shares nothing with this
 * one, is refused by name.
 */
export function resolve<Row>(d: Domain<Row>, other: Selection<any>, who: string): number[] {
  const theirs = other.domain;
  if (theirs.kind !== d.kind) throw new Error(`${who}: expected ${d.kind.plural} — ${article(d.kind.name)} selection — got ${theirs.kind.plural}`);
  if (theirs !== d && (otherRun(d.owner, theirs.owner) || !d.shares(theirs))) throw unrelated(d.kind, who, 'selection');
  const out: number[] = [];
  for (const r of other.indices) {
    const k = theirs === d ? r : d.rowOfKey(theirs.keyOf(r));
    if (k >= 0) out.push(k);
  }
  return out;
}

/** @internal The rows of `domain` another selection holds, in its order:
 * by position in the same domain, by identity in another. */
export function rowsIn<Row>(domain: Domain<Row>, other: Selection<any>, who: string): readonly number[] {
  return other.domain === domain ? other.indices : resolve(domain, other, who);
}

/** @internal The refusal a row (`'row'`) or a selection of a state that
 * shares no identity with this one gets: the kind's own words, or the
 * material's. */
export function unrelated(kind: DomainKind, who: string, what: 'row' | 'selection'): Error {
  const own = kind.refusals.unrelated;
  if (own !== undefined) return new Error(`${who}: ${own}`);
  const which = what === 'row' ? `that ${kind.name} is a row of an unrelated material` : 'the two selections come from unrelated materials';
  return new Error(`${who}: ${which} — nothing in one is anything in the other. Rows of one evolution resolve by identity; to combine two materials, append() them first`);
}

/**
 * @internal The rows a write's `where` names among the members of `sel`,
 * in the members' order — the order `intersect` keeps. A function picks
 * members by their rows, in that order; a selection names its rows by
 * identity; a row, a value that names one, or a list of them, name theirs,
 * a view of an unrelated geometry refused; a kind may take something else
 * as a name (`Domain.named`: the points a lattice face lies under).
 * Nothing names nothing.
 */
export function whereRows<Row>(sel: Selection<Row>, where: unknown, who: string): readonly number[] {
  const d = sel.domain;
  if (where === undefined || where === null) return [];
  const n = sel.length;
  if (typeof where === 'function') {
    const pick = where as (row: Row) => unknown;
    const read = d.reader?.(n) ?? ((r: number) => d.row(r));
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const r = sel.rowAt(k);
      if (pick(read(r))) out.push(r);
    }
    return out;
  }
  let named: readonly number[] | undefined;
  if (where instanceof Selection && where.domain.kind === d.kind) named = rowsIn(d, where, who);
  else named = d.named?.(where, who);
  if (named === undefined) {
    if (where instanceof Selection) named = sel.operand(where, who);
    else if (Array.isArray(where)) named = memberRows(d, where, who);
    else {
      const r = memberRow(d, where, who);
      named = r < 0 ? [] : [r];
    }
  }
  if (sel.members === null) return [...named].sort((a, b) => a - b);
  const held = new Set(named);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const r = sel.rowAt(k);
    if (held.has(r)) out.push(r);
  }
  return out;
}

/**
 * @internal A selection read on another state by identity: the rows that
 * are gone are dropped, the order and the key are kept. `state` is the
 * geometry that holds the rows — its rows of this kind are what it answers
 * for the kind's word (`points`, `edges`, `faces`, …) — or a selection of
 * it. What a write does with a selection of an earlier state. Not a word
 * of the selection: a sketch says the same with a set operation on the
 * later state (`later.points.intersect(sel)`).
 */
export function selectionIn<S extends Selection<any>>(sel: S, state: unknown): S {
  const d = sel.domain;
  const who = `${d.kind.plural}: read on another state`;
  // A selection of the target state: the rows found there, among its members.
  const among = state instanceof Selection ? state : (typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[d.kind.plural] : undefined);
  if (!(among instanceof Selection)) throw new Error(`${who}: expected a geometry with ${d.kind.plural}, or a selection of them — got ${describe(state)}`);
  if (among.domain.kind.name !== d.kind.name) throw new Error(`${who}: expected ${d.kind.plural}, got ${among.domain.kind.plural}`);
  const target = among.domain;
  if (target === d && (among.members === null || among === sel)) return sel;
  let rows: readonly number[] = target === d ? sel.indices : resolve(target, sel, who);
  if (among.members !== null) rows = rows.filter((r) => among.holds(r));
  return select(target, rows, sel.key, true) as S;
}

/** Is `v` a selection of this kind? The one class plus the domain. */
export function isSelectionOf<Row = any>(v: unknown, kind: DomainKind): v is Selection<Row> {
  return v instanceof Selection && v.domain.kind === kind;
}

/** "a point", "an edge": a kind's name with its article. */
const article = (word: string): string => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

/**
 * @internal A `near` radius, checked once for every domain: a positive
 * length. `Infinity` is a radius — every row is nearer than it — and so is
 * any finite length above 0. NaN is degenerate input, a transient of a
 * sketch being edited: it answers 0, and a radius of 0 holds no row. A
 * negative number, 0 given as such, and anything that is not a number are
 * refused by name.
 */
export function checkRadius(radius: unknown, who: string): number {
  if (typeof radius === 'number' && Number.isNaN(radius)) return 0;
  if (typeof radius !== 'number' || !(radius > 0)) throw new Error(`${who}: radius is a positive length — got ${describe(radius)}`);
  return radius;
}

/** @internal Rows once each, ascending. */
export const rowOrder = (rows: Iterable<number>): number[] => [...new Set(rows)].sort((a, b) => a - b);

/** @internal The rows `0 … n − 1`, frozen: a dense domain's `all()`. */
export function rowRange(n: number): readonly number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return Object.freeze(out);
}

/**
 * The conservative memo: a derivation that ran before, on the same inputs,
 * in the same frame, at the same place in the run's identities, answers the
 * value it answered then.
 *
 * WHAT IS MEMOISED. A call is memoised only when every rule below holds;
 * when one does not, the call runs as it always did (model-dependency.md,
 * ruling 1: recompute when in doubt).
 *
 * - The operation is on the allow-list (`MEMO_OPS`): pure data operations
 *   of the toolkit. None of them opens a seeded stream, records a probe or
 *   an inspection, or records a shape.
 * - Every argument hashes (`keyHash`). A function anywhere in the arguments
 *   — a field, a pass, a predicate, a fill with a field in it — does not,
 *   so an operation handed a closure is never memoised. Nor does an
 *   instance of a class the memo does not know, a symbol, an accessor or a
 *   cycle.
 * - The call does not draw. A call that takes a seeded draw, opens a
 *   stream, or records a probe while it computes (`Execution.effects`
 *   moved) is not stored, and its operation is never memoised again by
 *   that store: skipping it on a later run would move every later draw
 *   (ruling 4: draws stay in call order). The allow-list says what should
 *   hold; this says what did.
 *
 * THE KEY. The operation, the frame (paper, margin, aspect, origin, the
 * axis, rect mode, and the sketch's `space` and `projection` as it wrote
 * them — everything the toolkit's lowering reads), the place in the run's
 * identities (see IDS), and the arguments:
 *
 * - numbers (by their bits, so `-0` is not `0`), strings, booleans, null,
 *   undefined, arrays, typed arrays, `Len`, and plain records (in their key
 *   order, which some consumers read as column order) by value — so a
 *   shape tree, `{ geom, opts }` all the way down, hashes by its data;
 * - a geometry value (a `Material`, a `Selection`) by its IDENTITY. Every
 *   derivation keeps its inputs (its node record, its `source` relation,
 *   the row views a `source` answers), so a value computed from an equal
 *   but different object would answer rows of the old object where a cold
 *   run answers rows of the new one: `f.source === site` would stop
 *   holding. The chain still carries across runs, because a hit answers
 *   the same object and the next call sees the same input. Content hashes
 *   of geometry (`contentHash`) are what a later early cutoff needs, with a
 *   rebind of the kept inputs; here they prove hits (`verify`).
 *
 * IDS. Every vertex and edge is minted an id from the run's counter
 * (material.ts). A cold computation mints `k` ids starting where the
 * counter stands, so a cached value's ids are right only where the counter
 * stands where it stood: the counter is part of the key. Reading it takes
 * one id (the call's own), and a second one after the call measures `k`;
 * a hit then takes the `k + 1` ids the computation and the second read
 * would have taken. A hit and a miss leave the counter in the same place,
 * so every later id — and every later key — is the one a cold run has.
 *
 * WHERE IT LIVES. A `MemoStore` belongs to the host: the studio's render
 * worker keeps one across runs, a tool keeps one across renders. An
 * `Execution` made with `{ memo }` reads through it; one made without runs
 * as it always did, and `memoised` hands its toolkit back untouched.
 *
 * A hit answers the very object a cold call answered earlier, so the lazy
 * caches it keeps — its faces, curves, adjacency, a level set's area —
 * come along for free.
 */

import { Material, mintIds } from './material.js';
import { Selection } from './selection.js';
import { Len } from './units.js';
import type { Execution } from './execution.js';

// ---- hashing ----

const C1 = 0x239b961b;
const C2 = 0xab0e9789;
const C3 = 0x38b34ae5;
const C4 = 0xa1e38b93;

const rotl = (x: number, r: number): number => (x << r) | (x >>> (32 - r));

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

const F64 = new Float64Array(1);
const F64_WORDS = new Uint32Array(F64.buffer);

/**
 * A streaming 128-bit hash of 32-bit words: the block and finalisation
 * steps of MurmurHash3 x86_128, fed word by word. Not a cryptographic
 * hash; 128 bits make an accidental collision between two keys of one
 * store negligible.
 */
class Hasher {
  private h1 = 0x9747b28c;
  private h2 = 0x9747b28c;
  private h3 = 0x9747b28c;
  private h4 = 0x9747b28c;
  private readonly block = new Uint32Array(4);
  private fill = 0;
  private words = 0;

  word(w: number): void {
    this.block[this.fill++] = w;
    this.words++;
    if (this.fill === 4) this.mix();
  }

  private mix(): void {
    let [k1, k2, k3, k4] = this.block;
    k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2);
    this.h1 ^= k1;
    this.h1 = rotl(this.h1, 19) + this.h2;
    this.h1 = (Math.imul(this.h1, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3);
    this.h2 ^= k2;
    this.h2 = rotl(this.h2, 17) + this.h3;
    this.h2 = (Math.imul(this.h2, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4);
    this.h3 ^= k3;
    this.h3 = rotl(this.h3, 15) + this.h4;
    this.h3 = (Math.imul(this.h3, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1);
    this.h4 ^= k4;
    this.h4 = rotl(this.h4, 13) + this.h1;
    this.h4 = (Math.imul(this.h4, 5) + 0x32ac3b17) | 0;
    this.fill = 0;
  }

  num(v: number): void {
    F64[0] = v;
    this.word(F64_WORDS[0]);
    this.word(F64_WORDS[1]);
  }

  str(s: string): void {
    this.word(s.length);
    for (let i = 0; i < s.length; i += 2) this.word(s.charCodeAt(i) | ((i + 1 < s.length ? s.charCodeAt(i + 1) : 0) << 16));
  }

  bytes(view: ArrayBufferView): void {
    this.word(view.byteLength);
    if (view.byteOffset % 4 === 0 && view.byteLength % 4 === 0) {
      const words = new Uint32Array(view.buffer, view.byteOffset, view.byteLength / 4);
      for (let i = 0; i < words.length; i++) this.word(words[i]);
      return;
    }
    const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = 0; i < b.length; i++) this.word(b[i]);
  }

  digest(): string {
    while (this.fill !== 0) this.word(0);
    let { h1, h2, h3, h4 } = this;
    const n = this.words;
    h1 ^= n; h2 ^= n; h3 ^= n; h4 ^= n;
    h1 = (h1 + h2 + h3 + h4) | 0;
    h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
    h1 = fmix(h1); h2 = fmix(h2); h3 = fmix(h3); h4 = fmix(h4);
    h1 = (h1 + h2 + h3 + h4) | 0;
    h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
    const hex = (x: number): string => (x >>> 0).toString(16).padStart(8, '0');
    return hex(h1) + hex(h2) + hex(h3) + hex(h4);
  }
}

/** Type tags: two values of different kinds never feed the same words. */
const Tag = {
  Undefined: 1, Null: 2, False: 3, True: 4, Number: 5, String: 6, BigInt: 7,
  Array: 8, Typed: 9, Len: 10, Record: 11, Identity: 12, Material: 13, Selection: 14,
} as const;

/** A geometry value's identity in a key: a number per object, never reused. */
const tokens = new WeakMap<object, number>();
let nextToken = 1;
function tokenOf(v: object): number {
  let t = tokens.get(v);
  if (t === undefined) {
    t = nextToken++;
    tokens.set(v, t);
  }
  return t;
}

/** Thrown inside the walk when a value has no hash; caught at the door. */
const UNHASHABLE: unique symbol = Symbol('unhashable');

type Mode = 'key' | 'content';

function walk(h: Hasher, v: unknown, mode: Mode, open: Set<object>): void {
  switch (typeof v) {
    case 'undefined': h.word(Tag.Undefined); return;
    case 'boolean': h.word(v ? Tag.True : Tag.False); return;
    case 'number': h.word(Tag.Number); h.num(v); return;
    case 'string': h.word(Tag.String); h.str(v); return;
    case 'bigint': h.word(Tag.BigInt); h.str(v.toString()); return;
    case 'function':
    case 'symbol':
      throw UNHASHABLE;
  }
  if (v === null) { h.word(Tag.Null); return; }
  const o = v as object;
  if (open.has(o)) throw UNHASHABLE;
  if (ArrayBuffer.isView(o)) {
    h.word(Tag.Typed);
    h.str(o.constructor.name);
    h.bytes(o);
    return;
  }
  if (o instanceof Len) {
    h.word(Tag.Len);
    h.str(o.kind);
    h.num(o.value);
    return;
  }
  if (o instanceof Material || o instanceof Selection) {
    if (mode === 'key') {
      h.word(Tag.Identity);
      h.num(tokenOf(o));
    } else if (o instanceof Material) {
      h.word(Tag.Material);
      materialContent(h, o, open);
    } else {
      // A selection's content is which rows of which state: the state by
      // identity (a selection answers that state's own rows), the rows by
      // number.
      const sel = o as Selection<unknown>;
      h.word(Tag.Selection);
      h.num(tokenOf(sel.source as object));
      h.str(sel.domain.kind.name);
      const rows = sel.indices;
      h.word(rows.length);
      for (let i = 0; i < rows.length; i++) h.word(rows[i]);
    }
    return;
  }
  open.add(o);
  if (Array.isArray(o)) {
    h.word(Tag.Array);
    h.word(o.length);
    for (let i = 0; i < o.length; i++) walk(h, o[i], mode, open);
  } else {
    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) throw UNHASHABLE;
    h.word(Tag.Record);
    const keys = Reflect.ownKeys(o);
    h.word(keys.length);
    for (const key of keys) {
      if (typeof key === 'symbol') throw UNHASHABLE;
      const d = Object.getOwnPropertyDescriptor(o, key)!;
      // A getter could answer anything; a hidden property is still read by
      // whoever hid it. Neither is data the key can see.
      if (!('value' in d) || !d.enumerable) throw UNHASHABLE;
      h.str(key);
      walk(h, d.value, mode, open);
    }
  }
  open.delete(o);
}

/**
 * A material's content: its rows, columns, edges and ids through the flat
 * names, its per-column policies, its step count and its space's kind.
 *
 * With persistent columns (column.ts) this is where per-LEAF hashes plug
 * in: hash each leaf of `m.store.<column>.leaves()` once, keep the hash in
 * a WeakMap keyed by the leaf (a leaf is never written once a column holds
 * it), and feed the leaf hashes here instead of the numbers — a state that
 * shares all but one leaf with its parent then costs one leaf to hash.
 */
function materialContent(h: Hasher, m: Material, open: Set<object>): void {
  h.word(m.n);
  h.word(m.edgeCount);
  h.word(m.iteration);
  h.bytes(m.x);
  h.bytes(m.y);
  h.bytes(m.pointIds);
  h.bytes(m.edgeList);
  h.bytes(m.edgeIds);
  h.bytes(m.edgeRoots);
  const attrs = m.attrs;
  const names = Object.keys(attrs);
  h.word(names.length);
  for (const name of names) { h.str(name); h.bytes(attrs[name]); }
  const edgeAttrs = m.edgeAttrs;
  const edgeNames = Object.keys(edgeAttrs);
  h.word(edgeNames.length);
  for (const name of edgeNames) { h.str(name); h.bytes(edgeAttrs[name]); }
  walk(h, m.transfers, 'content', open);
  walk(h, m.edgeTransfers, 'content', open);
  const faceNames = Object.keys(m.faceAttrs);
  h.word(faceNames.length);
  for (const name of faceNames) {
    h.str(name);
    const values = [...m.faceAttrs[name].values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    h.word(values.length);
    for (const [k, x] of values) { h.str(k); h.num(x); }
  }
  h.str(m.space?.kind ?? 'none');
  h.num(m.space?.curvature ?? 0);
}

function hashOf(v: unknown, mode: Mode): string | undefined {
  const h = new Hasher();
  try {
    walk(h, v, mode, new Set());
  } catch (e) {
    if (e === UNHASHABLE) return undefined;
    throw e;
  }
  return h.digest();
}

/**
 * A value's part of a memo key: data by value, a geometry value by its
 * identity. `undefined` when the value cannot be keyed — a function
 * anywhere in it, an unknown class, a symbol, an accessor, a cycle — and
 * the call that took it is then never memoised.
 */
export function keyHash(v: unknown): string | undefined {
  return hashOf(v, 'key');
}

/**
 * A value's content: data by value, a material by its columns (see
 * `materialContent`). Two materials with equal content hashes have the
 * same rows, columns, edges and ids. `undefined` when the value has none
 * the memo can read.
 */
export function contentHash(v: unknown): string | undefined {
  return hashOf(v, 'content');
}

// ---- the store ----

/** One remembered call: what it answered, how many ids it minted, what it
 * cost, and what it holds. */
interface Entry {
  readonly value: unknown;
  readonly minted: number;
  readonly ms: number;
  readonly bytes: number;
  readonly content?: string;
}

export interface MemoStats {
  /** Calls answered from the store. */
  hits: number;
  /** Calls computed and stored. */
  misses: number;
  /** Calls that could not be keyed (a closure or an unknown value in the
   * arguments): computed, never stored. */
  unkeyed: number;
  /** Calls that drew, or whose operation drew before: computed, never
   * stored. */
  refused: number;
  /** Entries dropped to stay inside the byte budget. */
  evicted: number;
  /** The compute time the hits did not spend (each hit's recorded cost). */
  savedMs: number;
  /** The compute time the misses spent. */
  computedMs: number;
}

export interface MemoOptions {
  /** The budget, in bytes, of what the store holds (an estimate: the
   * columns of the values and the keys). Least recently used entries go
   * first. Default 128 MB. */
  maxBytes?: number;
  /** Recompute every hit and check it is the value the store holds: equal
   * content, the same number of ids minted. A proof mode: it saves no
   * time, and a mismatch throws. */
  verify?: boolean;
}

/**
 * The memo a host owns: entries by key, least recently used first, bounded
 * by bytes. It outlives any run; nothing in it names a run.
 */
export class MemoStore {
  readonly maxBytes: number;
  readonly verify: boolean;
  /** Insertion order is recency: a hit moves its entry to the end. */
  private readonly entries = new Map<string, Entry>();
  private held = 0;
  /** Operations seen drawing: never memoised again by this store. */
  readonly drew = new Set<string>();
  readonly stats: MemoStats = { hits: 0, misses: 0, unkeyed: 0, refused: 0, evicted: 0, savedMs: 0, computedMs: 0 };

  constructor(opts: MemoOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 128 * 1024 * 1024;
    this.verify = opts.verify === true;
  }

  /** How many entries, and the bytes they are estimated to hold. */
  get size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.held };
  }

  /** A copy of the counters, to take a difference across a run. */
  snapshot(): MemoStats {
    return { ...this.stats };
  }

  /** @internal The entry under `key`, now the most recently used. */
  get(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }

  /** @internal Keep `entry` under `key`, dropping the least recently used
   * entries until the budget holds it. An entry larger than the whole
   * budget is not kept. */
  set(key: string, entry: Entry): void {
    const old = this.entries.get(key);
    if (old) {
      this.held -= old.bytes;
      this.entries.delete(key);
    }
    if (entry.bytes > this.maxBytes) return;
    for (const [k, e] of this.entries) {
      if (this.held + entry.bytes <= this.maxBytes) break;
      this.entries.delete(k);
      this.held -= e.bytes;
      this.stats.evicted++;
    }
    this.entries.set(key, entry);
    this.held += entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.held = 0;
    this.drew.clear();
  }
}

/** What a value holds, in bytes, as the budget counts it: a material by
 * its columns, arrays and records by what they hold, anything else a flat
 * guess. The lazy caches a value grows later are not counted. */
function bytesOf(v: unknown, depth = 0): number {
  if (v instanceof Material) {
    const perPoint = 8 * (3 + v.attrNames.length);
    const perEdge = 8 + 8 * (2 + v.edgeAttrNames.length);
    return 512 + v.n * perPoint + v.edgeCount * perEdge;
  }
  if (typeof v !== 'object' || v === null) return 16;
  if (ArrayBuffer.isView(v)) return 64 + v.byteLength;
  if (depth > 4) return 256;
  if (Array.isArray(v)) {
    let sum = 64;
    for (const x of v) sum += bytesOf(x, depth + 1);
    return sum;
  }
  let sum = 64;
  for (const k of Object.keys(v)) sum += 16 + bytesOf((v as Record<string, unknown>)[k], depth + 1);
  return sum;
}

/** The frame a toolkit derivation reads, per run: everything `begin`
 * fixed that the lowering, the units and the space are made from. */
const frames = new WeakMap<Execution, string>();
function frameKey(exec: Execution): string {
  let k = frames.get(exec);
  if (k === undefined) {
    k = keyHash([
      exec.paper.w, exec.paper.h, exec.marginPct, exec.aspect, exec.origin, exec.yUp, exec.rectMode,
      exec.spaceConfig.space ?? null, exec.spaceConfig.projection ?? null,
    ]) ?? `unkeyed:${tokenOf(exec)}`;
    frames.set(exec, k);
  }
  return k;
}

/** The store each value a memoised call answered was answered under: the
 * door a method on that value (`memoMethod`) reads through. */
const homes = new WeakMap<object, MemoStore>();
function home(value: unknown, store: MemoStore): void {
  if (typeof value === 'object' && value !== null) homes.set(value, store);
}

const now = (): number => performance.now();

/**
 * One call through the memo: `compute` runs unless `store` holds the
 * answer under this key. `frame` is the frame key of a toolkit call, or ''
 * for a call that reads no frame (a method of a value); `exec` watches for
 * draws, when there is a run to watch.
 */
function through<T>(store: MemoStore, op: string, frame: string, args: readonly unknown[], compute: () => T, exec?: Execution): T {
  const argKey = keyHash(args);
  if (argKey === undefined) {
    store.stats.unkeyed++;
    return compute();
  }
  // The call's own id: where the counter stands (see IDS).
  const at = mintIds(1)[0];
  if (store.drew.has(op)) {
    // Refused as the call that found it drawing was: it takes the same two
    // ids, so the counter does not depend on what the store has seen.
    const value = compute();
    mintIds(1);
    store.stats.refused++;
    return value;
  }
  const key = `${op}|${frame}|${at}|${argKey}`;
  const hit = store.get(key);
  if (hit !== undefined && !store.verify) {
    mintIds(hit.minted + 1);
    store.stats.hits++;
    store.stats.savedMs += hit.ms;
    home(hit.value, store);
    return hit.value as T;
  }
  const effects = exec?.effects ?? 0;
  const t0 = now();
  const value = compute();
  const ms = now() - t0;
  const minted = mintIds(1)[0] - at - 1;
  if (exec !== undefined && exec.effects !== effects) {
    store.drew.add(op);
    store.stats.refused++;
    return value;
  }
  if (hit !== undefined) {
    // Verify: the recomputation must be the stored value, id for id.
    const content = contentHash(value);
    if (minted !== hit.minted || content !== hit.content) {
      throw new Error(`memo: ${op} answered a different value on a hit (${hit.minted} ids and ${hit.content} stored, ${minted} ids and ${content} now)`);
    }
    store.stats.hits++;
    home(hit.value, store);
    return hit.value as T;
  }
  store.set(key, { value, minted, ms, bytes: bytesOf(value) + 2 * key.length, content: store.verify ? contentHash(value) : undefined });
  store.stats.misses++;
  store.stats.computedMs += ms;
  home(value, store);
  return value;
}

/**
 * The toolkit's pure data operations: none draws, records, or reads
 * anything but its arguments, the frame and the run's id counter.
 *
 * - `material`: lowers areas through the frame; a material comes back as
 *   itself, a face as its walls.
 * - `sample`: lowers a shape and samples it by arc length; a material is
 *   `resample`d. (A 3D curve set is a class instance: never keyed.)
 * - `grid`, `text`, `tiling`: build geometry from their options and the
 *   drawable.
 * - `voronoi`, `quadtree`: cells of their input points in the drawable or a
 *   `within` area.
 * - `spacefill`: folds a line through an area; a `field` makes it unkeyed.
 * - `relax`: Lloyd rounds; it opens its stream only to draw, and it never
 *   draws (points.ts `relaxMaterial`). A `density` makes it unkeyed. Its
 *   bounding area rides on the input's identity, which the key holds.
 * - `within`: a material cut at an area, a selection filtered by one; a
 *   field (a closure) makes it unkeyed.
 *
 * Not here: every word that draws (`scatter`, `throw`, `settle`, `pick`,
 * `rnd`, `steps` …), every word whose input is a field (`isolines`,
 * `ridges`, `streamlines`, `travelTime`, `distanceTo`, `lattice` with an
 * `init`, `residual`), words that record (`probe`, `plan`, `draw`), and
 * words too cheap to key (`bounds`, `len`, `placement`, `symmetry`).
 */
export const MEMO_OPS = ['material', 'sample', 'grid', 'text', 'tiling', 'voronoi', 'quadtree', 'spacefill', 'relax', 'within'] as const;

const wrapped = new WeakSet<object>();

/**
 * The toolkit with its pure data operations read through the run's memo:
 * each `MEMO_OPS` member, when the execution was made with `{ memo }`. An
 * execution without one gets its toolkit back as it was. Idempotent.
 */
export function memoised<T extends object>(toolkit: T, exec: Execution): T {
  const store = exec.memo;
  if (store === undefined || wrapped.has(toolkit)) return toolkit;
  wrapped.add(toolkit);
  const tk = toolkit as Record<string, unknown>;
  for (const op of MEMO_OPS) {
    const fn = tk[op];
    if (typeof fn !== 'function') continue;
    const name = `t.${op}`;
    tk[op] = (...args: unknown[]) => through(store, name, frameKey(exec), args, () => (fn as (...a: unknown[]) => unknown)(...args), exec);
  }
  return toolkit;
}

/**
 * A method of a geometry value through the memo, when the value came from
 * a memoised call (or from a method read this way): `self` is keyed by its
 * identity and the result is answered from the store the value came from.
 * A value that came from nowhere memoised computes as it always did. A
 * method reads no frame and cannot draw, so the frame is not in the key;
 * a closure in `args` leaves the call unkeyed.
 *
 * The door for `m.planarize()`, `m.thicken(…)`, `m.resample(…)` and the
 * other pure material verbs: `return memoMethod(this, 'planarize', [], () =>
 * …)` in the method body.
 */
export function memoMethod<T>(self: object, op: string, args: readonly unknown[], compute: () => T): T {
  const store = homes.get(self);
  if (store === undefined) return compute();
  return through(store, `.${op}`, '', [self, ...args], compute);
}

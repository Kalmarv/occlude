/**
 * @internal Derivations: what a derived value keeps of how it was made.
 *
 * A derivation is a word whose result keeps its inputs and its rule, and
 * answers the correspondence from its rows back to the input's rows as
 * ordinary row words (`p.source`, `p.u`). Nothing here is a public word:
 * a sketch reads `source` and `u` on a row and never sees a record, an id
 * or a link (ruling 2: ids are internal; a value you hold is the name).
 *
 * Two records, kept apart because they live on different things.
 *
 * 1. The NODE — on the value a derivation returned, and only on it:
 *
 *      { op, inputs, params, seeded, kept }
 *
 *    - `op`      the word as the toolkit spells it: 't.sample', 't.isolines'.
 *    - `inputs`  the input values in call order, by reference: a shape, a
 *                geometry, a selection, a field (a closure), bare points.
 *    - `params`  the call's own parameters, as plain data: numbers, strings,
 *                booleans, lengths, and lists and records of them (an area
 *                option is recorded as the loops it was lowered to). With
 *                the inputs and the frame they fix the result.
 *    - `seeded`  the call drew from the run's stream.
 *    - `kept`    what the rule worked out and the result holds on to (the
 *                levels `t.isolines` traced for `{ count }`); it is an
 *                answer, never part of a key.
 *
 *    The memo (memo.ts) keys a call by `op` + each input — a geometry by
 *    its IDENTITY (a derivation keeps its inputs, and `source` answers rows
 *    of that very value, so equal content from another object must not
 *    hit), plain data and shapes by their content — + `params` + the frame
 *    inputs the op reads (paper, units, space — the execution holds those,
 *    so the node does not) + the run's id counter. It never memoises a
 *    node with a function among its inputs (ruling 1: a closure is not
 *    hashable) or a `seeded` one (ruling 4: skipping a draw moves every
 *    later draw) — `memoisable(node)` says so. A value that is one of its
 *    own inputs (a word that handed its input back) gets no node.
 *
 *    A write (`set`, `move`, `add`, …) is a derivation of its own and does
 *    not inherit the node: the node says how THIS value was made.
 *
 * 2. The LINKS — the row correspondence, per domain (`points`, `edges`):
 *
 *      { points?: DomainLinks, edges?: DomainLinks, next?: Links }
 *      DomainLinks = { at, source?, params }
 *        at      the value the rows were linked on; its rows are the ones
 *                `source` and `params` are indexed by.
 *        source  { of, domain, rows }  one input row per row (-1: none),
 *                or { of, domain, many } a list of input rows per row: a
 *                row when the correspondence is one-to-one, a selection
 *                when it is many (ruling 7). `of` is the INPUT value, so a
 *                source is a row of the value the sketch passed in.
 *        params  parameter columns by name (`u`), one number a row (NaN:
 *                none).
 *
 *    Links are keyed by ROW IDENTITY, not by row: a later state finds its
 *    row's link by the row's id in `at`. So they are carried, as they are,
 *    by every write that keeps identity (`carryLinks`) — a `set` or `move`
 *    of a sample still answers `source` and `u` — a removed row simply
 *    finds nothing, and a row added later (a new id) has none. Where the
 *    state still holds `at`'s very id column (a `move`, a `set`, a
 *    restamp: nothing added or removed) the row IS the index, with no
 *    lookup. A derivation of a derived value layers its links over the
 *    ones it carried (`next`): the newest layer with an answer for a row
 *    gives it. A layer says nothing about a row it did not make (a split's
 *    layer on a point the split did not touch: -1, NaN or a hole), and that
 *    row, being the same row, answers what it answered before.
 *
 *    A link holds its input value, and that value its own links: a value
 *    derived from a derived value keeps the whole line of them alive. A
 *    run (`t.steps`) cuts the line at every step (`carryRunLinks`): what
 *    a pass derived answers within the pass, and only what the start
 *    answered goes on. A loop of splits written by hand keeps every state.
 *
 * Split, replace, planarize, resample and along (material.ts, tables.ts,
 * faces.ts) link their rows the same way: `linkRows(result, { edges: { source: { of:
 * input, domain: 'edges', rows } } })` after a rebuild that carried the
 * input's links with `carryLinks(input, result)`, and `record(result,
 * derivation('split', [input], { at }))`.
 */

import type { Edge, Material, Vertex } from './material.js';
import { pointsOf, edgesOf } from './relation.js';
import type { Selection } from './selection.js';
import { at64 } from './column.js';

// ---- the node ----------------------------------------------------------------

/** @internal How a derived value was made: see the file header. */
export interface Derivation {
  readonly op: string;
  readonly inputs: readonly unknown[];
  readonly params: Readonly<Record<string, unknown>>;
  readonly seeded: boolean;
  readonly kept: Readonly<Record<string, unknown>>;
}

const NODES = new WeakMap<object, Derivation>();

/** @internal A node record. `params` drops the keys whose value is
 * undefined, so an option left out and one given as undefined are one key. */
export function derivation(
  op: string,
  inputs: readonly unknown[],
  params: Readonly<Record<string, unknown>> = {},
  more: { seeded?: boolean; kept?: Readonly<Record<string, unknown>> } = {},
): Derivation {
  const own: Record<string, unknown> = {};
  for (const k of Object.keys(params)) if (params[k] !== undefined) own[k] = params[k];
  return Object.freeze({
    op,
    inputs: Object.freeze([...inputs]),
    params: Object.freeze(own),
    seeded: more.seeded ?? false,
    kept: Object.freeze({ ...(more.kept ?? {}) }),
  });
}

/** @internal Put `node` on the value a derivation returned, and hand the
 * value back. A value that is one of the node's own inputs — a word that
 * returned what it was given — keeps what it had: it was not made here. */
export function record<T>(value: T, node: Derivation): T {
  if (typeof value !== 'object' || value === null) return value;
  if (node.inputs.includes(value)) return value;
  NODES.set(value, node);
  return value;
}

/** @internal The node of a derived value, or undefined for a value no
 * derivation made (a pure `material(points)`, a write's result). */
export function nodeOf(value: unknown): Derivation | undefined {
  return typeof value === 'object' && value !== null ? NODES.get(value) : undefined;
}

/** @internal May a memo return an earlier result for this node? Not when
 * it takes a closure — as an input, or as a parameter (a spacing that is a
 * field) — (ruling 1), or draws from the run's stream (ruling 4). */
export function memoisable(node: Derivation): boolean {
  const fn = (v: unknown): boolean => typeof v === 'function';
  return !node.seeded && !node.inputs.some(fn) && !Object.values(node.params).some(fn);
}

// ---- the links ---------------------------------------------------------------

/** @internal Where a derived row came from: one input row per row (-1:
 * none), or a list of input rows per row. */
export type SourceSpec =
  | { readonly of: Material; readonly domain: 'points' | 'edges'; readonly rows: ArrayLike<number> }
  | { readonly of: Material; readonly domain: 'points' | 'edges'; readonly many: readonly (readonly number[] | undefined)[] };

/** @internal What one domain of a value links, row by row of `at`. */
export interface DomainLinks {
  readonly at: Material;
  readonly source?: SourceSpec;
  readonly params: Readonly<Record<string, ArrayLike<number>>>;
  /** Resolved sources, row by row, so a row's `source` is one value. */
  readonly resolved: unknown[];
}

/** @internal The row correspondence a value carries: see the file header. */
export interface Links {
  readonly points?: DomainLinks;
  readonly edges?: DomainLinks;
  readonly next?: Links;
}

/** What a derivation hands `linkRows` for one domain. */
export interface DomainSpec {
  readonly source?: SourceSpec;
  readonly params?: Readonly<Record<string, ArrayLike<number>>>;
}

const LINKS = new WeakMap<object, Links>();

/**
 * @internal Link the rows of `value` (a derivation's result) to where they
 * came from, over whatever links it already carries, and hand it back. The
 * arrays are indexed by `value`'s own rows; they are adopted, not copied,
 * so a caller never writes to one afterwards.
 */
export function linkRows(value: Material, spec: { points?: DomainSpec; edges?: DomainSpec }): Material {
  const domain = (d: DomainSpec | undefined): DomainLinks | undefined =>
    d === undefined || (d.source === undefined && (d.params === undefined || Object.keys(d.params).length === 0))
      ? undefined
      : { at: value, source: d.source, params: d.params ?? {}, resolved: [] };
  const points = domain(spec.points);
  const edges = domain(spec.edges);
  if (points === undefined && edges === undefined) return value;
  const under = LINKS.get(value);
  LINKS.set(value, { points, edges, next: under });
  return value;
}

/** @internal `to` was rebuilt from `from` keeping row identity (a write,
 * a restamp, a change of space, a cut that keeps what it keeps): it
 * carries `from`'s links, and hands `to` back. Nothing to do when `from`
 * has none, or when `to` is `from`. */
export function carryLinks<T extends Material>(from: Material, to: T): T {
  if (to === (from as unknown)) return to;
  const links = LINKS.get(from);
  if (links !== undefined && !LINKS.has(to)) LINKS.set(to, links);
  return to;
}

/**
 * @internal `to` is the next state of a run that began at `start`, rebuilt
 * from `from` keeping row identity: it carries the links `start` carried,
 * and none a pass made on the way. A split's layer names rows of the state
 * the split was given, which is the run's own and which nothing outside
 * the pass holds; kept from step to step, each layer would hold the state
 * before it, and a run of a thousand steps every state it passed through.
 * What the start answered — a sample's `u` and `source` — is kept, since
 * the sketch holds the start.
 */
export function carryRunLinks<T extends Material>(from: Material, to: T, start: unknown): T {
  if (to === (from as unknown) || typeof start !== 'object' || start === null) return to;
  const keep = LINKS.get(start);
  if (keep === undefined || LINKS.has(to)) return to;
  for (let links = LINKS.get(from); links !== undefined; links = links.next) {
    if (links === keep) {
      LINKS.set(to, keep);
      break;
    }
  }
  return to;
}

/** Each link that knows row `index` of `m` in `domain`, newest first, with
 * that row's place in the link's own rows. A caller takes the first that
 * has an answer for what it asks: a layer that made no claim about a row
 * (a split's layer on a row the split did not touch) leaves the row to the
 * layers beneath, since the row is still the row they linked. */
function* slots(m: Material, domain: 'points' | 'edges', index: number): Generator<{ d: DomainLinks; k: number }> {
  let links = LINKS.get(m);
  if (links === undefined) return;
  const ids = domain === 'points' ? m.store.pointIds : m.store.edgeIds;
  let id = NaN;
  for (; links !== undefined; links = links.next) {
    const d = links[domain];
    if (d === undefined) continue;
    const theirs = domain === 'points' ? d.at.store.pointIds : d.at.store.edgeIds;
    // The same id column: the same rows, in the same order.
    if (theirs === ids) {
      yield { d, k: index };
      continue;
    }
    if (Number.isNaN(id)) id = at64(ids, index);
    const k = domain === 'points' ? d.at.rowOfPoint(id as Vertex['id']) : d.at.rowOfEdge(id as Edge['id']);
    if (k >= 0) yield { d, k };
  }
}

/** Does this link say where row `k` came from? */
function claims(src: SourceSpec, k: number): boolean {
  if ('many' in src) return src.many[k] !== undefined;
  const r = src.rows[k];
  return r !== undefined && r >= 0;
}

/** @internal `row.source` for row `index` of `m`: the input row it came
 * from (a vertex or an edge of the input value), the input rows as a
 * selection when it came from many, or undefined. */
export function rowSource(m: Material, domain: 'points' | 'edges', index: number): RowSource {
  for (const { d, k } of slots(m, domain, index)) {
    const src = d.source;
    if (src === undefined || !claims(src, k)) continue;
    if (k in d.resolved) return d.resolved[k] as RowSource;
    const out: RowSource = 'many' in src
      ? (src.domain === 'points' ? pointsOf(src.of, [...src.many[k]!], undefined, true) : edgesOf(src.of, [...src.many[k]!], undefined, true))
      : (src.domain === 'points' ? src.of.vertex(src.rows[k]) : src.of.edge(src.rows[k]));
    d.resolved[k] = out;
    return out;
  }
  return undefined;
}

/** @internal What `source` answers: a row, a selection of rows, or nothing. */
export type RowSource = Vertex | Edge | Selection<Vertex> | Selection<Edge> | undefined;

/** @internal A parameter column (`u`) for row `index` of `m`, from the
 * newest link that has a value there; undefined where none has. */
export function rowParam(m: Material, domain: 'points' | 'edges', index: number, name: string): number | undefined {
  for (const { d, k } of slots(m, domain, index)) {
    const col = d.params[name];
    const v = col === undefined ? undefined : col[k];
    if (v !== undefined && !Number.isNaN(v)) return v;
  }
  return undefined;
}

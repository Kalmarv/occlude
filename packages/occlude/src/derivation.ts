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
 *    The one reader of a node in the library is `cloudArea` (api.ts), which
 *    reads `op` and `params.within` so the next point word defaults to the
 *    area a cloud was bounded by. `inputs`, `seeded` and `kept` are read
 *    by tests only; `inputs` holds every input by reference, so a loop of
 *    derivations written by hand (`m = t.relax(m)` again and again) keeps
 *    every state it passed through (kept by the owner's ruling, not by a
 *    reader). A value that is one of its own inputs (a word that handed
 *    its input back) gets no node.
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
 *    A geometry keeps its node and its links in its own cache record
 *    (`Material.cache`), so they die with it at the first collection that
 *    finds it unreachable. Only a node of a value that has no cache
 *    (anything but a geometry) lives in a module weak map (`NODES`);
 *    links live on a geometry only.
 *
 *    A link holds its input value, and that value its own links: a value
 *    derived from a derived value keeps the whole line of them alive. A
 *    run (`t.steps`) keeps one step of it (`beginStep`, `endStep`): the state a step
 *    ends with answers what the start answered and what that step made,
 *    and the states the step read forget what they made, so a row made in
 *    a run answers `source` for one step. A loop of splits written by hand
 *    keeps every state.
 *
 * Split, replace, planarize, resample and along (material.ts, tables.ts,
 * faces.ts) link their rows the same way: `linkRows(result, { edges: { source: { of:
 * input, domain: 'edges', rows } } })` after a rebuild that carried the
 * input's links with `carryLinks(input, result)`, and `record(result,
 * derivation('split', [input], { at }))`.
 */

import type { Edge, Material, StateCache, Vertex } from './material.js';
import { pointsOf, edgesOf } from './relation.js';
import { select, type Selection } from './selection.js';
import type { Face } from './faces.js';
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

/**
 * Where a value keeps its derivation: a geometry holds its node and its
 * links in its own cache record (`Material.cache`, `links` and `node`), so
 * what a derivation keeps lives exactly as long as the value that keeps
 * it. A global weak map would do the same for the program, but not for
 * the collector: an entry of a weak map is only let go by a full
 * collection, so a run of splits kept every short-lived state alive
 * through the minor ones. A value that has no cache (anything but a
 * geometry) keeps its node in the weak map.
 */
type LinkBox = Pick<StateCache, 'links' | 'node'>;
const boxOf = (v: object): LinkBox | undefined => (v as { readonly cache?: LinkBox }).cache;

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
  const box = boxOf(value);
  if (box !== undefined) box.node = node;
  else NODES.set(value, node);
  return value;
}

/** @internal The node of a derived value, or undefined for a value no
 * derivation made (a pure `material(points)`, a write's result). */
export function nodeOf(value: unknown): Derivation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return boxOf(value)?.node ?? NODES.get(value);
}

// ---- the links ---------------------------------------------------------------

/** @internal Where a derived row came from: one input row per row (-1:
 * none), or a list of input rows per row — rows of the input's points,
 * edges or (stated) faces. */
export type SourceSpec =
  | { readonly of: Material; readonly domain: 'points' | 'edges' | 'faces'; readonly rows: ArrayLike<number> }
  | { readonly of: Material; readonly domain: 'points' | 'edges' | 'faces'; readonly many: readonly (readonly number[] | undefined)[] }
  /** A source read row by row, the first time a row asks (undefined:
   * none): for a derivation whose rows come from different places — a
   * point of one input or the other, a point of a face. */
  | { readonly read: (row: number) => unknown };

/** @internal What one domain of a value links, row by row of `at`. A list
 * of specs is a row made from several inputs: its `source` is a list, one
 * answer per input, in the order the derivation takes them. */
export interface DomainLinks {
  readonly at: Material;
  readonly source?: SourceSpec | readonly SourceSpec[];
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
  readonly source?: SourceSpec | readonly SourceSpec[];
  readonly params?: Readonly<Record<string, ArrayLike<number>>>;
}

/** The links a geometry carries: in its own box (see `LinkBox`). */
const linksOf = (m: Material): Links | undefined => m.cache.links;

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
  const under = linksOf(value);
  value.cache.links = { points, edges, next: under };
  return value;
}

/** @internal `to` was rebuilt from `from` keeping row identity (a write,
 * a restamp, a change of space, a cut that keeps what it keeps): it
 * carries `from`'s links, and hands `to` back. Nothing to do when `from`
 * has none, or when `to` is `from`. */
export function carryLinks<T extends Material>(from: Material, to: T): T {
  if (to === (from as unknown)) return to;
  const links = linksOf(from);
  if (links !== undefined && linksOf(to) === undefined) to.cache.links = links;
  return to;
}

/** @internal A step of a run in progress (`t.steps`): the state it began
 * with, marked so that what the step derives from it can be told apart
 * from anything else; the links it carried before; and the links the
 * run's start carries, which every state of the run keeps. */
export interface Step {
  readonly state: Material;
  readonly mark: Links;
  readonly was: Links | undefined;
  readonly keep: Links | undefined;
}

/** @internal Begin a step of the run that began at `start` on `state`:
 * put an empty layer on it, which every value the step derives from it
 * carries. The layer answers nothing (it links no domain). */
export function beginStep(state: Material, start: unknown): Step {
  const keep = typeof start === 'object' && start !== null ? boxOf(start)?.links : undefined;
  const was = linksOf(state);
  const mark: Links = { next: was };
  state.cache.links = mark;
  return { state, mark, was, keep };
}

/**
 * @internal End a step of a run: `to` is the state it ended with, rebuilt
 * keeping row identity. `to` keeps the layers this step made, over what
 * the start carries, and nothing between: the layers an earlier step made
 * are dropped. The values the kept layers read that the step derived —
 * the state it began with, and the states between its passes — then carry
 * what the start carries alone, so each holds nothing further back
 * and a run of a thousand steps holds one step, not every state it passed
 * through: a row made in a run answers `source` for one step. The state
 * the step began with gets its own links back when nothing reads it. A
 * value the step did not derive from its state (a pass that makes a new
 * value from something else) keeps its links as they are.
 */
export function endStep<T extends Material>(to: T, step: Step): T {
  const { mark, keep } = step;
  const made: Links[] = [];
  let links = linksOf(to);
  for (; links !== undefined && links !== mark && links !== keep; links = links.next) made.push(links);
  if (links !== undefined) {
    let chain = keep;
    for (let i = made.length - 1; i >= 0; i--) chain = { points: made[i].points, edges: made[i].edges, next: chain };
    to.cache.links = chain;
    const forget = (v: unknown): void => {
      if (v === to || typeof v !== 'object' || v === null) return;
      const box = boxOf(v);
      if (box === undefined) return;
      for (let l = box.links; l !== undefined; l = l.next) {
        if (l === mark) {
          box.links = keep;
          return;
        }
      }
    };
    for (const layer of made) {
      for (const d of [layer.points, layer.edges]) {
        if (d === undefined) continue;
        forget(d.at);
        const src = d.source;
        if (src === undefined) continue;
        for (const one of isList(src) ? src : [src]) if ('of' in one) forget(one.of);
      }
    }
  }
  if (step.state.cache.links === mark) step.state.cache.links = step.was;
  return to;
}

/** @internal A state of a run the run keeps on its history: it answers
 * what the run's start answered, and not what its step made, so a long
 * history holds its states and nothing between them. */
export function startLinks<T extends Material>(to: T, step: Step): T {
  to.cache.links = step.keep;
  return to;
}

/** Each link that knows row `index` of `m` in `domain`, newest first, with
 * that row's place in the link's own rows. A caller takes the first that
 * has an answer for what it asks: a layer that made no claim about a row
 * (a split's layer on a row the split did not touch) leaves the row to the
 * layers beneath, since the row is still the row they linked. */
function* slots(m: Material, domain: 'points' | 'edges', index: number): Generator<{ d: DomainLinks; k: number }> {
  let links = linksOf(m);
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

/** Does this link say where row `k` came from? (A source read row by row
 * says so by answering.) */
function claims(src: SourceSpec | readonly SourceSpec[], k: number): boolean {
  if (isList(src)) return src.some((one) => claims(one, k));
  if ('read' in src) return true;
  if ('many' in src) return src.many[k] !== undefined;
  const r = src.rows[k];
  return r !== undefined && r >= 0;
}

const isList = (src: SourceSpec | readonly SourceSpec[]): src is readonly SourceSpec[] => Array.isArray(src);

/** The input row (or rows, as a selection) one spec names for row `k`,
 * or undefined where it names none. */
function answer(src: SourceSpec, k: number): unknown {
  if ('read' in src) return src.read(k);
  if (!claims(src, k)) return undefined;
  if ('many' in src) {
    const rows = [...src.many[k]!];
    if (src.domain === 'faces') return select(src.of.faces.domain, rows, undefined, true);
    return src.domain === 'points' ? pointsOf(src.of, rows, undefined, true) : edgesOf(src.of, rows, undefined, true);
  }
  const r = src.rows[k];
  if (src.domain === 'faces') return src.of.faces.at(r);
  return src.domain === 'points' ? src.of.vertex(r) : src.of.edge(r);
}

/** @internal `row.source` for row `index` of `m`: the input row it came
 * from (a vertex or an edge of the input value), the input rows as a
 * selection when it came from many, or undefined. */
export function rowSource(m: Material, domain: 'points' | 'edges', index: number): RowSource {
  for (const { d, k } of slots(m, domain, index)) {
    const src = d.source;
    if (src === undefined || !claims(src, k)) continue;
    if (k in d.resolved) {
      const got = d.resolved[k] as RowSource;
      if (got !== undefined) return got;
      continue;
    }
    const out = (isList(src) ? Object.freeze(src.map((one) => answer(one, k))) : answer(src, k)) as RowSource;
    d.resolved[k] = out;
    // A row a source read row by row has no answer for is left to the
    // layers beneath, as a row a layer makes no claim about is.
    if (out !== undefined) return out;
  }
  return undefined;
}

/** @internal What `source` answers: a row, a selection of rows, a list of
 * those (one per input), or nothing. */
export type RowSource = Vertex | Edge | Face | Selection<Vertex> | Selection<Edge> | Selection<Face> | readonly unknown[] | undefined;

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

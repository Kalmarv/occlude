/**
 * View identity: how a vertex, edge or face view knows which state made
 * it. A view is a plain-looking object whose data are its own enumerable
 * columns, and whose brand — its owner (a material or a face collection)
 * and its kind — spread, `Object.keys`, JSON and `structuredClone` never
 * see, so a copy is unowned. Nothing here depends on the material class:
 * `ownerOf`/`viewKind` are the whole contract, and every consumer of a
 * view reads the brand through these functions. A point or edge value
 * (`point(…)`, `edge(…)`) carries a brand of its own (`valueKind`), and
 * `describe` is what every refusal calls a thing it was handed.
 *
 * Two carriers of the brand, one contract:
 *
 * - A ROW VIEW (a vertex or an edge of a material) is an instance of a
 *   subclass of `RowView`: the owner is a private field of the view, and
 *   the kind and the words sit on the class prototype, which every state
 *   shares. So every vertex view of every state with the same columns has
 *   one hidden class, and nothing long-lived points at a state: a
 *   prototype per state was a hidden class per state, which V8 keeps in
 *   old space, and through the prototype to the state to its kept views it
 *   held every view of every dead state through each minor collection —
 *   most of what keeping a view of every row cost (308 MB promoted over a
 *   100-step `set` and `move` of 20 000 points).
 * - Any other view (a face) has a prototype of its own owner, made by
 *   `viewProto`: few are made, and each is a row of a value that lives.
 */

import { Selection } from './selection.js';

const OWNER = Symbol('material');
const KIND = Symbol('view');

/** Which kind of view this is — decided by the material that made it,
 * never by the presence of attribute names (an artist may call a column
 * `a`, `b` or `x`). `undefined` for anything that is not a view. */
export function viewKind(view: unknown): 'vertex' | 'edge' | 'face' | 'corner' | undefined {
  return typeof view === 'object' && view !== null ? (view as Record<symbol, 'vertex' | 'edge' | 'face' | 'corner'>)[KIND] : undefined;
}

/**
 * @internal The base of every vertex and edge view. The owner is a private
 * field: set once, read by `ownerOf`, and invisible to everything a sketch
 * can do with the view — keys, spread, JSON, `structuredClone` (which
 * copies a view into a plain, unowned record). A subclass per kind carries
 * the kind and the words (`rowViewKind`).
 */
export class RowView {
  readonly #owner: object;
  constructor(owner: object) {
    this.#owner = owner;
  }
  /** The state `v` is a row of, when `v` is a row view. */
  static ownerOf(v: unknown): object | undefined {
    return typeof v === 'object' && v !== null && #owner in v ? v.#owner : undefined;
  }
}
Object.freeze(RowView.prototype);

/** @internal Make `cls` the class of every row view of one kind: its
 * prototype says the kind and answers `words`, and is frozen. */
export function rowViewKind(cls: abstract new (...args: never[]) => RowView, kind: 'vertex' | 'edge', words: PropertyDescriptorMap): void {
  Object.defineProperty(cls.prototype, KIND, { value: kind, enumerable: false });
  Object.defineProperties(cls.prototype, words);
  Object.freeze(cls.prototype);
}

/** @internal The prototype every view of one owner and kind shares, for a
 * view that is not a row view (a face). The brand lives on it — reachable
 * through the chain by `ownedBy` and `viewKind`, and invisible to
 * `Object.keys`, `for…in`, spread and JSON exactly as a non-enumerable own
 * symbol was, so a spread copy is still unowned. `words` is what the brand
 * sits on: the getters every view of this kind answers, shared by every
 * owner. */
export function viewProto(owner: object, kind: 'vertex' | 'edge' | 'face' | 'corner', words: object = Object.prototype): object {
  const proto = Object.create(words) as object;
  Object.defineProperty(proto, OWNER, { value: owner, enumerable: false });
  Object.defineProperty(proto, KIND, { value: kind, enumerable: false });
  return Object.freeze(proto);
}

/** @internal One key for an undirected pair of rows. */
export const pairKey = (a: number, b: number) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

/** @internal The owner of any view: a row view's state, or the owner a
 * face's or a corner's prototype records. */
export function ownerOf(view: object): object | undefined {
  return RowView.ownerOf(view) ?? (view as Record<symbol, object> | null | undefined)?.[OWNER];
}

/** @internal True when `view` came from `m` — this state, not merely a
 * material with the same shape. */
export function ownedBy(view: object, m: object): boolean {
  return ownerOf(view) === m;
}

// ---- values you hold, and what a refusal calls a thing -----------------------------

const VALUE = Symbol('value');

/** @internal The prototype every point value (`'point'`) or edge value
 * (`'edge'`) shares: the brand lives on it, so a spread copy is a plain
 * record, as a spread view is. */
export function valueProto(kind: 'point' | 'edge'): object {
  return Object.freeze(Object.create(Object.prototype, { [VALUE]: { value: kind } }));
}

/** Which kind of value `point(…)` or `edge(…)` made this is; `undefined`
 * for anything else. */
export function valueKind(v: unknown): 'point' | 'edge' | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<symbol, 'point' | 'edge' | undefined>)[VALUE] : undefined;
}

const article = (word: string): string => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

/**
 * What a refusal calls the thing it was handed — the one wording every
 * refusal uses: a view by its kind, a point or edge value, a selection by
 * its kind, a position, a list, an instance by its class, a record, and a
 * primitive with its value.
 */
export function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'nothing (undefined)';
  const view = viewKind(v);
  if (view !== undefined) return `${article(view)} view`;
  const value = valueKind(v);
  if (value !== undefined) return `${article(value)} value`;
  if (v instanceof Selection) return `${article(v.domain.kind.name)} selection`;
  if (Array.isArray(v)) {
    const numbers = v.every((c) => typeof c === 'number');
    if (numbers && v.length === 2) return 'a position [x, y]';
    if (numbers && v.length === 3) return 'a place [x, y, z]';
    return `a list of ${v.length}`;
  }
  switch (typeof v) {
    case 'string': return `the string '${v}'`;
    case 'number': return `the number ${v}`;
    case 'boolean': return `the boolean ${v}`;
    case 'function': return 'a function';
    case 'object': {
      const o = v as { x?: unknown; y?: unknown; constructor?: { name?: string } };
      if (typeof o.x === 'number' && typeof o.y === 'number') return 'a position { x, y }';
      const name = Object.getPrototypeOf(v) === Object.prototype ? undefined : o.constructor?.name;
      return name !== undefined && name !== '' && name !== 'Object' ? article(name) : 'a record';
    }
    default: return typeof v;
  }
}

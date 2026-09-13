/**
 * View identity: how a vertex, edge or face view knows which state made
 * it. A view is a plain object whose prototype carries two non-enumerable
 * symbols — its owner (a material or a face collection) and its kind — so
 * `ownedBy`/`viewKind` answer through the prototype chain while spread,
 * `Object.keys`, JSON and `structuredClone` see only the data. A copy is
 * unowned. Nothing here depends on the material class: the symbols are the
 * whole contract, and every consumer of a view reads them through these
 * functions.
 */

const OWNER = Symbol('material');
const KIND = Symbol('view');

/** Which kind of view this is — decided by the material that made it,
 * never by the presence of attribute names (an artist may call a column
 * `a`, `b` or `x`). `undefined` for anything that is not a view. */
export function viewKind(view: unknown): 'vertex' | 'edge' | 'face' | undefined {
  return typeof view === 'object' && view !== null ? (view as Record<symbol, 'vertex' | 'edge' | 'face'>)[KIND] : undefined;
}

/** @internal The prototype every view of one owner and kind shares. The
 * brand lives on it — reachable through the chain by `ownedBy` and
 * `viewKind`, and invisible to `Object.keys`, `for…in`, spread and JSON
 * exactly as a non-enumerable own symbol was, so a spread copy is still
 * unowned. A view then costs no property definition of its own: defining
 * two per view was 47% of a 195-step growth render. */
export function viewProto(owner: object, kind: 'vertex' | 'edge' | 'face'): object {
  const proto = {};
  Object.defineProperty(proto, OWNER, { value: owner, enumerable: false });
  Object.defineProperty(proto, KIND, { value: kind, enumerable: false });
  return Object.freeze(proto);
}

/** @internal One key for an undirected pair of rows. */
export const pairKey = (a: number, b: number) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);

/** @internal The owner of a vertex or edge view (its material), for identity checks. */
export const ownerOf = (p: object): object | undefined => (p as unknown as Record<symbol, object>)[OWNER];

/** @internal The owner recorded on any view (a material or a face collection). */
export function ownerOfView(view: object): object | undefined {
  return (view as Record<symbol, object>)[OWNER];
}

/** True when `view` (a vertex or edge view) came from `m` — this state,
 * not merely a material with the same shape. */
export function ownedBy(view: object, m: object): boolean {
  return (view as unknown as Record<symbol, object>)[OWNER] === m;
}

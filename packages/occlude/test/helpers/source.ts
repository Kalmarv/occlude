/** What a derived row's `source` names, read the way a sketch checks it:
 * as a member of the input it came from. */

import type { Placement, Selection } from '../../src/index.js';
import { isSelectionOf } from '../../src/selection.js';
import { isPlacement } from '../../src/placement.js';

/** A row that answers `source`: a point, an edge, a face. */
type Derived = { readonly source?: unknown };

/** A list or a selection: what a source from many rows is. A row is not
 * iterable. */
const isList = (v: unknown): v is Iterable<unknown> => typeof v === 'object' && v !== null && Symbol.iterator in v;

/** True when `v` is one row of `rows`: an object, not a list, and a
 * member. A row of another kind is refused by name by `has`. */
const isRowOf = <R>(rows: Selection<R>, v: unknown): v is R =>
  typeof v === 'object' && v !== null && !isList(v) && rows.has(v);

/** The one row of `rows` that `of.source` names. Fails the test when the
 * source is nothing, several rows, or not a member of `rows`. */
export function sourceRow<R>(rows: Selection<R>, of: Derived): R {
  const s = of.source;
  if (!isRowOf(rows, s)) throw new Error(`source: expected one row of these ${rows.length} rows, got ${String(s)}`);
  return s;
}

/** The rows of `rows` that `of.source` names when it came from many (a
 * crossing names the edges that meet there), in its own order. Fails the
 * test when the source is not a list, or holds a row that is not a member. */
export function sourceRows<R>(rows: Selection<R>, of: Derived): R[] {
  const s = of.source;
  if (!isList(s)) throw new Error(`source: expected several rows, got ${String(s)}`);
  const all = [...s];
  if (!all.every((v): v is R => isRowOf(rows, v))) throw new Error(`source: a row is not one of these ${rows.length} rows`);
  return all;
}

/** The selection `of.source` is when it names many rows of one kind (a
 * quadtree cell names the points it holds), each a member of `rows`.
 * Fails the test otherwise. */
export function sourceSelection<R extends object>(rows: Selection<R>, of: Derived): Selection<R> {
  const s = of.source;
  if (!isSelectionOf<R>(s, rows.domain.kind)) throw new Error(`source: expected a selection of ${rows.domain.kind.plural}, got ${String(s)}`);
  if (!s.every((r) => rows.has(r))) throw new Error(`source: a row is not one of these ${rows.length} rows`);
  return s;
}

/** The placement `of.source` is (a tile names the placement that stands
 * it). Fails the test when the source is anything else. */
export function sourcePlacement(of: Derived): Placement {
  const s = of.source;
  if (!isPlacement(s)) throw new Error(`source: expected a placement, got ${String(s)}`);
  return s;
}

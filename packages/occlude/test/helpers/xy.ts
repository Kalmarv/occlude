/** Test-side readings a material no longer spells as a member. */

/** A point row's position as a pair: `m.points.map(xy)` is the positions
 * of a material, row order. */
export const xy = (p: { readonly x: number; readonly y: number }): [number, number] => [p.x, p.y];

/** A curve row's points as pairs, in walk order. */
export const pts = (c: { readonly points: Iterable<{ readonly x: number; readonly y: number }> }): [number, number][] => Array.from(c.points, xy);

/** A value's curves as plain chain records: the points as pairs in walk
 * order, the closure, and the point rows walked. */
export const chains = (v: { readonly curves: Iterable<{ readonly points: Iterable<{ readonly x: number; readonly y: number; readonly index?: number }>; readonly closed: boolean }> }): { pts: [number, number][]; closed: boolean; indices: number[] }[] =>
  Array.from(v.curves, (c) => ({ pts: pts(c), closed: c.closed, indices: Array.from(c.points, (p) => p.index ?? -1) }));

/** Is this material one closed chain — a ring? Read from its curves. */
export const oneRing = (m: { readonly curves: { readonly length: number; at(i: number): { readonly closed: boolean } } }): boolean =>
  m.curves.length === 1 && m.curves.at(0).closed;

/** One curve row as the plain chain record the old `curves()` answered:
 * the points as pairs in walk order, the closure, the point rows walked,
 * and — where an edge is a geodesic — the flags, edge by edge. */
export const rec = (c: { readonly points: Iterable<{ readonly x: number; readonly y: number; readonly index?: number }>; readonly closed: boolean; readonly edges?: Iterable<Record<string, unknown>> }): { pts: [number, number][]; closed: boolean; indices: number[]; geodesic?: boolean[] } => {
  const out: { pts: [number, number][]; closed: boolean; indices: number[]; geodesic?: boolean[] } = { pts: pts(c), closed: c.closed, indices: Array.from(c.points, (p) => p.index ?? -1) };
  const flags = c.edges === undefined ? [] : Array.from(c.edges, (e) => typeof e.geodesic === 'number' && e.geodesic !== 0);
  if (flags.some((g) => g)) out.geodesic = flags;
  return out;
};

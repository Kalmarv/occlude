/** Test-side readings a material no longer spells as a member. */

/** A point row's position as a pair: `m.points.map(xy)` is the positions
 * of a material, row order. */
export const xy = (p: { readonly x: number; readonly y: number }): [number, number] => [p.x, p.y];

/** Is this material one closed chain — a ring? Read from its curves. */
export const oneRing = (m: { curves(): readonly { readonly closed: boolean }[] }): boolean => {
  const cs = m.curves();
  return cs.length === 1 && cs[0].closed;
};

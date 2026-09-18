/**
 * envelope: the curve a family of curves is drawing without any of them
 * touching it.
 *
 * Curve stitching, string art, the mod-n chord pile, guilloché, a ruled
 * surface seen flat, the caustic in a coffee cup — all of them are one idea.
 * You never compute the curve you want. You draw a family of straight lines,
 * and the shape appears in the gaps as the curve every one of them is tangent
 * to. Draw the chord from (t, 0) to (0, k − t) for every t and a parabola is
 * there; place n points on a circle and join k to m·k mod n and a cardioid is
 * there.
 *
 * What has never been available is the curve ITSELF, as geometry: to draw it
 * heavier than the family, to cut with it, to hang something else off it. That
 * is what this returns.
 *
 * The textbook definition wants calculus — solve `F(x, y, t) = 0` and
 * `∂F/∂t = 0` together — and calculus is not what a drawing has. A drawing has
 * a family in an order. So the definition used here is the discrete one that
 * needs nothing else: **the envelope of a family is where neighbouring members
 * cross.** Two consecutive chords of a parabola meet on the parabola; make the
 * family denser and the meeting points close onto the true envelope. The
 * family's own resolution is the accuracy, which is honest — it is also
 * exactly what the plotted drawing shows.
 *
 * The family is the chains of `m`, in the order they are stored, which is the
 * order `append` put them in. Neighbouring means neighbouring in that order,
 * so a family assembled out of order has a different envelope, and is not
 * wrong to.
 *
 * A pair of neighbours may cross more than once, and then the envelope has
 * that many branches — a hypotrochoid family has an inner envelope and an
 * outer one, and both are real. Branches are carried from one pair of
 * neighbours to the next BY ORDER along the earlier member, not by distance:
 * ordering is a property the family already has, where any "nearest" rule
 * would need a tolerance, and a tolerance here would be a number invented to
 * paper over the fact that nobody said what the family was. Where a pair
 * crosses fewer times than the pair before it, the extra branches end; where
 * it crosses more, the extra branches begin.
 *
 * Every vertex carries `member`: the index of the earlier of the two family
 * members that crossed there. Fading a family by `member`, or cutting the
 * envelope where the family is densest, is then an ordinary column read.
 *
 * Pure: no seed, no paper, no units.
 */

import { Material, material as makeMaterial } from './material.js';

export function envelope(m: Material): Material {
  const src = makeMaterial(m);
  const curves = src.curves();
  const chains = curves.map((c) => {
    const pts = c.pts.map(([x, y]) => [x, y] as [number, number]);
    // A closed member's last segment returns to its first point.
    return c.closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  });
  // One curve has no neighbour to meet, so there is no envelope to draw:
  // the family is empty until the second member arrives.
  if (chains.length < 2) return makeMaterial([]);

  const side = (ax: number, ay: number, bx: number, by: number, px: number, py: number): number =>
    (bx - ax) * (py - ay) - (by - ay) * (px - ax);

  /** Where two members cross, in order along the first of them. */
  const meetings = (a: readonly [number, number][], b: readonly [number, number][]): [number, number][] => {
    const found: { at: number; x: number; y: number }[] = [];
    for (let i = 0; i + 1 < a.length; i++) {
      const [ax, ay] = a[i];
      const [bx, by] = a[i + 1];
      for (let j = 0; j + 1 < b.length; j++) {
        const [cx, cy] = b[j];
        const [dx, dy] = b[j + 1];
        // Segments sharing an endpoint meet without crossing; the orientation
        // test reads that as a crossing because one of its four values is
        // exactly zero there. A family whose members share a point — a pencil
        // of lines through the origin — would otherwise report its own hub as
        // an envelope, which is the one place there is provably no tangency.
        if ((ax === cx && ay === cy) || (ax === dx && ay === dy) || (bx === cx && by === cy) || (bx === dx && by === dy)) continue;
        const s1 = side(ax, ay, bx, by, cx, cy);
        const s2 = side(ax, ay, bx, by, dx, dy);
        const s3 = side(cx, cy, dx, dy, ax, ay);
        const s4 = side(cx, cy, dx, dy, bx, by);
        if (!(s1 > 0 !== s2 > 0 && s3 > 0 !== s4 > 0)) continue;
        const t = s3 / (s3 - s4);
        found.push({ at: i + t, x: ax + (bx - ax) * t, y: ay + (by - ay) * t });
      }
    }
    found.sort((p, q) => p.at - q.at);
    return found.map((p) => [p.x, p.y]);
  };

  const xs: number[] = [];
  const ys: number[] = [];
  const member: number[] = [];
  const edges: number[] = [];
  // One open branch per crossing of the previous pair, in the same order.
  let open: number[] = [];
  for (let k = 0; k + 1 < chains.length; k++) {
    const here = meetings(chains[k], chains[k + 1]);
    const next: number[] = [];
    for (let b = 0; b < here.length; b++) {
      const v = xs.length;
      xs.push(here[b][0]);
      ys.push(here[b][1]);
      member.push(k);
      if (b < open.length) {
        edges.push(open[b], v);
      }
      next.push(v);
    }
    open = next;
  }

  return new Material(
    Float64Array.from(xs),
    Float64Array.from(ys),
    { member: Float64Array.from(member) },
    Uint32Array.from(edges),
    0,
    [],
    {},
    { member: 'nearest' },
    {},
  );
}

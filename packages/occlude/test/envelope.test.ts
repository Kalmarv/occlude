import { describe, expect, it } from 'vitest';
import { append, curve, material, type Material } from '../src/index.js';

const family = (members: [number, number][][]): Material =>
  members.map((pts) => curve(pts)).reduce((a, b) => append(a, b)) as unknown as Material;

/** The classic: chords from (t, 0) to (0, k - t). Their envelope is the
 * parabola √x + √y = √k, tangent to every one of them. */
const chords = (k: number, n: number): [number, number][][] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = (k * i) / n;
    return [[t, 0], [0, k - t]] as [number, number][];
  });

describe('envelope', () => {
  it('finds the parabola a family of chords is drawing', () => {
    const e = family(chords(100, 200)).envelope();
    expect(e.n).toBeGreaterThan(150);
    for (let i = 0; i < e.n; i++) {
      // √x + √y = √k, to the family's own resolution
      expect(Math.sqrt(e.x[i]) + Math.sqrt(e.y[i])).toBeCloseTo(10, 1);
    }
  });

  it('closes on the true envelope as the family gets denser', () => {
    const err = (n: number): number => {
      const e = family(chords(100, n)).envelope();
      let worst = 0;
      for (let i = 0; i < e.n; i++) worst = Math.max(worst, Math.abs(Math.sqrt(e.x[i]) + Math.sqrt(e.y[i]) - 10));
      return worst;
    };
    const coarse = err(20);
    const fine = err(320);
    // Not a tolerance: the point is that the family's resolution IS the
    // accuracy, and refining the family is the way to improve it.
    expect(fine).toBeLessThan(coarse / 4);
  });

  it('is one chain along the family, carrying which members made it', () => {
    const e = family(chords(100, 60)).envelope();
    expect(e.points.components()).toHaveLength(1);
    expect(e.n).toBe(e.edgeList.length / 2 + 1);
    const members = Array.from(e.attrs.member);
    // Strictly increasing: one vertex per neighbouring pair, in family order.
    for (let i = 1; i < members.length; i++) expect(members[i]).toBeGreaterThan(members[i - 1]);
    // The first pair contributes nothing, and should not: member 0 is the
    // degenerate chord lying along the axis, and member 1 ENDS on it. Two
    // curves that touch without crossing have no envelope point between them.
    expect(members[0]).toBe(1);
  });

  it('neighbouring means neighbouring in the family, not in space', () => {
    const inOrder = chords(100, 40);
    // Interleaved from the two ends, so consecutive members are far apart in
    // the parameter — not merely two ordered halves, which would each still
    // be a family with the same envelope.
    const shuffled = inOrder.flatMap((_, i) =>
      i * 2 < inOrder.length ? [inOrder[i], inOrder[inOrder.length - 1 - i]] : [],
    );
    const a = family(inOrder).envelope();
    const b = family(shuffled).envelope();
    // Same curves, different order, different envelope — and the shuffled one
    // is not the parabola any more.
    let worst = 0;
    for (let i = 0; i < b.n; i++) worst = Math.max(worst, Math.abs(Math.sqrt(b.x[i]) + Math.sqrt(b.y[i]) - 10));
    expect(worst).toBeGreaterThan(1);
    // Same curves, same count of neighbouring pairs — a different curve.
    expect(Array.from(b.x)).not.toEqual(Array.from(a.x));
  });

  it('keeps every branch when neighbours cross more than once', () => {
    // Circles that drift sideways: each neighbouring pair meets twice, so the
    // envelope has two branches, above and below.
    const ring = (cx: number): [number, number][] =>
      Array.from({ length: 65 }, (_, k) => {
        const a = (k / 64) * Math.PI * 2;
        return [cx + 30 * Math.cos(a), 50 + 30 * Math.sin(a)] as [number, number];
      });
    const e = family(Array.from({ length: 24 }, (_, i) => ring(30 + i * 1.5))).envelope();
    expect(e.points.components()).toHaveLength(2);
    const above = Array.from(e.y).filter((y) => y > 50).length;
    expect(above).toBe(e.n / 2);
  });

  it('reports no envelope for a pencil through one point', () => {
    // Every member starts at the hub, so every neighbouring pair MEETS there
    // rather than crossing. A hub is the one place a pencil is provably not
    // tangent to anything, and it is not reported as an envelope.
    const pencil = Array.from({ length: 30 }, (_, i) => {
      const a = (i / 30) * Math.PI * 0.9;
      return [[50, 50], [50 + 60 * Math.cos(a), 50 + 60 * Math.sin(a)]] as [number, number][];
    });
    expect(family(pencil).envelope().n).toBe(0);
  });

  it('is empty without a family, and is a pure function of one', () => {
    // One curve has no neighbour to meet: no envelope yet, no error.
    expect((curve([[0, 0], [1, 1]]) as unknown as Material).envelope().n).toBe(0);
    expect(material([[0, 0], [1, 1]]).envelope().n).toBe(0);
    const twice = () => Array.from(family(chords(100, 50)).envelope().x);
    expect(twice()).toEqual(twice());
  });
});

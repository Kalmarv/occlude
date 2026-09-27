/**
 * A point of a curve reads five derived columns. Two of them a sketch may
 * write — `u` and `heading` — and then the point reads its own column on
 * every view of it, the curve's included, so one row gives one answer.
 * The other three — `s`, `tangent` and `normal` — the curve works out and
 * a sketch never writes: every write door refuses them by name. A point's
 * `placement` is a call, so no column may take its name either.
 */

import { describe, expect, it } from 'vitest';
import { curve, material, point } from '../src/index.js';

const ring = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });

describe('the words a point derives are not columns', () => {
  for (const name of ['s', 'tangent', 'normal', 'placement']) {
    const refused = new RegExp(`'${name}' is a reserved field of a point, not a column`);
    it(`'${name}' is refused by every write`, () => {
      const m = ring();
      expect(() => m.points.set(name, 1)).toThrow(refused);
      expect(() => m.points.set({ [name]: 1 })).toThrow(refused);
      expect(() => m.curves.at(0).points.set(name, 1)).toThrow(refused);
      expect(() => point([5, 5], { [name]: 1 })).toThrow(refused);
      expect(() => m.points.add([5, 5], { [name]: 1 })).toThrow(refused);
      expect(() => material([[0, 0], [1, 0]], { [name]: [1, 2] })).toThrow(refused);
    });
  }

  it('a curve and along still answer them', () => {
    const c = ring().curves.at(0);
    expect(c.points.map((p) => p.s)).toEqual([0, 10, 20, 30]);
    expect(c.points.at(1).tangent).toEqual([expect.closeTo(0.7071, 4), expect.closeTo(0.7071, 4)]);
    expect(c.points.at(1).normal).toEqual([expect.closeTo(-0.7071, 4), expect.closeTo(0.7071, 4)]);
    const a = ring().along({ count: 4 }).points;
    expect(a.map((p) => p.s)).toEqual([0, 10, 20, 30]);
    expect(a.at(1).tangent.length).toBe(2);
  });

  it('a point read from a curve leaves its s behind: the new row derives its own', () => {
    const from = ring().curves.at(0).points.at(2);
    expect(from.s).toBe(20);
    const m = curve([[0, 0], [3, 4]], { closed: false }).points.add(from);
    expect(m.points.at(2).s).toBeUndefined();
    const joined = m.edges.add([m.points.at(1), m.points.at(2)]);
    const c = joined.curves.at(0);
    expect(c.points.map((p) => p.s)).toEqual([0, 5, 5 + Math.hypot(7, 6)]);
  });
});

describe('u and heading are written, and every view reads the one written', () => {
  it('a written heading reads the same on the points and on the curve, and turns the frame', () => {
    const m = ring().points.set('heading', (p) => p.index * 0.5);
    const c = m.curves.at(0);
    for (const p of c.points) {
      expect(p.heading).toBe(m.points.at(p.index).heading);
      expect(p.heading).toBe(p.index * 0.5);
    }
    const q = c.points.at(1);
    expect(q.tangent).toEqual([Math.cos(0.5), Math.sin(0.5)]);
    expect(m.points.at(1).tangent).toEqual(q.tangent);
    expect(m.points.at(1).placement().point([1, 0])).toEqual(q.placement().point([1, 0]));
  });

  it('a written u reads the same on the points and on the curve', () => {
    const m = ring().points.set('u', 0.25);
    expect(m.points.map((p) => p.u)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(m.curves.at(0).points.map((p) => p.u)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});

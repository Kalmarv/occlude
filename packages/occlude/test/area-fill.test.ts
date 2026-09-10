import { describe, expect, it } from 'vitest';
import { areaFill } from '../src/area.js';
import { material, withinMaterial } from '../src/material.js';

type Loop = [number, number][];
const box = (x0: number, y0: number, x1: number, y1: number): Loop =>
  [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function trim(loops: Loop[], y: number, rule: 'nonzero' | 'evenodd' = 'nonzero') {
  const fill = areaFill(loops, rule);
  const out = withinMaterial(material([[0, y], [100, y]], { edges: [[0, 1]] }), loops,
    { inside: fill.at, crossings: fill.crossings });
  return Array.from({ length: out.edgeCount }, (_, e) =>
    [out.x[out.edgeList[2 * e]], out.x[out.edgeList[2 * e + 1]]]);
}

describe('filled areas with intersections and coincident contours', () => {
  it('splits a segment where overlapping loops change its boundary status', () => {
    const loops = [box(10, 10, 70, 70), box(40, 40, 90, 90)];
    expect(trim(loops, 20)).toEqual([[10, 70]]);
    expect(trim(loops, 50)).toEqual([[10, 90]]);
    const fill = areaFill(loops, 'nonzero');
    expect(fill.at(70, 20)).toBe(0);
    expect(fill.at(70, 50)).toBeGreaterThan(0);
  });

  it('retains the boundary of same-direction duplicate contours', () => {
    const a = box(10, 10, 70, 70);
    expect(trim([a, a], 20)).toEqual([[10, 70]]);
    expect(areaFill([a, a], 'nonzero').at(40, 10)).toBe(0);
  });

  it('removes opposite-direction contours, including points on their edges', () => {
    const a = box(10, 10, 70, 70);
    const loops = [a, [...a].reverse()];
    expect(trim(loops, 20)).toEqual([]);
    expect(areaFill(loops, 'nonzero').at(40, 10)).toBeLessThan(0);
  });

  it('cancels duplicate contours under even-odd, including their former boundary', () => {
    const a = box(10, 10, 70, 70);
    expect(trim([a, a], 20, 'evenodd')).toEqual([]);
    expect(areaFill([a, a], 'evenodd').at(40, 10)).toBeLessThan(0);
  });

  it.each(['nonzero', 'evenodd'] as const)('removes a shared partial wall under %s', (rule) => {
    const loops = [box(10, 10, 50, 70), box(50, 30, 90, 50)];
    expect(trim(loops, 40, rule)).toEqual([[10, 90]]);
    const fill = areaFill(loops, rule);
    expect(fill.at(50, 40)).toBeGreaterThan(0);
    expect(fill.at(50, 20)).toBe(0);
  });

  it('handles a self-intersection at the source segment midpoint', () => {
    const bow: Loop = [[10, 10], [90, 90], [10, 90], [90, 10]];
    expect(trim([bow], 30)).toEqual([[30, 70]]);
    expect(trim([bow], 70)).toEqual([[30, 70]]);
  });

  it('does not depend on contour subdivision or orientation', () => {
    const a: Loop = [[10, 10], [40, 10], [70, 10], [70, 70], [10, 70]];
    const b = box(40, 40, 90, 90);
    for (const loops of [[a, b], [[...a].reverse(), [...b].reverse()], [b, a]]) {
      expect(trim(loops, 20)).toEqual([[10, 70]]);
      expect(trim(loops, 50)).toEqual([[10, 90]]);
    }
  });

  it('clips slanted intersections after an affine change of coordinates', () => {
    const transform = ([x, y]: [number, number]): [number, number] => [3 * x + y + 1234, x + 2 * y - 987];
    const loops = [box(10, 10, 70, 70), box(40, 40, 90, 90)].map((l) => l.map(transform));
    const fill = areaFill(loops, 'nonzero');
    for (const [y, end] of [[20, 70], [50, 90]]) {
      const input = material([transform([0, y]), transform([100, y])], { edges: [[0, 1]] });
      const out = withinMaterial(input, loops, { inside: fill.at, crossings: fill.crossings });
      expect(out.edgeCount).toBe(1);
      for (const [row, x] of [[0, 10], [1, end]]) {
        const expected = transform([x, y]);
        expect(out.x[row]).toBeCloseTo(expected[0], 9);
        expect(out.y[row]).toBeCloseTo(expected[1], 9);
      }
    }
  });
});

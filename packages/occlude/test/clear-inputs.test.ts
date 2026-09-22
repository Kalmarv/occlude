/**
 * Clear inputs: the point forms of `line` and `circle`, and the named
 * travel-time sources.
 *
 * Two questions here. Does a point spelled as a pair or a record make the
 * SAME shape as the same point spelled as coordinates — in all three
 * geometries, because a shape is lowered by the frame and the frame is
 * what a space changes? And does a named source say what the inferred one
 * could only guess: `fromPoints` is one seed per entry, `fromArea` is one
 * area, and the old positional form is gone — a source where the options
 * record goes is refused by name.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { circle, line, space, type Execution, type ShapeValue, type Toolkit } from '../src/index.js';

type Kit = Toolkit & { exec: Execution };

const WORLDS: { name: string; make: () => Kit }[] = [
  { name: 'the flat plane', make: () => toolkit({ aspect: [1, 1] }) },
  { name: 'the disk', make: () => toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) }) },
  { name: 'the sphere', make: () => toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) }) },
];

/** A shape through the material door: the points the engine would draw. */
const lowered = (t: Kit, sv: ShapeValue): [number, number][] =>
  t.material(sv).points.map((p) => [p.x, p.y]);

describe('line and circle take points', () => {
  for (const world of WORLDS) {
    it(`lowers the record forms exactly as the positional ones in ${world.name}`, () => {
      const t = world.make();
      expect(lowered(t, line([38, 42], [61, 57]))).toEqual(lowered(t, line(38, 42, 61, 57)));
      expect(lowered(t, line({ x: 38, y: 42 }, { x: 61, y: 57 }))).toEqual(lowered(t, line(38, 42, 61, 57)));
      // A pair and a record are the same point, so the two spellings may
      // be mixed in one call.
      expect(lowered(t, line([38, 42], { x: 61, y: 57 }))).toEqual(lowered(t, line(38, 42, 61, 57)));
      expect(lowered(t, circle([44, 53], 17))).toEqual(lowered(t, circle(44, 53, 17)));
      expect(lowered(t, circle({ x: 44, y: 53 }, 17))).toEqual(lowered(t, circle(44, 53, 17)));
    });

    it(`takes a station as a point in ${world.name}`, () => {
      const t = world.make();
      const start = t.station(44, 53);
      const tip = start.step(9);
      expect(lowered(t, line(start, tip))).toEqual(lowered(t, line(start.x, start.y, tip.x, tip.y)));
      expect(lowered(t, circle(start, 6))).toEqual(lowered(t, circle(start.x, start.y, 6)));
    });
  }

  it('makes the same shape value, so the ink is the same ink', () => {
    expect(line([1, 2], [3, 4])).toEqual(line(1, 2, 3, 4));
    expect(circle([1, 2], 3)).toEqual(circle(1, 2, 3));
    // The options ride on the record form as they do on the other.
    expect(line([1, 2], [3, 4], { pen: 'ink' })).toEqual(line(1, 2, 3, 4, { pen: 'ink' }));
    expect(circle([1, 2], 3, { pen: 'ink' })).toEqual(circle(1, 2, 3, { pen: 'ink' }));
  });
});

describe('travelTime names its source', () => {
  const PAIRS: [number, number][] = [[20, 50], [80, 50]];

  it('reads every entry of fromPoints as a seed, and fromArea as one loop', () => {
    const t = toolkit({ aspect: [1, 1] });
    const seeds = t.travelTime({ fromPoints: PAIRS });
    const loop = t.travelTime({ fromArea: PAIRS });
    // Both arrive at the ends at once.
    expect(seeds(20, 50)).toBeCloseTo(0, 6);
    expect(loop(20, 50)).toBeCloseTo(0, 6);
    // The middle tells them apart: the loop is the segment between the two
    // pairs and has already arrived there; the seeds are two points and the
    // front has half the span to cross.
    expect(loop(50, 50)).toBeLessThan(1);
    expect(seeds(50, 50)).toBeGreaterThan(25);
  });

  it('reads a record and a pair the same way under fromPoints', () => {
    const t = toolkit({ aspect: [1, 1] });
    const pairs = t.travelTime({ fromPoints: PAIRS });
    const records = t.travelTime({ fromPoints: PAIRS.map(([x, y]) => ({ x, y })) });
    for (const [x, y] of [[50, 50], [30, 70], [64, 22]]) {
      expect(records(x, y)).toBeCloseTo(pairs(x, y), 6);
    }
  });

  it('takes a shape under fromArea, as the material door lowers it', () => {
    const t = toolkit({ aspect: [1, 1] });
    const shape = t.travelTime({ fromArea: circle(50, 50, 20) });
    const lowered = t.travelTime({ fromArea: t.material(circle(50, 50, 20)) });
    for (const [x, y] of [[50, 50], [12, 12], [88, 50]]) {
      expect(shape(x, y)).toBeCloseTo(lowered(x, y), 6);
    }
    expect(shape(50, 50)).toBe(0);
  });

  it('is the old positional form no more: a source where the record goes is refused by name', () => {
    const t = toolkit({ aspect: [1, 1] });
    const square: [number, number][] = [[30, 30], [70, 30], [70, 70], [30, 70]];
    const refusal = /travelTime: the source goes in the options record — t\.travelTime\(\{ fromPoints \}\) or t\.travelTime\(\{ fromArea \}\)/;
    expect(() => t.travelTime(PAIRS as never)).toThrow(refusal);
    expect(() => t.travelTime([{ x: 20, y: 50 }] as never)).toThrow(refusal);
    expect(() => t.travelTime(circle(50, 50, 20) as never)).toThrow(refusal);
    expect(() => t.travelTime(t.material(circle(50, 50, 20)) as never)).toThrow(refusal);
    expect(() => t.travelTime({ pts: square, closed: true } as never)).toThrow(refusal);
    expect(() => t.travelTime(42 as never)).toThrow(refusal);
    // The options record as the second argument of the old form, too.
    expect(() => (t.travelTime as (...a: unknown[]) => unknown)(square, { speed: 2 })).toThrow(refusal);
  });

  it('refuses both sources and neither, by name', () => {
    const t = toolkit({ aspect: [1, 1] });
    expect(() => t.travelTime({ fromPoints: PAIRS, fromArea: PAIRS })).toThrow(/travelTime: give fromPoints or fromArea/);
    expect(() => t.travelTime({ speed: 2 })).toThrow(/travelTime: give fromPoints or fromArea/);
  });

  it('carries the other options through the named form', () => {
    const t = toolkit({ aspect: [1, 1] });
    const fast = t.travelTime({ fromPoints: [[20, 50]], speed: 2 });
    const slow = t.travelTime({ fromPoints: [[20, 50]] });
    expect(fast(70, 50)).toBeCloseTo(slow(70, 50) / 2, 4);
  });
});

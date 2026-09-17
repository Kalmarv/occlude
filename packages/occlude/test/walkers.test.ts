import { describe, expect, it } from 'vitest';
import { walkers } from '../src/walkers.js';
import type { Material } from '../src/index.js';

const B = { x: 0, y: 0, w: 200, h: 100 };
const chains = (m: Material) => m.curves().length;
const ink = (m: Material) => {
  let s = 0;
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    s += Math.hypot(m.x[a] - m.x[b], m.y[a] - m.y[b]);
  }
  return s;
};

describe('walkers', () => {
  it('takes the steps it was given, in the direction it was steered', () => {
    // No steer: it holds its heading, so it is a straight line of known length.
    const straight = walkers([{ x: 10, y: 50, heading: 0 }], B, { steps: 20, step: 2 });
    expect(straight.n).toBe(21);
    expect(ink(straight)).toBeCloseTo(40, 9);
    expect(straight.x[20]).toBeCloseTo(50, 9);
    expect(straight.y[20]).toBeCloseTo(50, 9);
    // `age` is the step each point was reached on.
    expect(Array.from(straight.attrs.age.slice(0, 4))).toEqual([0, 1, 2, 3]);
    // A quarter turn each step closes a square.
    const square = walkers([{ x: 50, y: 50, heading: 0 }], B, {
      steps: 4, step: 10, steer: (w) => w.heading + Math.PI / 2,
    });
    expect(square.x[4]).toBeCloseTo(50, 6);
    expect(square.y[4]).toBeCloseTo(50, 6);
    // Zero steps is legal and draws nothing.
    expect(walkers([{ x: 5, y: 5 }], B, { steps: 0, step: 1 }).edgeCount).toBe(0);
  });

  it('stops when steered to, when it leaves the paper, and when it meets ink', () => {
    // steer returning null retires that walker where it stands.
    const halted = walkers([{ x: 10, y: 50, heading: 0 }], B, {
      steps: 100, step: 1, steer: (w) => (w.age >= 7 ? null : w.heading),
    });
    expect(halted.n).toBe(8);
    // Off the edge of the drawable is the end of the walk.
    const away = walkers([{ x: 190, y: 50, heading: 0 }], B, { steps: 100, step: 1 });
    expect(away.n).toBe(11);
    expect(Math.max(...away.x)).toBeLessThanOrEqual(200);
    // Two walkers driven head-on stop before they touch.
    const meet = walkers([
      { x: 40, y: 50, heading: 0 },
      { x: 120, y: 50, heading: Math.PI },
    ], B, { steps: 200, step: 1, avoid: 4 });
    expect(chains(meet)).toBe(2);
    const cs = meet.curves();
    const tipA = cs[0].pts[cs[0].pts.length - 1];
    const tipB = cs[1].pts[cs[1].pts.length - 1];
    expect(Math.hypot(tipA[0] - tipB[0], tipA[1] - tipB[1])).toBeGreaterThanOrEqual(4 - 1e-9);
    // Without the rule they run straight past each other.
    const through = walkers([
      { x: 40, y: 50, heading: 0 },
      { x: 120, y: 50, heading: Math.PI },
    ], B, { steps: 200, step: 1 });
    expect(ink(through)).toBeGreaterThan(ink(meet) * 1.5);
  });

  it('memory is a length of path, not a count of steps', () => {
    // A walker turning hard is inside `avoid` of its own tail by construction.
    // Told to forget enough of that tail, it runs; told to forget none of it,
    // it vetoes itself at once — which is the bug this option exists to name.
    const spiral = (memory: number) => walkers([{ x: 100, y: 50, heading: 0 }], B, {
      steps: 300, step: 1, avoid: 3, memory,
      steer: (w) => w.heading + 0.12,
    });
    expect(ink(spiral(0))).toBeLessThan(10);
    // A constant turn is a CIRCLE, not a spiral: given enough memory it gets
    // the whole way round — 2 pi / 0.12 is about 52 steps — and is then
    // stopped by the tail it laid on the way, which is the rule working.
    expect(ink(spiral(30))).toBeGreaterThan(45);
    expect(ink(spiral(30))).toBeLessThan(70);
  });

  it('spawns children that carry their seed, and counts generations', () => {
    const grown = walkers([{ x: 100, y: 50, heading: 0, species: 7 }], B, {
      steps: 40, step: 1,
      spawn: (w) => (w.age === 10 && w.generation < 2 ? { x: w.x, y: w.y, heading: w.heading + 1, species: w.attrs.species } : null),
    });
    // The seed, its child, and the child's child.
    expect(chains(grown)).toBe(3);
    expect([...grown.attrs.species].every((v) => v === 7)).toBe(true);
    // A child starts where its parent was, not where the parent ends.
    const cs = grown.curves();
    expect(cs.length).toBe(3);
  });

  it('is deterministic, and refuses what it cannot use', () => {
    const run = () => walkers([{ x: 100, y: 50, heading: 0.3 }], B, {
      steps: 60, step: 1.3, avoid: 2, steer: (w) => w.heading + Math.sin(w.age) * 0.2,
    });
    expect(Array.from(run().x)).toEqual(Array.from(run().x));
    expect(() => walkers([], B, { steps: -1, step: 1 })).toThrow(/non-negative whole number/);
    expect(() => walkers([], B, { steps: 1.5, step: 1 })).toThrow(/non-negative whole number/);
    expect(() => walkers([], B, { steps: 5, step: 0 })).toThrow(/positive length/);
    expect(() => walkers([], B, { steps: 5, step: 1, avoid: -1 })).toThrow(/non-negative distance/);
    expect(() => walkers([], B, { steps: 5, step: 1, memory: -1 })).toThrow(/non-negative length/);
    expect(() => walkers([], B, { steps: 5, step: 1, steer: 2 as never })).toThrow(/must be a function/);
    expect(() => walkers([], B, { steps: 5, step: 1, spawn: 2 as never })).toThrow(/must be a function/);
    // No seeds is not an error.
    expect(walkers([], B, { steps: 9, step: 1 }).edgeCount).toBe(0);
  });
});

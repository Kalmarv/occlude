/**
 * An edge answers what a vertex answers.
 *
 * A Vertex has `x`, `y`, `adjacent` and `edges`; a Face has `area`,
 * `perimeter`, `centroid` and `bounds`. An Edge had `length` and its two
 * ends, so the ordinary moves — stamp a motif on a wall, ask which walls
 * touch this one, give a wall its own rest length — had to be written by
 * hand out of `e.a` and `e.b`.
 */
import { describe, expect, it } from 'vitest';
import { curve, material, connect, type Edge } from '../src/material.js';
import { tension } from '../src/forces.js';

const chain = () => curve([[0, 0], [20, 0], [40, 0], [60, 0]], { closed: false });

describe('e.center', () => {
  it('is the middle of the wall, as a fresh pair', () => {
    const m = chain();
    expect(m.edges.at(0).center).toEqual([10, 0]);
    expect(m.edges.at(2).center).toEqual([50, 0]);
  });

  it('is a new pair every time, so nothing downstream can write through it', () => {
    const m = chain();
    const one = m.edges.at(0).center;
    one[0] = 999;
    expect(m.edges.at(0).center).toEqual([10, 0]);
  });

  it('composes: a mark at the middle of every wall', () => {
    const m = chain();
    expect([...m.edges].map((e) => e.center[0])).toEqual([10, 30, 50]);
  });
});

describe('e.adjacent', () => {
  it('is the edges sharing a vertex with this one, itself excluded', () => {
    const m = chain();
    expect(m.edges.at(1).adjacent.indices).toEqual([0, 2]);
    expect(m.edges.at(0).adjacent.indices).toEqual([1]);
  });

  it('names a neighbour once, even when both ends meet it', () => {
    // Two vertices joined by two edges would name each other twice without
    // the set; a triangle is the honest small case.
    const tri = curve([[0, 0], [10, 0], [5, 9]], { closed: true });
    expect(tri.edges.at(0).adjacent.length).toBe(2);
  });

  it('is a selection, so it filters, draws and composes', () => {
    const m = chain();
    expect(m.edges.at(1).adjacent.filter((e) => e.index > 0).indices).toEqual([2]);
    expect(m.edges.at(1).adjacent.points.indices).toEqual([0, 1, 2, 3]);
  });

  it('a loose edge has no neighbours', () => {
    const lone = material([[0, 0], [1, 0], [5, 5], [6, 5]]).withEdges([[0, 1], [2, 3]]);
    expect(lone.edges.at(0).adjacent.length).toBe(0);
  });
});

describe('edges.edges', () => {
  it('is itself, so every geometry value answers the word', () => {
    const m = chain();
    const sel = m.edges.filter((e) => e.index > 0);
    expect(sel.edges).toBe(sel);
    expect(sel.edges.indices).toEqual([1, 2]);
  });
});

describe('force.tension with a rest per edge', () => {
  it('reads the edge, not either end', () => {
    const m = chain().edgeAttribute('rest', (e) => (e.index === 0 ? 5 : 100));
    const pull = tension(m, { rest: (e: Edge) => e.attrs.rest });
    // Vertex 1 sits 20 from each neighbour. Its left edge rests at 5, so it
    // is pulled 15 toward vertex 0; its right edge rests at 100 and is
    // slack, so it pulls nothing.
    expect(pull(m.points.at(1)).map(Math.round)).toEqual([-15, 0]);
  });

  it('one number is what it always was', () => {
    const m = chain();
    const flat = tension(m, { rest: 5 });
    const same = tension(m, { rest: () => 5 });
    for (const p of m.points) expect(same(p)).toEqual(flat(p));
  });

  it('a rest that is not a length slackens that edge rather than tearing it', () => {
    const m = chain();
    const pull = tension(m, { rest: () => NaN });
    // Rest zero: every gap counts, and vertex 1 is pulled both ways equally.
    expect(pull(m.points.at(1)).map(Math.round)).toEqual([0, 0]);
  });

  it('refuses a rest that is neither a length nor a function', () => {
    expect(() => tension(chain(), { rest: 'far' as never })).toThrow(/a length, or a function of the edge/);
  });

});

describe('edges.near', () => {
  it('measures the whole segment, not an end and not the middle', () => {
    // One long wall. A place 1 away from its middle is 1 away from the
    // wall, though it is 50 from either end and would fail a midpoint-only
    // or endpoint-only test at a small radius.
    const long = material([[0, 0], [100, 0]]).withEdges([[0, 1]]);
    expect(long.edges.near([50, 1], { radius: 2 }).length).toBe(1);
    expect(long.edges.near([50, 3], { radius: 2 }).length).toBe(0);
    // Past the end it is the end that answers, not the infinite line.
    expect(long.edges.near([103, 0], { radius: 2 }).length).toBe(0);
    expect(long.edges.near([101, 0], { radius: 2 }).length).toBe(1);
  });

  it('is strict at the bound, as points.near is', () => {
    const long = material([[0, 0], [100, 0]]).withEdges([[0, 1]]);
    expect(long.edges.near([50, 2], { radius: 2 }).length).toBe(0);
  });

  it('answers in source order, and with its own members only', () => {
    const m = curve([[0, 0], [10, 0], [20, 0], [30, 0]], { closed: false });
    expect(m.edges.near([15, 0], { radius: 20 }).indices).toEqual([0, 1, 2]);
    const right = m.edges.filter((e) => e.index >= 1);
    expect(right.near([15, 0], { radius: 20 }).indices).toEqual([1, 2]);
  });

  it('refuses a radius that is not a distance', () => {
    const m = curve([[0, 0], [10, 0]], { closed: false });
    expect(() => m.edges.near([0, 0], { radius: 0 })).toThrow(/positive distance/);
  });
});

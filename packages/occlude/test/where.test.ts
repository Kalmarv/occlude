/**
 * `where`: the part of a material an operation may touch.
 *
 * It names the ELIGIBLE region, not a promise that every row it names is
 * changed — the operation's own rule still applies on top. A selection is
 * read through the protocol, so either domain may be given and the verb
 * reads the one it consumes.
 */
import { describe, expect, it } from 'vitest';
import { curve, material } from '../src/material.js';

const chain = () => curve([[0, 0], [20, 0], [40, 0], [60, 0], [80, 0], [100, 0]], { closed: false });
const cage = {
  from: [[0, -10], [100, -10], [100, 10], [0, 10]] as [number, number][],
  to: [[0, -10], [100, -10], [100, 30], [0, 30]] as [number, number][],
};

describe('where', () => {
  it('keeps it ONE material: the part that moves and the part that does not', () => {
    const m = chain();
    const out = m.warp({ ...cage, where: m.points.filter((p) => p.x > 45) });
    // The whole chain is still here. This is the reason `where` exists:
    // filter-and-extract would hand back a detached piece with the joining
    // edge gone.
    expect(out.n).toBe(6);
    expect(out.edgeCount).toBe(5);
    expect(out.pts.map((p) => Math.round(p[1]))).toEqual([0, 0, 0, 10, 10, 10]);
  });

  it('a point selection is read as the edges AMONG its members', () => {
    // The ruling: `where` inherits the meaning a selection already has.
    // `strokes(sel)` draws the edges among the members, `sel.extract()`
    // keeps only those, and so does this.
    const m = chain();
    const inner = m.points.filter((p) => p.index >= 3 && p.index <= 5);
    expect(inner.edges.indices).toEqual([3, 4]);
    // …and the wider span has its own name, for when that is what is wanted.
    expect(inner.edges.adjacent().indices).toEqual([2]);
  });

  it('an edge selection given to a point verb is read as its endpoints', () => {
    const m = chain();
    const out = m.warp({ ...cage, where: m.edges.filter((e) => e.index >= 3) });
    expect(out.pts.map((p) => Math.round(p[1]))).toEqual([0, 0, 0, 10, 10, 10]);
  });

  it('snap looks for a better place only where it may', () => {
    const m = chain();
    const out = m.snap((x, y) => -Math.abs(y - 5), { radius: 6, where: m.points.filter((p) => p.x > 45) });
    expect(out.pts.map((p) => Math.round(p[1]))).toEqual([0, 0, 0, 5, 5, 5]);
  });

  it('absent is the whole material, as it always was', () => {
    const m = chain();
    expect(m.warp(cage).pts).toEqual(m.warp({ ...cage, where: m.points.filter(() => true) }).pts);
  });

  it('refuses a selection of another material, by name', () => {
    const m = chain();
    const other = material([[0, 0], [1, 1]]).points.filter(() => true);
    expect(() => m.warp({ ...cage, where: other })).toThrow(/selection of another material/);
    expect(() => m.snap(() => 1, { radius: 1, where: other })).toThrow(/selection of another material/);
  });

  it('refuses a thing that is not a selection', () => {
    const m = chain();
    expect(() => m.warp({ ...cage, where: [1, 2] as never })).toThrow(/point selection or an edge selection/);
  });
});

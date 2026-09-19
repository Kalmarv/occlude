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

describe('where, on resample', () => {
  it('redistributes a run and keeps the two vertices at its ends', () => {
    const m = chain();
    // Edges 3 and 4 — the ruling: a point selection means the edges with
    // BOTH ends in it.
    const out = m.resample({ count: 5, where: m.points.filter((p) => p.index >= 3) });
    expect(out.pts.map((p) => Math.round(p[0]))).toEqual([0, 20, 40, 60, 70, 80, 90, 100]);
    expect(out.edgeCount).toBe(7);
  });

  it('count is per RUN, because a run is what gets redistributed', () => {
    const m = chain();
    const ends = m.edges.filter((e) => e.index === 0 || e.index === 4);
    const out = m.resample({ count: 3, where: ends });
    // Two runs of one edge each, three vertices apiece, and the middle of
    // the chain untouched.
    expect(out.pts.map((p) => Math.round(p[0]))).toEqual([0, 10, 20, 40, 60, 80, 90, 100]);
  });

  it('the untouched part keeps its identity, and the new part is new', () => {
    const m = chain();
    const kept = m.points.filter((p) => p.index <= 3);
    const out = m.resample({ count: 5, where: m.points.filter((p) => p.index >= 3) });
    // Every vertex the resample did not touch answers in the new state.
    expect(kept.in(out).length).toBe(4);
    expect([...out.pointIds].slice(0, 4)).toEqual([...m.pointIds].slice(0, 4));
    // …and the run's far end is the same vertex it always was.
    expect(out.pointOf(m.points.at(5).id)).toBeDefined();
    // The interior is minted: it is not any vertex of the old state.
    const old = new Set([...m.pointIds]);
    expect([...out.pointIds].filter((id) => !old.has(id)).length).toBe(3);
  });

  it('a new edge takes the lineage root of the edge it came from', () => {
    const m = chain();
    const out = m.resample({ count: 5, where: m.edges.filter((e) => e.index === 4) });
    // Five vertices over the one eligible edge is four edges, and all four
    // descend from it.
    const root = m.edgeRoots[4];
    expect([...out.edgeRoots].filter((r) => r === root).length).toBe(4);
    // The kept edges keep both their id and their root.
    expect([...out.edgeIds].slice(0, 4)).toEqual([...m.edgeIds].slice(0, 4));
  });

  it('an edge column comes through a kept edge verbatim', () => {
    const m = chain().edgeAttribute('tag', (e) => e.index * 10);
    const out = m.resample({ count: 3, where: m.edges.filter((e) => e.index === 4) });
    expect([...out.edgeAttrs.tag].slice(0, 4)).toEqual([0, 10, 20, 30]);
    // The run's own edges take the value of the edge under each middle.
    expect([...out.edgeAttrs.tag].slice(4)).toEqual([40, 40]);
  });

  it('a ring stays a ring when only part of it is eligible', () => {
    const ring = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    const out = ring.resample({ count: 4, where: ring.edges.filter((e) => e.index === 0) });
    expect(out.closed).toBe(true);
    expect(out.n).toBe(out.edgeCount);
    // The three edges it did not touch are still there, corner for corner.
    expect(out.pts).toContainEqual([10, 0]);
    expect(out.pts).toContainEqual([10, 10]);
    expect(out.pts).toContainEqual([0, 10]);
  });

  it('every edge eligible is the whole resample, exactly', () => {
    const m = chain();
    expect(m.resample({ count: 9, where: m.edges.filter(() => true) }).pts).toEqual(m.resample({ count: 9 }).pts);
    const ring = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    expect(ring.resample({ count: 9, where: ring.edges.filter(() => true) }).pts).toEqual(ring.resample({ count: 9 }).pts);
  });

  it('refuses a selection of another material, by name', () => {
    const m = chain();
    const other = material([[0, 0], [1, 1]]).points.filter(() => true);
    expect(() => m.resample({ count: 3, where: other })).toThrow(/selection of another material/);
  });
});

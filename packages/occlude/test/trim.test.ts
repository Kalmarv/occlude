/**
 * `m.trim({ start, end })`: cut a length off each open chain's two ends.
 *
 * Gaps where strokes meet, a taper that starts short of a corner, a chain
 * that grows out from its middle — all of them are this, and all of them
 * were written by hand.
 */
import { describe, expect, it } from 'vitest';
import { curve, material } from '../src/material.js';

/** 0 → 40 along x, a vertex every 10. */
const chain = () => curve([[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]], { closed: false });

describe('m.trim', () => {
  it('cuts by arc length from each end', () => {
    const out = chain().trim({ start: 5, end: 12 });
    expect(out.pts).toEqual([[5, 0], [10, 0], [20, 0], [28, 0]]);
    expect(out.edgeCount).toBe(3);
  });

  it('a cut that lands on a vertex ends there, and does not double it', () => {
    const out = chain().trim({ start: 10, end: 10 });
    expect(out.pts).toEqual([[10, 0], [20, 0], [30, 0]]);
  });

  it('one end alone', () => {
    expect(chain().trim({ start: 7 }).pts[0]).toEqual([7, 0]);
    expect(chain().trim({ end: 7 }).pts.at(-1)).toEqual([33, 0]);
  });

  it('nothing left is nothing drawn, not an error', () => {
    expect(chain().trim({ start: 25, end: 25 }).n).toBe(0);
    expect(chain().trim({ start: 40 }).n).toBe(0);
  });

  it('a ring has no ends, so it comes through whole', () => {
    const ring = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    const out = ring.trim({ start: 3, end: 3 });
    expect(out.pts).toEqual(ring.pts);
    expect(out.closed).toBe(true);
  });

  it('the vertices between the cuts are the SAME vertices', () => {
    const m = chain();
    const out = m.trim({ start: 5, end: 5 });
    // 10, 20 and 30 survive untouched; the two ends are new.
    expect([...out.pointIds].slice(1, 4)).toEqual([...m.pointIds].slice(1, 4));
    const old = new Set([...m.pointIds]);
    expect([...out.pointIds].filter((id) => !old.has(id)).length).toBe(2);
    // The two whole edges keep their ids; the two cut ones are children.
    expect([...out.edgeIds].filter((id) => [...m.edgeIds].includes(id)).length).toBe(2);
  });

  it('a cut edge keeps the lineage of the edge it came from', () => {
    const m = chain();
    const out = m.trim({ start: 5 });
    expect(out.edgeRoots[0]).toBe(m.edgeRoots[0]);
  });

  it('columns blend at a new end, and carry verbatim at an old one', () => {
    const m = chain().attribute('t', (p) => p.index * 10);
    const out = m.trim({ start: 5, end: 5 });
    // The new head sits halfway along edge 0: (0 + 10) / 2.
    expect([...out.attrs.t]).toEqual([5, 10, 20, 30, 35]);
  });

  it('an edge column comes across from the edge each piece sits on', () => {
    const m = chain().edgeAttribute('w', (e) => e.index);
    expect([...m.trim({ start: 5, end: 5 }).edgeAttrs.w]).toEqual([0, 1, 2, 3]);
  });

  it('every chain is cut on its own, and a loose vertex is not a chain', () => {
    const two = material(
      [[0, 0], [40, 0], [0, 20], [20, 20], [0, 40]],
      { edges: [[0, 1], [2, 3]] },
    );
    const out = two.trim({ start: 5 });
    expect(out.pts).toEqual([[5, 0], [40, 0], [5, 20], [20, 20]]);
  });

  it('zero is the material, and a bad length is refused by name', () => {
    const m = chain();
    expect(m.trim({}).pts).toEqual(m.pts);
    expect(() => m.trim({ start: -1 })).toThrow(/must not be negative/);
    expect(() => m.trim({ start: NaN })).toThrow(/finite length/);
  });

  it('refuses a junction, as along and resample do', () => {
    const y = material([[0, 0], [10, 0], [20, 5], [20, -5]], { edges: [[0, 1], [1, 2], [1, 3]] });
    expect(() => y.trim({ start: 1 })).toThrow(/junction — chains only/);
  });
});

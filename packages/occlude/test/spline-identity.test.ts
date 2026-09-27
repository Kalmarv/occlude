/**
 * spline keeps who its vertices are.
 *
 * The curve passes THROUGH every source vertex, so each one is the same
 * point after the call: same row, same position, same columns. A value or a
 * selection the sketch holds still names it, in a read and in a write. Only
 * the samples between two source vertices are new, and each answers the
 * input edge it bends over as its `source` — the rule `resample` keeps for
 * its ends and seam, here for every vertex it passes through.
 */
import { describe, expect, it } from 'vitest';
import { curve, material, type Material } from '../src/material.js';
import { xy } from './helpers/xy.js';

const open = (): Material =>
  curve([[0, 0], [10, 20], [20, 0], [30, 20], [40, 0]], { closed: false }).points.set('w', (p) => p.index + 1);
const ring = (): Material => curve([[0, 0], [20, 0], [20, 20], [0, 20]], { closed: true });

describe('spline keeps its source vertices', () => {
  it('an open chain keeps its two ends', () => {
    const src = open();
    const out = src.spline({ steps: 4 });
    expect(out.points.has(src.points.at(0))).toBe(true);
    expect(out.points.has(src.points.at(-1))).toBe(true);
  });

  it('a ring keeps its seam', () => {
    const src = ring();
    const out = src.spline({ steps: 3 });
    expect(out.points.has(src.points.at(0))).toBe(true);
  });

  it('every source vertex is the same point, where it was, with its columns', () => {
    for (const src of [open(), ring()]) {
      const out = src.spline({ steps: 5 });
      for (const p of src.points) expect(out.points.has(p)).toBe(true);
      // The input's points, read in the new state: all of them, each where
      // it was, each with the column it had.
      const same = out.points.intersect(src.points);
      expect(same.length).toBe(src.points.length);
      expect(same.map(xy)).toEqual(src.points.map(xy));
      expect(same.map((p) => p.w)).toEqual(src.points.map((p) => p.w));
      // Everything else is new: the samples between the source vertices.
      expect(out.points.length - same.length).toBe(src.edges.length * 4);
    }
  });

  it('a write through a held source vertex lands on it', () => {
    const src = open();
    const held = src.points.at(2);
    const out = src.spline({ steps: 4 });
    const moved = out.move([0, 5], held);
    expect(moved.points.intersect(src.points).map(xy)).toEqual([[0, 0], [10, 20], [20, 5], [30, 20], [40, 0]]);
    // Nothing else moved.
    expect(moved.points.map(xy).filter((q, i) => q[1] !== out.points.at(i).y).length).toBe(1);
  });

  it('a sample between two source vertices answers the input edge it bends over', () => {
    const src = open();
    const out = src.spline({ steps: 4 });
    // Walk order: source vertex, three samples, source vertex, …
    for (let s = 0; s < src.edges.length; s++) {
      for (let i = 1; i < 4; i++) expect(out.points.at(4 * s + i).source).toBe(src.edges.at(s));
    }
    // A source vertex is the row it was, and says nothing new.
    for (const p of out.points.intersect(src.points)) expect(p.source).toBeUndefined();
    // Every new edge answers the source edge it is a piece of.
    for (let k = 0; k < out.edges.length; k++) expect(out.edges.at(k).source).toBe(src.edges.at(Math.floor(k / 4)));
  });

  it('a selection\'s spline answers edges of the material the selection is of', () => {
    const src = open();
    const out = src.edges.filter((e) => e.index > 0).spline({ steps: 2 });
    // Walk order from the first selected edge: source vertex, sample, source vertex, …
    expect(out.points.at(1).source).toBe(src.edges.at(1));
    expect(out.points.at(3).source).toBe(src.edges.at(2));
    expect(out.edges.at(0).source).toBe(src.edges.at(1));
  });

  it('a new sample reads its columns between its two source vertices; an edge column comes through', () => {
    const src = open().edges.set('tag', (e) => 10 * e.index);
    const out = src.spline({ steps: 2 });
    // w = 1..5 on the source vertices; each sample is half-way between.
    expect(out.points.map((p) => p.w)).toEqual([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
    expect(out.edges.map((e) => e.tag)).toEqual([0, 0, 10, 10, 20, 20, 30, 30]);
  });

  it('a network junction is kept, and every chain still meets there', () => {
    const y = material([[10, 12], [50, 50], [90, 12], [50, 92], [20, 80]], { edges: [[0, 1], [1, 2], [1, 3], [3, 4]] });
    const out = y.spline({ steps: 4 });
    for (const p of y.points) expect(out.points.has(p)).toBe(true);
    const fork = out.points.intersect(y.points.filter((p) => p.edges.length === 3));
    expect(fork.length).toBe(1);
    expect(xy(fork.at(0))).toEqual([50, 50]);
    expect(fork.at(0).edges.length).toBe(3);
  });

  it('a chain of fewer than three vertices comes through as it was', () => {
    const src = curve([[0, 0], [10, 10]], { closed: false });
    const out = src.spline();
    expect(out.points.intersect(src.points).length).toBe(2);
    expect(out.edges.intersect(src.edges).length).toBe(1);
  });
});

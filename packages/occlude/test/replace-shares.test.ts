/**
 * A replace costs what it touches. It finds a point already at a motif's
 * place through the state's own position leaves, not a pass over every
 * row, so a run of replaces on a large value is a run of small writes —
 * and a motif point that lands on a point already there IS that point, on
 * a value of any size and any row order, whether the replace swaps a few
 * edges or every edge.
 */

import { describe, expect, it } from 'vitest';
import { curve, material, type Material } from '../src/material.js';

/** `k × k` unit squares, each a counter-clockwise ring on its own, 2 apart,
 * and — with `centres` — a lone point at the middle of each. The rows are
 * in a scrambled order, so no run of rows sits in one place; the centres
 * of the first half of the squares come first and the rest last. */
function squares(k: number, centres: boolean): { m: Material; ring: (s: number) => number[]; centre: (s: number) => [number, number] } {
  const corners: [number, number][] = [];
  const centre = (s: number): [number, number] => [(s % k) * 2 + 0.5, Math.floor(s / k) * 2 + 0.5];
  for (let s = 0; s < k * k; s++) {
    const [cx, cy] = centre(s);
    corners.push([cx - 0.5, cy - 0.5], [cx + 0.5, cy - 0.5], [cx + 0.5, cy + 0.5], [cx - 0.5, cy + 0.5]);
  }
  // A fixed scramble of the corner rows.
  const order = corners.map((_, i) => i);
  let seed = 7;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const half = Math.floor((k * k) / 2);
  const places: [number, number][] = [];
  if (centres) for (let s = 0; s < half; s++) places.push(centre(s));
  const rowOf = new Int32Array(corners.length);
  for (const c of order) {
    rowOf[c] = places.length;
    places.push(corners[c]);
  }
  if (centres) for (let s = half; s < k * k; s++) places.push(centre(s));
  const ring = (s: number) => [0, 1, 2, 3].map((c) => rowOf[4 * s + c]);
  const edges: [number, number][] = [];
  for (let s = 0; s < k * k; s++) {
    const r = ring(s);
    for (let c = 0; c < 4; c++) edges.push([r[c], r[(c + 1) % 4]]);
  }
  return { m: material(places, { edges }), ring, centre };
}

/** A tip half an edge across it: on a counter-clockwise square, the four
 * sides' tips all land on the square's middle. */
const tip = curve([[0, 0], [0.5, 0.5], [1, 0]], { closed: false });

/** The point of `m` at (x, y), and how many edges meet it. */
function at(m: Material, [x, y]: [number, number]): { count: number; degree: number } {
  const here = m.points.filter((p) => Math.hypot(p.x - x, p.y - y) < 1e-9);
  return { count: here.length, degree: here.length === 1 ? here.at(0).edges.length : -1 };
}

/** The edges of square `s` in `m`, by their ends' rows. */
const sides = (m: Material, ring: number[]) => m.edges.filter((e) => ring.includes(e.a.index) && ring.includes(e.b.index));

describe('a motif point lands on a point already there', () => {
  it('on a point the value holds, anywhere in its rows', () => {
    const { m, ring, centre } = squares(40, true);
    expect(m.points.length).toBeGreaterThan(4096);
    // A square whose centre is among the first rows, and one among the last.
    for (const s of [3, 1597]) {
      const out = m.replace(sides(m, ring(s)), tip);
      expect(out.points.length).toBe(m.points.length);
      expect(at(out, centre(s))).toEqual({ count: 1, degree: 4 });
    }
  });

  it('on a point the same replace put there, when it swaps a few edges', () => {
    const { m, ring, centre } = squares(40, false);
    const out = m.replace(sides(m, ring(801)), tip);
    expect(out.points.length).toBe(m.points.length + 1);
    expect(at(out, centre(801))).toEqual({ count: 1, degree: 4 });
  });

  it('on a point the same replace put there, when it swaps every edge', () => {
    const { m, centre } = squares(40, false);
    const out = m.replace(m.edges, tip);
    expect(out.points.length).toBe(m.points.length + 1600);
    // Each square becomes four spokes: the piece from a corner to the
    // middle is a piece of both sides that meet there, and is one edge.
    expect(out.edges.length).toBe(m.edges.length);
    for (const s of [0, 777, 1599]) expect(at(out, centre(s))).toEqual({ count: 1, degree: 4 });
  });

  it('on a point the value holds, when it swaps every edge', () => {
    const { m, centre } = squares(40, true);
    const out = m.replace(m.edges, tip);
    expect(out.points.length).toBe(m.points.length);
    for (const s of [0, 777, 1599]) expect(at(out, centre(s))).toEqual({ count: 1, degree: 4 });
  });
});

describe('a run of replaces on a large value', () => {
  it('two hundred single replaces of a 64k ring take a fraction of a second', () => {
    const n = 1 << 16;
    const ring = curve(Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI) * 40 + 50, Math.sin((i / n) * 2 * Math.PI) * 40 + 50] as [number, number]), { closed: true });
    const bump = curve([[0, 0], [0.3, 0.2], [0.5, 0.3], [0.7, 0.2], [1, 0]], { closed: false });
    const t0 = performance.now();
    let g = ring;
    for (let i = 0; i < 200; i++) g = g.replace(g.edges.at((i * 131) % g.edges.length), bump);
    const ms = performance.now() - t0;
    // A replace that read every row took 17–22 s for these 200 (niced, on
    // the shared server); one that reads what it touches takes about 0.15 s.
    expect(ms).toBeLessThan(3000);
    expect(g.edges.length).toBe(n + 600);
    expect(g.curves.length).toBe(1);
  });
});

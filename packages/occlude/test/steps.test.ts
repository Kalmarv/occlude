/**
 * The run and its recipes: `g.replace` (the L-system substitution, as a
 * value method), and growth loops written as passes of `t.steps`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import {
  add, circle, curve, force, material, mul, sketch, type Edge, type Material, type Vertex,
} from '../src/index.js';
import { initOcclude, render } from '../src/host.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

/** An open chain of n points along the x axis, with the edges that join them. */
const line = (n: number, len = 1): Material =>
  material(
    Array.from({ length: n }, (_, i) => [(i * len) / (n - 1), 0] as [number, number]),
    { edges: Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]) },
  );

/** A chain of exactly these points. */
const chain = (pts: [number, number][]): Material =>
  material(pts, { edges: pts.slice(1).map((_, i) => [i, i + 1] as [number, number]) });

const KOCH_H = Math.sqrt(3) / 6;
const kochMotif = () => chain([[0, 0], [1 / 3, 0], [0.5, KOCH_H], [2 / 3, 0], [1, 0]]);

describe('g.replace', () => {
  it('grows a Koch curve by replacing every edge with one motif', () => {
    const t = toolkit({ seed: 1 });
    const koch = t.steps(4, line(2), (g) => g.replace(g.edges, kochMotif()));
    // Every step turns each edge into four.
    expect(koch.edges.length).toBe(4 ** 4);
    const xs = [...koch.points].map((p: Vertex) => p.x);
    const ys = [...koch.points].map((p: Vertex) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(1, 6);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.max(...ys)).toBeCloseTo(KOCH_H, 2);
  });

  it('a Koch motif on a triangle: 4^n edges per side, one ring, the corners shared', () => {
    const t = toolkit({ seed: 1 });
    const tri = curve([[0, 0], [9, 0], [4.5, 9 * Math.sin(Math.PI / 3)]], { closed: true });
    for (const n of [1, 2, 3]) {
      // The triangle winds counter-clockwise, so the motif's own side is
      // inward, where the three tips would meet at the centre: flip it out.
      const snow = t.steps(n, tri, (g) => g.replace(g.edges, kochMotif(), { flip: true }));
      expect(snow.edges.length).toBe(3 * 4 ** n);
      // Motifs meet at the corners: every point has two edges, and the
      // whole is one closed chain.
      expect(snow.n).toBe(3 * 4 ** n);
      expect([...snow.points].every((p) => p.edges.length === 2)).toBe(true);
      const rings = snow.curves();
      expect(rings.length).toBe(1);
      expect(rings[0].closed).toBe(true);
      // The corners are the points they were.
      for (const id of tri.pointIds) expect(snow.rowOfPoint(id as never)).toBeGreaterThanOrEqual(0);
    }
  });

  it('point columns interpolate by their policy and edge columns are shared as a split shares them', () => {
    const m = material(
      [{ x: 0, y: 0, heat: 0, tag: 1 }, { x: 3, y: 0, heat: 6, tag: 9 }],
      { edges: [[0, 1]] as [number, number][] },
    )
      .points.set('tag', (p) => p.tag, { transfer: 'nearest' })
      .edges.set({ rest: 8, pen: 2 })
      .edges.set('rest', (e) => e.rest, { transfer: 'distribute' });
    const grown = m.replace(m.edges, kochMotif());
    expect(grown.points.length).toBe(5);
    const heats = [...grown.points].map((p: Vertex) => p.heat).sort((a, b) => a - b);
    expect(heats[0]).toBeCloseTo(0, 6);
    expect(heats[1]).toBeCloseTo(2, 6);
    expect(heats[2]).toBeCloseTo(3, 6);
    expect(heats[3]).toBeCloseTo(4, 6);
    expect(heats[4]).toBeCloseTo(6, 6);
    // 'nearest' takes the nearer end: the middle of the motif sits at 0.5
    // and takes the start's.
    const tags = [...grown.points].sort((a, b) => a.x - b.x).map((p) => p.tag);
    expect(tags).toEqual([1, 1, 1, 9, 9]);
    // A copied column is the parent's on every piece; a distributed one is
    // its share, the parent's value over the four pieces.
    expect([...grown.edgeAttrs.pen]).toEqual([2, 2, 2, 2]);
    expect([...grown.edgeAttrs.rest]).toEqual([2, 2, 2, 2]);
    // The pieces are new walls; the points at the ends are the same points.
    expect(grown.rowOfPoint(m.pointIds[0] as never)).toBe(0);
    expect(grown.rowOfPoint(m.pointIds[1] as never)).toBe(1);
    expect(grown.rowOfEdge(m.edgeIds[0] as never)).toBe(-1);
  });

  it('flips a motif for every edge, or for the edges a test picks', () => {
    const one = line(2);
    const down = one.replace(one.edges, kochMotif(), { flip: true });
    expect(Math.min(...[...down.points].map((p: Vertex) => p.y))).toBeCloseTo(-KOCH_H, 6);
    // A pass that alternates counts its own steps.
    const t = toolkit({ seed: 1 });
    const turns = t.steps(2, { g: line(2), k: 0 }, ({ g, k }) => ({ g: g.replace(g.edges, kochMotif(), { flip: k % 2 === 1 }), k: k + 1 })).g;
    const ys = [...turns.points].map((p: Vertex) => p.y);
    expect(Math.max(...ys)).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeLessThan(0);
    // A test of the edge: only the edges right of the middle turn down.
    const two = line(3, 2);
    const half = two.replace(two.edges, kochMotif(), { flip: (e: Edge) => e.a.x >= 1 });
    const left = [...half.points].filter((p) => p.x < 1).map((p) => p.y);
    const right = [...half.points].filter((p) => p.x > 1).map((p) => p.y);
    expect(Math.min(...left)).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.max(...right)).toBeLessThanOrEqual(1e-9);
  });

  it('replaces only the edges it is given; nothing replaces nothing', () => {
    const m = line(4, 3);
    expect(m.replace(m.edges.filter((e: Edge) => e.length > 100), kochMotif()).edges.length).toBe(3);
    expect(m.replace(m.edges.filter((e: Edge) => e.a.index === 0), kochMotif()).edges.length).toBe(2 + 4);
    expect(m.replace(undefined, kochMotif())).toBe(m);
  });

  it('reads the motif as a CHAIN, not as rows', () => {
    // Same geometry, rows out of chain order. Threading rows would put a
    // point outside the edge entirely.
    const zig = material([[0, 0], [1, 0], [0.5, 0.3]] as [number, number][], { edges: [[0, 2], [2, 1]] as [number, number][] });
    const one = line(2);
    const woven = one.replace(one.edges, zig);
    expect(Math.max(...[...woven.points].map((p: Vertex) => Math.abs(p.y)))).toBeLessThan(0.5);
  });

  it('refuses a motif that is not one open chain, and a flip that is neither a boolean nor a test', () => {
    const one = line(2);
    const bad = (motif: Material) => () => one.replace(one.edges, motif);
    expect(bad(material([[0, 0]] as [number, number][]))).toThrow(/one open chain/);
    expect(bad(chain([[0, 0], [0, 0]]))).toThrow(/different points/);
    expect(bad(chain([[0, 0], [1, 0], [0, 0]]))).toThrow(/closed|different points/);
    expect(() => one.replace(one.edges, kochMotif(), { flip: 1 as never })).toThrow(/flip is/);
  });
});

describe('a growth loop written as passes', () => {
  it('grows a tree from the tips, using p.adjacent', () => {
    const t = toolkit({ seed: 1 });
    const trunk = chain([[0, 0], [0, 1]]);
    const tree = t.steps(3, trunk, (g) => {
      const tips = g.points.filter((p: Vertex) => p.adjacent.length === 1 && p.y > 0);
      let out = g;
      for (const p of tips) {
        const from = p.adjacent.at(0);
        const dir = [p.x - from.x, p.y - from.y] as [number, number];
        const n = Math.hypot(dir[0], dir[1]) || 1;
        out = out.extrude(p, mul([dir[0] / n, dir[1] / n], 0.6));
      }
      return out;
    });
    expect(tree.points.length).toBe(2 + 3);
    expect(tree.points.at(4).y).toBeCloseTo(1 + 0.6 * 3, 6);
  });

  it('reproduces the bloom loop, splitting only where there is room', () => {
    let out: Material | undefined;
    const def = sketch({ seed: 8 }, (t) => {
      const ring = t.sample(circle(50, 50, 10), { count: 40 });
      const dish = t.material(circle(50, 50, 44));
      out = t.steps(30, ring, (g) => {
        const push = force.sum(
          force.separation(g, { radius: 3, excludeConnected: true }),
          force.tension(g, { rest: 1.2 }),
          force.relax(g, { amount: 0.6 }),
          force.boundary(dish, { radius: 8 }),
        );
        const moved = g.move((p: Vertex) => mul(push(p), 0.2));
        return moved.split(moved.edges.filter((e: Edge) => {
          const own = new Set([e.a.index, e.b.index, ...e.a.adjacent.indices, ...e.b.adjacent.indices]);
          return moved.points.near(mul(add(e.a, e.b), 0.5), { radius: 2.5 }).every((q: Vertex) => own.has(q.index));
        }));
      });
      return [];
    });
    render(def, { paper: { w: 100, h: 100 } });
    expect(out!.points.length).toBeGreaterThan(40);
  });
});

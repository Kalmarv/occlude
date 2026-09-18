import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { add, circle, force, initOcclude, material, mul, render, sketch, type Edge, type Material, type Vertex } from '../src/index.js';

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

describe('one batch or several passes', () => {
  it('matches every pass against the frozen state, so moves commute', () => {
    const m = line(3, 2);
    // Both passes read x. In one batch the second sees the ORIGINAL x.
    const batch = m.steps(1, [
      (cur, next) => next.move(cur.points, (p) => [p.x, 0]),
      (cur, next) => next.move(cur.points, (p) => [p.x, 0]),
    ]);
    expect(batch.points.at(2).x).toBeCloseTo(2 + 2 + 2, 10);
    // As two passes the second reads the first's result: 2 -> 4 -> 8.
    const passes = m.steps(1,
      (cur, next) => next.move(cur.points, (p) => [p.x, 0]),
      (cur, next) => next.move(cur.points, (p) => [p.x, 0]));
    expect(passes.points.at(2).x).toBeCloseTo(8, 10);
  });

  it('edits in pass order, so a later set wins and new rows follow', () => {
    const attributed = () => material([[0, 0], [1, 0]] as [number, number][], { edges: [[0, 1]] as [number, number][] }).attribute('age', 0);
    const a = (cur: Material, next: { set: (s: unknown, v: unknown) => void }) => next.set(cur.points, { age: 1 });
    const b = (cur: Material, next: { set: (s: unknown, v: unknown) => void }) => next.set(cur.points, { age: 2 });
    // Matching is order-free; WRITING is last-wins, as everywhere else.
    expect(attributed().steps(1, [a as never, b as never]).points.at(0).age).toBe(2);
    expect(attributed().steps(1, [b as never, a as never]).points.at(0).age).toBe(1);
  });

  it('refuses a list that holds something other than a pass', () => {
    expect(() => line(3).steps(1, [42 as never])).toThrow(/a pass is/);
  });
});

describe('next.replace', () => {
  it('grows a Koch curve by replacing every edge with one motif', () => {
    const koch = line(2).steps(4, (cur, next) => next.replace(cur.edges, kochMotif()));
    // Every step turns each edge into four.
    expect(koch.edges.length).toBe(4 ** 4);
    const xs = [...koch.points].map((p: Vertex) => p.x);
    const ys = [...koch.points].map((p: Vertex) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(1, 6);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.max(...ys)).toBeCloseTo(KOCH_H, 2);
  });

  it('flips a motif, and the callback sees the step', () => {
    const down = line(2).steps(1, (cur, next) => next.replace(cur.edges, kochMotif(), { flip: true }));
    expect(Math.min(...[...down.points].map((p: Vertex) => p.y))).toBeCloseTo(-KOCH_H, 6);
    // Alternating on the step grows the curve outward, then inward.
    const turns = line(2).steps(2, (cur, next) => next.replace(cur.edges, kochMotif(), { flip: (_e, k) => k % 2 === 1 }));
    const ys = [...turns.points].map((p: Vertex) => p.y);
    expect(Math.max(...ys)).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeLessThan(0);
  });

  it('replaces only the edges it is given', () => {
    const m = line(4, 3);
    const some = m.steps(1, (cur, next) => next.replace(cur.edges.filter((e: Edge) => e.length > 100), kochMotif()));
    expect(some.edges.length).toBe(3);
  });

  it('reads the motif as a CHAIN, not as rows', () => {
    // Same geometry, rows out of chain order. Threading rows would put a
    // point outside the edge entirely.
    const zig = material([[0, 0], [1, 0], [0.5, 0.3]] as [number, number][], { edges: [[0, 2], [2, 1]] as [number, number][] });
    const woven = line(2).steps(1, (cur, next) => next.replace(cur.edges, zig));
    expect(Math.max(...[...woven.points].map((p: Vertex) => Math.abs(p.y)))).toBeLessThan(0.5);
  });

  it('carries point columns through, interpolating like a split', () => {
    const m = material(
      [{ x: 0, y: 0, heat: 0 }, { x: 3, y: 0, heat: 6 }],
      { edges: [[0, 1]] as [number, number][] },
    );
    const grown = m.steps(1, (cur, next) => next.replace(cur.edges, kochMotif()));
    expect(grown.points.length).toBe(5);
    const heats = [...grown.points].map((p: Vertex) => p.heat).sort((a, b) => a - b);
    expect(heats[0]).toBeCloseTo(0, 6);
    expect(heats[4]).toBeCloseTo(6, 6);
    expect(heats[1]).toBeCloseTo(2, 6);
    expect(heats[2]).toBeCloseTo(3, 6);
    expect(heats[3]).toBeCloseTo(4, 6);
  });

  it('refuses a motif that is not one open chain', () => {
    const bad = (motif: Material) => () => line(2).steps(1, (cur, next) => next.replace(cur.edges, motif));
    expect(bad(material([[0, 0]] as [number, number][]))).toThrow(/one open chain/);
    expect(bad(chain([[0, 0], [0, 0]]))).toThrow(/different points/);
    expect(bad(chain([[0, 0], [1, 0], [0, 0]]))).toThrow(/closed|different points/);
  });
});

describe('a growth loop written as passes', () => {
  it('grows a tree from the tips, using p.adjacent and points.near', () => {
    const trunk = chain([[0, 0], [0, 1]]);
    const tree = trunk.steps(3, (cur, next) => {
      const tips = cur.points.filter((p: Vertex) => p.adjacent.length === 1 && p.y > 0);
      next.extrude(tips, (p: Vertex) => {
        const from = p.adjacent.at(0);
        const dir = [p.x - from.x, p.y - from.y] as [number, number];
        const n = Math.hypot(dir[0], dir[1]) || 1;
        return [{ position: add(p, mul([dir[0] / n, dir[1] / n], 0.6)) }];
      });
    });
    expect(tree.points.length).toBe(2 + 3);
    expect(tree.points.at(4).y).toBeCloseTo(1 + 0.6 * 3, 6);
  });

  it('reproduces the bloom loop, splitting only where there is room', () => {
    let out: Material | undefined;
    const def = sketch({ seed: 8 }, (t) => {
      const ring = t.sample(circle(50, 50, 10), { count: 40 });
      const dish = t.material(circle(50, 50, 44));
      out = ring.steps(30, (cur, next) => {
        const push = force.sum(
          force.separation(cur, { radius: 3, excludeConnected: true }),
          force.tension(cur, { rest: 1.2 }),
          force.relax(cur, { amount: 0.6 }),
          force.boundary(dish, { radius: 8 }),
        );
        next.move(cur.points, (p) => mul(push(p), 0.2));
        next.splitEdges(cur.edges.filter((e: Edge) => {
          const own = new Set([e.a.index, e.b.index, ...e.a.adjacent.indices, ...e.b.adjacent.indices]);
          return cur.points.near(mul(add(e.a, e.b), 0.5), { radius: 2.5 }).every((q: Vertex) => own.has(q.index));
        }));
      });
      return [];
    });
    render(def, { paper: { w: 100, h: 100 } });
    expect(out!.points.length).toBeGreaterThan(40);
  });
});

/**
 * `edges.crossing(a, b)`: the edges a straight move would go through.
 *
 * Both sides are strict and the test is exact, so a move that stops AT a
 * wall has not crossed it. That is the question a growth rule asks before
 * it extrudes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { append, connect, curve, initOcclude, material, type Material } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** Three horizontal walls at y = 10, 20, 30, each from x = 0 to x = 40. */
const walls = (): Material => {
  let m = material([]);
  for (const y of [10, 20, 30]) m = append(m, curve([[0, y], [40, y]], { closed: false }));
  return m;
};

describe('edges.crossing', () => {
  it('names the walls the segment goes through, in source order', () => {
    const m = walls();
    expect(m.edges.crossing([20, 5], [20, 25]).indices).toEqual([0, 1]);
    expect(m.edges.crossing([20, 25], [20, 5]).indices).toEqual([0, 1]);
    expect(m.edges.crossing([20, 5], [20, 35]).indices).toEqual([0, 1, 2]);
    // Beside the walls, not through them.
    expect(m.edges.crossing([50, 5], [50, 35]).indices).toEqual([]);
    // A move between two walls crosses neither.
    expect(m.edges.crossing([5, 12], [35, 18]).indices).toEqual([]);
  });

  it('is strict at both ends: touching is not crossing', () => {
    const m = walls();
    // Stopping on the wall.
    expect(m.edges.crossing([20, 5], [20, 10]).indices).toEqual([]);
    // Starting on it.
    expect(m.edges.crossing([20, 10], [20, 18]).indices).toEqual([]);
    // Through the wall's own endpoint.
    expect(m.edges.crossing([0, 5], [0, 15]).indices).toEqual([]);
    // Along it — no side changes, so no crossing.
    expect(m.edges.crossing([5, 10], [35, 10]).indices).toEqual([]);
    // One micron past it is a crossing, and the judgement is exact.
    expect(m.edges.crossing([20, 5], [20, 10.000000001]).indices).toEqual([0]);
  });

  it('a segment with no length, and one with no position, cross nothing', () => {
    const m = walls();
    expect(m.edges.crossing([20, 10], [20, 10]).indices).toEqual([]);
    expect(m.edges.crossing([20, NaN], [20, 35]).indices).toEqual([]);
  });

  it('answers with its own members only, and reads as a selection', () => {
    const m = walls();
    const lower = m.edges.filter((e) => e.a.y < 25);
    expect(lower.crossing([20, 5], [20, 35]).indices).toEqual([0, 1]);
    // The result is an edge selection like any other.
    const hit = m.edges.crossing([20, 5], [20, 25]);
    expect(hit.points.indices.length).toBe(4);
    expect(hit.complement().indices).toEqual([2]);
  });

  it('the grid gives the same answer a full scan does', () => {
    // A hundred rings scattered over the page, and a long diagonal through
    // them: the candidates come from the grid, the verdict from the exact
    // test, and both must match the brute-force count.
    let m = material([]);
    for (let i = 0; i < 100; i++) {
      const cx = 5 + (i % 10) * 10;
      const cy = 5 + Math.floor(i / 10) * 10;
      m = append(m, connect.ring(material([[cx - 3, cy - 3], [cx + 3, cy - 3], [cx + 3, cy + 3], [cx - 3, cy + 3]])));
    }
    const a: [number, number] = [-1, 2];
    const b: [number, number] = [103, 97];
    const got = m.edges.crossing(a, b).indices;
    const side = (px: number, py: number) => Math.sign((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]));
    const brute: number[] = [];
    for (const e of m.edges) {
      const s0 = side(e.a.x, e.a.y);
      const s1 = side(e.b.x, e.b.y);
      const t = (px: number, py: number) => Math.sign((e.b.x - e.a.x) * (py - e.a.y) - (e.b.y - e.a.y) * (px - e.a.x));
      if (s0 * s1 < 0 && t(a[0], a[1]) * t(b[0], b[1]) < 0) brute.push(e.index);
    }
    expect(brute.length).toBeGreaterThan(10);
    expect(got).toEqual(brute);
  });

  it('a growth rule extrudes only where nothing is in the way', () => {
    // The fracture recipe: each tip tries to step on, and stops for good at
    // the first wall it would go through. The walls are the ink already
    // laid, so nothing ever crosses anything.
    const seeds = material([[10, 50], [30, 50], [50, 50], [70, 50], [90, 50]]);
    const grown = seeds.steps(30, (cur, next, k) => {
      for (const p of cur.points) {
        if (p.adjacent.indices.length > 1) continue; // only a tip grows
        const dx = Math.cos(p.index * 1.1 + k * 0.25) * 4;
        const dy = Math.sin(p.index * 1.1 + k * 0.25) * 4;
        const to: [number, number] = [p.x + dx, p.y + dy];
        if (cur.edges.crossing(p, to).indices.length > 0) continue;
        next.extrude(p, () => ({ position: to }));
      }
    });
    expect(grown.n).toBeGreaterThan(seeds.n);
    // Nothing the run laid down crosses anything else it laid down.
    for (const e of grown.edges) {
      const hit = grown.edges.crossing(e.a, e.b).indices;
      expect(hit).toEqual([]);
    }
  });
});

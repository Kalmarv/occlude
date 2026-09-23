/**
 * spline: a curve THROUGH the vertices.
 *
 * `smooth` rounds a corner off and the line passes inside it. This one
 * keeps the corner vertex and bends the line between the corners, so the
 * positions a sketch picked are still on the drawing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, curve, initOcclude, material, type Material } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

const zigzag = (): Material => curve([[0, 0], [10, 20], [20, 0], [30, 20], [40, 0]], { closed: false });
const ring = (): Material => connect.ring(material([[0, 0], [20, 0], [20, 20], [0, 20]]));
const has = (m: Material, x: number, y: number): boolean =>
  Array.from(m.x).some((vx, i) => Math.abs(vx - x) < 1e-9 && Math.abs(m.y[i] - y) < 1e-9);
/** Distance from q to the segment a–b. */
const toSegment = (q: [number, number], a: [number, number], b: [number, number]): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(q[0] - (a[0] + dx * t), q[1] - (a[1] + dy * t));
};

describe('spline', () => {
  it('passes through every vertex it was given', () => {
    const src = zigzag();
    const out = src.spline();
    for (let i = 0; i < src.n; i++) expect(has(out, src.x[i], src.y[i])).toBe(true);
    // Four segments, eight samples each: four ends kept, seven new vertices
    // inside each segment, and one edge per sample.
    expect(out.n).toBe(5 + 4 * 7);
    expect(out.edgeCount).toBe(4 * 8);
    // The curve leaves the straight line it came from: that is the point.
    const off = [...out.points].filter((p) => toSegment([p.x, p.y], [0, 0], [10, 20]) > 0.1 && p.x < 10);
    expect(off.length).toBeGreaterThan(0);
  });

  it('reads closure from the chain and comes back on itself', () => {
    const out = ring().spline({ steps: 6 });
    expect(out.n).toBe(4 * 6);
    expect(out.edgeCount).toBe(4 * 6);
    // Every vertex has two edges: the ring is still one ring, seam and all.
    for (const p of out.points) expect(p.edges.length).toBe(2);
    expect(out.closed).toBe(true);
    // A square's corners are still the corners, and the curve bulges out
    // between them the same on every side, because the seam is a segment
    // like the other three.
    const mid = (a: [number, number], b: [number, number]) => {
      const q: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let best = Infinity;
      for (const p of out.points) best = Math.min(best, Math.hypot(p.x - q[0], p.y - q[1]));
      return best;
    };
    const seam = mid([0, 0], [0, 20]);
    for (const side of [mid([0, 0], [20, 0]), mid([20, 0], [20, 20]), mid([20, 20], [0, 20])]) {
      expect(side).toBeCloseTo(seam, 9);
    }
  });

  it('a chain of fewer than three vertices has no curve, and comes through as it was', () => {
    const src = curve([[0, 0], [10, 10]], { closed: false });
    const out = src.spline();
    expect(out.n).toBe(2);
    expect(out.edgeCount).toBe(1);
    expect([...out.points].map((p) => p.id)).toEqual([...src.points].map((p) => p.id));
    expect([...out.edges].map((e) => e.id)).toEqual([...src.edges].map((e) => e.id));
    // An isolated vertex is not a chain either.
    expect(material([[1, 2]]).spline().n).toBe(1);
    expect(material([]).spline().n).toBe(0);
  });

  it('tension 0 is the polyline it started from, and 1 swings wider than 0.5', () => {
    const flat = zigzag().spline({ tension: 0 });
    for (const p of flat.points) {
      const d = Math.min(
        toSegment([p.x, p.y], [0, 0], [10, 20]),
        toSegment([p.x, p.y], [10, 20], [20, 0]),
        toSegment([p.x, p.y], [20, 0], [30, 20]),
        toSegment([p.x, p.y], [30, 20], [40, 0]),
      );
      expect(d).toBeLessThan(1e-9);
    }
    const reach = (m: Material) => Math.max(...[...m.points].map((p) => toSegment([p.x, p.y], [10, 20], [20, 0])));
    expect(reach(zigzag().spline({ tension: 1 }))).toBeGreaterThan(reach(zigzag().spline({ tension: 0.5 })));
  });

  it('keeps a junction; refuses a tension outside 0 to 1 and a step count below one', () => {
    const tee = material([[0, 0], [10, 0], [20, 0], [10, 10]]).withEdges([[0, 1], [1, 2], [1, 3]]);
    const fork = [...tee.spline().points].filter((p) => p.edges.length === 3);
    expect(fork.map((p) => [p.x, p.y, p.id])).toEqual([[10, 0, tee.points.at(1).id]]);
    expect(() => zigzag().spline({ tension: 2 })).toThrow('tension');
    expect(() => zigzag().spline({ steps: 0 })).toThrow('steps');
    expect(() => zigzag().spline({ steps: 2.5 })).toThrow('steps');
  });

  it('keeps the vertices it was given, mints the ones between, and gives a child its edge\'s root', () => {
    const src = zigzag();
    const kept = [...src.points].map((p) => p.id as number);
    const parentRoot = src.edgeRoots[1];
    const out = src.spline({ steps: 4 });
    // Every source vertex is still itself; the new ones are new.
    for (const id of kept) expect(out.rowOfPoint(id as never)).toBeGreaterThanOrEqual(0);
    expect(new Set([...out.points].map((p) => p.id as number)).size).toBe(out.n);
    // The edges are gone, and their children name them.
    for (const e of src.edges) expect(out.rowOfEdge(e.id)).toBe(-1);
    const children = [...out.edges].filter((e) => out.edgeRoots[e.index] === parentRoot);
    expect(children).toHaveLength(4);
  });

  it('reads a new vertex\'s columns by the transfer policy, and shares a distributed edge column', () => {
    const src = zigzag()
      .attribute('age', (p) => p.index, { transfer: 'nearest' })
      .attribute('warm', (p) => p.x)
      .edgeAttribute('ink', (e) => e.a.index + 1, { transfer: 'distribute' });
    const out = src.spline({ steps: 4 });
    // 'nearest' is a choice, not a mean: every age is one of the originals.
    for (const p of out.points) expect(Number.isInteger(p.age)).toBe(true);
    // 'interpolate' blends, so a new vertex holds something between its ends.
    const between = [...out.points].filter((p) => !Number.isInteger(p.warm / 10));
    expect(between.length).toBeGreaterThan(0);
    // A distributed column is shared over the children of the wall it was on.
    for (const e of src.edges) {
      const root = src.edgeRoots[e.index];
      const sum = [...out.edges].filter((c) => out.edgeRoots[c.index] === root).reduce((k, c) => k + c.attrs.ink, 0);
      expect(sum).toBeCloseTo(e.attrs.ink, 9);
    }
  });
});

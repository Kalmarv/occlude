import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, curve, material, path, sketch, stroke } from '../src/index.js';
import { initOcclude, render } from '../src/host.js';
import { xy, rec } from './helpers/xy.js';

describe('Stage A repairs (con2)', () => {
  it('A1 a value update keeps the declared transfer policy; explicit interpolate resets it', () => {
    const m = curve([[0, 0], [10, 0]], { closed: false }).points.set('kind', 1, { transfer: 'nearest' });
    expect(m.points.set('kind', 2).transfers.kind).toBe('nearest');
    expect(m.points.set('kind', 2, { transfer: 'interpolate' }).transfers.kind).toBeUndefined();
    const k = m.points.set('kind', (p) => p.index);
    const split = k.split(k.edge(0), 0.3);
    expect(split.attrs.kind[2]).toBe(0); // nearest copies, still
  });

  it('A3 a write on a split edge\'s end feeds what every later cut inherits', () => {
    const m = material([[0, 0], [10, 0], [0, 10]], { edges: [[0, 1], [0, 2]], age: [0, 0, 0] });
    const out = m.points.set('age', 100, m.points.at(0)).split(m.edges);
    // Both cuts read the written state: a chain of writes is a sequence.
    expect(Array.from(out.attrs.age)).toEqual([100, 0, 0, 50, 50]);
  });

  it('A4 triangulate by index: the first row at a position takes part, later coincident rows stay isolated', () => {
    const m = connect.triangulate([[0, 0], [10, 0], [0, 10], [10, 0], [10, 10]]);
    expect(m.points.at(1).adjacent.length).toBeGreaterThan(0);
    expect(m.points.at(3).adjacent.length).toBe(0);
    expect(m.edgeCount).toBe(5); // two triangles over four distinct positions
    expect(connect.triangulate([[0, 0], [1, 1], [2, 2]]).edgeCount).toBe(0); // collinear
    expect(connect.triangulate([[0, 0], [0, 0]]).edgeCount).toBe(0);
  });

  it('A5 edges.add: completeness when an edge would be added, a new column is declared, an existing pair needs nothing', () => {
    const m = material([[0, 0], [10, 0], [20, 0]], { edges: [[0, 1]] }).edges.set('w', 1);
    const [a, b, c] = [m.points.at(0), m.points.at(1), m.points.at(2)];
    expect(() => m.edges.add([b, c], {})).toThrow(/must give 'w'/);
    expect(Array.from(m.edges.add([b, c], { w: 2, nope: 1 }).edgeAttrs.nope)).toEqual([0, 1]);
    expect(m.edges.add([a, b], {}).edgeCount).toBe(1); // existing pair, nothing added, nothing demanded
    expect(Array.from(m.edges.add([[a, b], [b, c], [a, c]], { w: 5 }).edgeAttrs.w)).toEqual([1, 5, 5]); // the kept pair keeps its column
  });

  it('A6 neighbour cells never alias: far-apart and negative coordinates', () => {
    const m = material([[0, 0], [0, -65536 * 3], [-3, 65535 * 3], [1.5, 0.5]]);
    const near = (p: [number, number]) => [...m.points.near(p, { radius: 3 }).indices];
    expect(near([0, 0]).sort()).toEqual([0, 3]);
    expect(near([0, -65536 * 3])).toEqual([1]);
    expect(near([-3, 65535 * 3])).toEqual([2]);
    expect(near([1e6, 1e6])).toEqual([]);
  });

  it('A10 split at an end creates nothing', () => {
    const m = curve([[0, 0], [10, 0], [20, 0]], { closed: false });
    expect(m.split(m.edges, 0).n).toBe(3);
    expect(m.split(m.edges, 1).n).toBe(3);
    // An edge runs 0…1: a parameter past the end is read as the end, which
    // creates nothing, exactly as `at: 1` does.
    expect(m.split(m.edges, 1.5).n).toBe(3);
    expect(m.split(m.edges, -2).n).toBe(3);
    // A parameter that is not finite is data: every split skips, nothing throws.
    expect(m.split(m.edges, NaN).n).toBe(3);
    expect(() => m.split(m.edges, 'half' as never)).toThrow(/at is a number/);
  });

  describe('with the engine', () => {
    beforeAll(async () => {
      await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
    });

    it('A2 sampling keeps each contour\'s own closure: a closed square and an open L', () => {
      let got: string[] = [];
      render(sketch({ aspect: [1, 1], seed: 1 }, (t) => {
        const p = path().moveTo(10, 10).lineTo(30, 10).lineTo(30, 30).lineTo(10, 30).close().moveTo(50, 10).lineTo(50, 40).lineTo(80, 40).build();
        got = t.sample(p, { count: 8 }).curves.map(rec).map((c) => (c.closed ? 'closed' : 'open'));
        return stroke([[0, 0], [1, 1]]);
      }), { paper: 'Square20' });
      expect(got.sort()).toEqual(['closed', 'open']); // curves() lists open chains first
    });

    it('A7 the settle guard survives relax(); A8 t.plan rejects engine with a reason; A9 the doc verb exists', () => {
      let notes: string[] = [];
      render(sketch({ aspect: [1, 1], seed: 1 }, (t) => {
        const p = material([[10, 10], [20, 20], [30, 10]]);
        expect(() => t.settle(p, { density: () => 1 } as never)).toThrow(/spacing/);
        expect(() => t.settle(t.relax(p), { density: () => 1 } as never)).toThrow(/spacing/);
        expect(() => t.plan({ engine: 'x' } as never)).toThrow(/engine identity is the host's/);
        notes.push('ok');
        return stroke([[0, 0], [1, 1]]);
      }), { paper: 'Square20' });
      expect(notes).toEqual(['ok']);
      expect(Object.keys(material([{ x: 1, y: 2, w: 0.5 }]).attrs)).toEqual(['w']); // material(points) is the route
    });
  });
});

describe('Stage C helpers (con2)', () => {
  it('strokes: one stroke per curve from a material, a selection or a group; force.sum sums; without is the rest', async () => {
    const { strokes, force, mul, sum: vsum } = await import('../src/index.js');
    const m = curve([[0, 0], [10, 0], [20, 0], [30, 5]], { closed: false, age: [0, 1, 2, 3] });
    expect(strokes(m, { pen: 'a' })).toHaveLength(1);
    expect(strokes(m.edges.filter((e) => e.index !== 1))).toHaveLength(2);
    const band = (age: number) => Math.min(1, Math.floor((age / 3) * 2));
    expect([0, 1, 2, 3].map(band)).toEqual([0, 0, 1, 1]);
    expect(m.edges.groupBy((e) => band((e.a.age + e.b.age) / 2)).flatMap((g) => strokes(g))).toHaveLength(2);
    expect(m.points.without(m.points.filter((p) => p.index < 2)).indices).toEqual([2, 3]);
    expect(m.edges.without(m.edges.filter((e) => e.index === 0)).indices).toEqual([1, 2]);
    const pull = force.tension(m, { rest: 5 });
    const lift = () => [0, 3] as [number, number];
    const push = force.sum(pull, lift);
    const p = m.vertex(1);
    expect(push(p)).toEqual(mul(vsum(pull(p), [0, 3]), 1));
    // A move reads the sum at every point, in one instant.
    expect(m.move(push).points.map(xy)[1]).toEqual(vsum(m.points.map(xy)[1], vsum(pull(p), [0, 3])));
  });
});

describe('closeout (review of 793e35f)', () => {
  it('the query broad phase includes tolerated contacts across a cell boundary', async () => {
    // many edges so the grid is fine; the point sits 1e-10 left of an edge on x = 5
    const pts: [number, number][] = [];
    const edges: [number, number][] = [];
    for (let i = 0; i < 400; i++) { pts.push([i * 0.25, 0], [i * 0.25, 30]); edges.push([2 * i, 2 * i + 1]); }
    const m = material(pts, { edges });
    const q = m.edges;
    const hit = q.firstHit([4.9999999999, 10], [4.9999999999, 10]);
    expect(hit).not.toBeNull();
    expect(hit!.edge.a.x).toBe(5);
    expect(q.nearest([4.9999999999, 10], { within: 1e-6 })!.edge.a.x).toBe(5);
  });

  it('nearest with excludeIncident finds the closest line that is not the vertex\'s own, like firstHit', async () => {
    // a tip at (10, 10) on a stem from (10, 0); a foreign wall along x = 13 and another along y = 20
    const m = material([[10, 0], [10, 10], [13, 0], [13, 30], [0, 20], [30, 20]], { edges: [[0, 1], [2, 3], [4, 5]] });
    const q = m.edges;
    expect(q.nearest([10, 9], { within: 10 })!.edge.index).toBe(0); // its own stem is nearest
    const other = q.nearest([10, 9], { within: 10, excludeIncident: m.vertex(1) });
    expect(other!.edge.index).toBe(1);
    expect(other!.distance).toBe(3);
    expect(q.nearest([10, 9], { within: 10, excludeIncident: 1 })!.edge.index).toBe(1);
    expect(q.nearest([10, 9], { within: 2, excludeIncident: 1 })).toBeNull();
    expect(() => q.nearest([10, 9], { within: 10, excludeIncident: material([[0, 0]]).vertex(0) })).toThrow(/vertex of the material these edges belong to/);
  });

  it('distributed resampling stays linear and exact; nearest with count 0 adds nothing and rejects bad counts', () => {
    const big = curve(Array.from({ length: 16000 }, (_, i) => [i * 0.1, Math.sin(i * 0.01)] as [number, number]), { closed: false })
      .edges.set('w', (e) => e.index, { transfer: 'distribute' });
    const t0 = performance.now();
    const rs = big.resample({ spacing: 0.15 });
    const ms = performance.now() - t0;
    const total = (a: Float64Array) => Array.from(a).reduce((s, v) => s + v, 0);
    expect(total(rs.edgeAttrs.w)).toBeCloseTo(total(big.edgeAttrs.w), 3); // conserved
    expect(ms).toBeLessThan(400);
    const pts = material([[0, 0], [1, 0], [2, 0]]);
    expect(connect.nearest(pts, { count: 0 }).edgeCount).toBe(0);
    expect(() => connect.nearest(pts, { count: -1 })).toThrow(/non-negative integer/);
    expect(() => connect.nearest(pts, { count: 1.5 })).toThrow(/non-negative integer/);
    expect(connect.nearest(material([[0, 0]]), { count: 3 }).edgeCount).toBe(0);
  });
});

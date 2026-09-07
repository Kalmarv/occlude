import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, curve, material, neighbours, initOcclude, path, render, sketch, stroke } from '../src/index.js';

describe('Stage A repairs (con2)', () => {
  it('A1 a value update keeps the declared transfer policy; explicit interpolate resets it', () => {
    const m = curve([[0, 0], [10, 0]], { closed: false }).attribute('kind', 1, { transfer: 'nearest' });
    expect(m.attribute('kind', 2).transfers.kind).toBe('nearest');
    expect(m.attribute('kind', 2, { transfer: 'interpolate' }).transfers.kind).toBeUndefined();
    const split = m.attribute('kind', (p) => p.index).steps(1, (c, n) => n.split(c.edge(0), { at: 0.3 }));
    expect(split.attrs.kind[1]).toBe(0); // nearest copies, still
  });

  it('A3 a legacy parent rewrite never changes what another split inherits', () => {
    const m = material([[0, 0], [10, 0], [0, 10]], { edges: [[0, 1], [0, 2]], age: [0, 0, 0] });
    const out = m.steps(1, (cur, next) => {
      next.split(cur.edge(0), { parent: () => ({ age: 100 }) });
      next.split(cur.edge(1), { at: 0.5 });
    });
    expect(Array.from(out.attrs.age)).toEqual([100, 0, 0, 0, 0]); // both cuts inherit from the frozen 0s
  });

  it('A4 triangulate by index: the first row at a position takes part, later coincident rows stay isolated', () => {
    const m = connect.triangulate([[0, 0], [10, 0], [0, 10], [10, 0], [10, 10]]);
    expect(m.degree(1)).toBeGreaterThan(0);
    expect(m.degree(3)).toBe(0);
    expect(m.edgeCount).toBe(5); // two triangles over four distinct positions
    expect(connect.triangulate([[0, 0], [1, 1], [2, 2]]).edgeCount).toBe(0); // collinear
    expect(connect.triangulate([[0, 0], [0, 0]]).edgeCount).toBe(0);
  });

  it('A5 withEdges: names always checked, completeness when an edge would be added, endpoints validated, no-op needs nothing', () => {
    const m = material([[0, 0], [10, 0], [20, 0]], { edges: [[0, 1]] }).edgeAttribute('w', 1);
    expect(() => m.withEdges([[1, 2]], {})).toThrow(/must give 'w'/);
    expect(() => m.withEdges([[0, 1]], { nope: 1 })).toThrow(/no attribute 'nope'/);
    expect(() => m.withEdges([[0, 5]], { w: 1 })).toThrow(/beyond/);
    expect(() => m.withEdges([[0, -1]], { w: 1 })).toThrow(/beyond/);
    expect(m.withEdges([[0, 1]], {}).edgeCount).toBe(1); // existing pair, nothing added, nothing demanded
    expect(Array.from(m.withEdges([[1, 2], [0, 2]], { w: 5 }).edgeAttrs.w)).toEqual([1, 5, 5]);
  });

  it('A6 neighbour cells never alias: far-apart and negative coordinates', () => {
    const m = material([[0, 0], [0, -65536 * 3], [-3, 65535 * 3], [1.5, 0.5]]);
    const near = neighbours(m, { radius: 3 });
    expect(near([0, 0]).sort()).toEqual([0, 3]);
    expect(near([0, -65536 * 3])).toEqual([1]);
    expect(near([-3, 65535 * 3])).toEqual([2]);
    expect(near([1e6, 1e6])).toEqual([]);
  });

  it('A10 splitEdges accepts an endpoint parameter and creates nothing, like split', () => {
    const m = curve([[0, 0], [10, 0], [20, 0]], { closed: false });
    expect(m.steps(1, (_, n) => n.splitEdges(() => true, { at: 0 })).n).toBe(3);
    expect(m.steps(1, (_, n) => n.splitEdges(() => true, { at: 1 })).n).toBe(3);
    expect(() => m.steps(1, (_, n) => n.splitEdges(() => true, { at: 1.5 }))).toThrow(/within \[0, 1\]/);
    expect(() => m.steps(1, (_, n) => n.splitEdges(() => true, { at: 0, point: { x: 1 } as never }))).toThrow(/endpoint/);
  });

  describe('with the engine', () => {
    beforeAll(async () => {
      await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
    });

    it('A2 sampling keeps each contour\'s own closure: a closed square and an open L', () => {
      let got: string[] = [];
      render(sketch({ aspect: [1, 1], seed: 1 }, (t) => {
        const p = path().moveTo(10, 10).lineTo(30, 10).lineTo(30, 30).lineTo(10, 30).close().moveTo(50, 10).lineTo(50, 40).lineTo(80, 40).build();
        got = t.sample(p, { count: 8 }).curves().map((c) => (c.closed ? 'closed' : 'open'));
        return stroke([[0, 0], [1, 1]]);
      }), { paper: 'Square20' });
      expect(got.sort()).toEqual(['closed', 'open']); // curves() lists open chains first
    });

    it('A7 the settle guard survives relax(); A8 t.plan rejects engine with a reason; A9 the doc verb exists', () => {
      let notes: string[] = [];
      render(sketch({ aspect: [1, 1], seed: 1 }, (t) => {
        const p = t.points([[10, 10], [20, 20], [30, 10]]);
        expect(() => p.settle(1)).toThrow(/needs a spacing/);
        expect(() => p.relax(1).settle(1)).toThrow(/needs a spacing/);
        expect(() => t.plan({ engine: 'x' } as never)).toThrow(/engine identity is the host's/);
        notes.push('ok');
        return stroke([[0, 0], [1, 1]]);
      }), { paper: 'Square20' });
      expect(notes).toEqual(['ok']);
      expect(material([{ x: 1, y: 2, w: 0.5 }]).attrNames).toEqual(['w']); // material(points) is the route
    });
  });
});

describe('Stage C helpers (con2)', () => {
  it('strokes: one stroke per contour from a material, a selection or runs; force.sum passes k; banding.over fits; complement', async () => {
    const { strokes, segmentRuns, banding, force, mul, sum: vsum } = await import('../src/index.js');
    const m = curve([[0, 0], [10, 0], [20, 0], [30, 5]], { closed: false, age: [0, 1, 2, 3] });
    expect(strokes(m, { pen: 'a' })).toHaveLength(1);
    expect(strokes(m.edges.filter((e) => e.index !== 1))).toHaveLength(2);
    const band = banding.over(m.attrs.age, { count: 2 });
    expect([0, 1, 2, 3].map(band)).toEqual([0, 0, 1, 1]);
    expect(strokes(segmentRuns(m, (a, b) => band((a.age + b.age) / 2)))).toHaveLength(2);
    expect(m.points.filter((p) => p.index < 2).complement().indices).toEqual([2, 3]);
    expect(m.edges.filter((e) => e.index === 0).complement().indices).toEqual([1, 2]);
    const pull = force.tension(m, { rest: 5 });
    const turn = (p: { x: number }, k: number) => [0, k] as [number, number];
    const push = force.sum(pull, turn);
    const p = m.vertex(1);
    expect(push(p, 3)).toEqual(mul(vsum(pull(p), [0, 3]), 1));
    expect(push(p)).toEqual(vsum(pull(p), [0, 0]));
  });
});

describe('closeout (review of 793e35f)', () => {
  it('the query broad phase includes tolerated contacts across a cell boundary', async () => {
    const { query } = await import('../src/index.js');
    // many edges so the grid is fine; the point sits 1e-10 left of an edge on x = 5
    const pts: [number, number][] = [];
    const edges: [number, number][] = [];
    for (let i = 0; i < 400; i++) { pts.push([i * 0.25, 0], [i * 0.25, 30]); edges.push([2 * i, 2 * i + 1]); }
    const m = material(pts, { edges });
    const q = query.edges(m);
    const hit = q.firstHit([4.9999999999, 10], [4.9999999999, 10]);
    expect(hit).not.toBeNull();
    expect(hit!.edge.a.x).toBe(5);
    expect(q.nearest([4.9999999999, 10], { within: 1e-6 })!.edge.a.x).toBe(5);
  });

  it('distributed resampling stays linear and exact; nearest with count 0 adds nothing and rejects bad counts', () => {
    const big = curve(Array.from({ length: 16000 }, (_, i) => [i * 0.1, Math.sin(i * 0.01)] as [number, number]), { closed: false })
      .edgeAttribute('w', (e) => e.index, { transfer: 'distribute' });
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

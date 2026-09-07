import { describe, expect, it } from 'vitest';
import {
  add, append, banding, connect, curve, distance, extent, length, limit, material, mul, neighbours, perp, segmentRuns, sub, sum, sumBy, unit,
  force, type Material, type Next,
} from '../src/material.js';
const { adjacent, attract, boundary, drift, field, nearby, relax, separation, tension, vortex } = force;

const square = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 0 });

describe('curve values', () => {
  it('holds columns, exposes vertex views, and is frozen', () => {
    const c = curve([[0, 0], [10, 0], { x: 10, y: 10 }], { age: [1, 2, 3], energy: 0.5 });
    expect(c.n).toBe(3);
    expect(c.closed).toBe(true);
    expect(c.attrNames).toEqual(['age', 'energy']);
    expect(c.vertex(1)).toEqual({ index: 1, x: 10, y: 0, age: 2, energy: 0.5 });
    expect(c.pts).toEqual([[0, 0], [10, 0], [10, 10]]);
    expect(c.contour).toEqual({ pts: [[0, 0], [10, 0], [10, 10]], closed: true });
    expect(Object.isFrozen(c)).toBe(true);
    expect(() => curve([[0, 0]], { x: 1 })).toThrow(/reserved/);
  });

  it('connectivity is the order; open curves end', () => {
    const c = square();
    expect(c.prev(0)).toBe(3);
    expect(c.next(3)).toBe(0);
    expect(c.edges).toHaveLength(4);
    expect(c.closed).toBe(true);
    const o = curve([[0, 0], [10, 0], [10, 10]], { closed: false });
    expect(o.prev(0)).toBe(-1);
    expect(o.next(2)).toBe(-1);
    expect(o.edges).toHaveLength(2);
    expect(o.contour.closed).toBe(false);
  });
});

describe('forces', () => {
  it('tension is zero within rest and pulls beyond it', () => {
    const c = square();
    expect(tension(c, { rest: 20 })(c.vertex(0))).toEqual([0, 0]);
    const [fx, fy] = tension(c, { rest: 4 })(c.vertex(0));
    expect(fx).toBeCloseTo(6);
    expect(fy).toBeCloseTo(6);
  });

  it('neighbours: prepared once, self excluded, topological neighbours included, matches brute force', () => {
    const pts: [number, number][] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) pts.push([rnd() * 50, rnd() * 50]);
    const c = curve(pts);
    const near = neighbours(c, { radius: 4 });
    for (const p of c.points.slice(0, 30)) {
      const brute: number[] = [];
      for (let j = 0; j < c.n; j++) if (j !== p.index && distance(p, c.vertex(j)) < 4) brute.push(j);
      expect([...near(p)].sort((a, b) => a - b)).toEqual(brute);
    }
  });

  it('separation matches a brute-force sum and skips curve neighbours', () => {
    const pts: [number, number][] = [];
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) pts.push([rnd() * 50, rnd() * 50]);
    const c = curve(pts);
    const repel = separation(c, { radius: 4, excludeConnected: true });
    for (const p of c.points.slice(0, 20)) {
      let fx = 0;
      let fy = 0;
      for (let j = 0; j < c.n; j++) {
        if (j === p.index || j === c.prev(p.index) || j === c.next(p.index)) continue;
        const dx = p.x - c.x[j];
        const dy = p.y - c.y[j];
        const d = Math.hypot(dx, dy);
        if (d >= 4 || d < 1e-9) continue;
        fx += (dx / d) * (1 - d / 4) * 4;
        fy += (dy / d) * (1 - d / 4) * 4;
      }
      const [gx, gy] = repel(p);
      expect(gx).toBeCloseTo(fx, 9);
      expect(gy).toBeCloseTo(fy, 9);
    }
  });

  it('nearby: sums your contribution over sources within the radius; self skipped, chain not', () => {
    const c = curve([[0, 0], [1, 0], [2, 0], [10, 10]]);
    const count = nearby(c, { radius: 5 }, () => [1, 0]);
    expect(count(c.vertex(0))).toEqual([2, 0]); // vertices 1 and 2; not itself, not the far one
    const noChain = nearby(c, { radius: 5, skip: adjacent(c) }, () => [1, 0]);
    expect(noChain(c.vertex(0))).toEqual([1, 0]); // next (1) skipped; 2 is not adjacent to 0; prev (3) is far
    expect(noChain(c.vertex(1))).toEqual([0, 0]); // 0 and 2 are its chain neighbours
    // foreign sources: a plain list, nothing is "self", q carries its index
    const obstacles: [number, number][] = [[0, 1], [0, 2], [50, 50]];
    const seen: number[] = [];
    const push = nearby(obstacles, { radius: 3 }, (p, q) => { seen.push(q.index); return sub(p, q); });
    expect(push(c.vertex(0))).toEqual([0, -3]);
    expect(seen.sort()).toEqual([0, 1]);
    // a vertex at an obstacle's exact position still interacts with it (no false self)
    const at = nearby([[0, 0]], { radius: 3 }, () => [7, 0]);
    expect(at(c.vertex(0))).toEqual([7, 0]);
  });

  it('separation through nearby matches the brute-force sum exactly', () => {
    const pts: [number, number][] = [];
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 150; i++) pts.push([rnd() * 40, rnd() * 40]);
    const c = curve(pts);
    const repel = separation(c, { radius: 4, excludeConnected: true });
    const byHand = nearby(c, { radius: 4, skip: adjacent(c) }, (p, q) => {
      const d = sub(p, q);
      return mul(unit(d), (1 - length(d) / 4) * 4);
    });
    for (const p of c.points) expect(repel(p)).toEqual(byHand(p));
  });

  it('attract pulls toward sources, fading to zero at the radius', () => {
    const c = curve([[0, 0], [10, 0], [10, 10], [0, 10]]);
    const pull = attract([[4, 0]], { radius: 8, strength: 2 });
    expect(pull(c.vertex(0))).toEqual([1, 0]); // distance 4 of 8 → half strength, toward +x
    expect(pull(c.vertex(2))).toEqual([0, 0]); // out of range
    // on the curve itself, chain neighbours included unless skipped
    const self = attract(c, { radius: 12 });
    const withSkip = attract(c, { radius: 12, excludeConnected: true });
    expect(self(c.vertex(0))).not.toEqual(withSkip(c.vertex(0)));
  });

  it('boundary: zero deep inside, inward at the edge, inward outside', () => {
    const frame = [[[0, 0], [100, 0], [100, 100], [0, 100]]] as [number, number][][];
    const keep = boundary(frame, { radius: 10, strength: 3 });
    expect(keep([50, 50])).toEqual([0, 0]);
    const nearRight = keep([95, 50]); // 5 inside the right edge → half strength, pointing -x
    expect(nearRight[0]).toBeCloseTo(-1.5, 6);
    expect(Math.abs(nearRight[1])).toBeLessThan(1e-6);
    const outside = keep([110, 50]);
    expect(outside[0]).toBeCloseTo(-3, 6); // full strength, still inward
  });

  it('vortex is tangential and fades with distance', () => {
    const swirl = vortex({ x: 0, y: 0 }, { strength: 2, falloff: 10 });
    const v = swirl([10, 0]);
    expect(v[0]).toBeCloseTo(0);
    expect(v[1]).toBeCloseTo(1); // strength 2 / (1 + 10/10)
    const far = swirl([30, 0]);
    expect(length(far)).toBeCloseTo(0.5);
  });

  it('field adapts a vector field; relax pulls toward the chain midpoint', () => {
    const f = field((x, y) => [y, -x], { strength: 0.5 });
    expect(f([2, 4])).toEqual([2, -1]);
    const c = curve([[0, 0], [10, 5], [20, 0]], { closed: false });
    const smooth = relax(c, { amount: 0.5 });
    expect(smooth(c.vertex(1))).toEqual([0, -2.5]); // midpoint (10, 0) − (10, 5), halved
    expect(smooth(c.vertex(0))).toEqual([0, 0]); // open end stays
  });

  it('drift is pure and deterministic given the noise it is handed', () => {
    const noise = (x: number, y: number, z: number) => ((Math.sin(x) + Math.cos(y) + z) % 1 + 1) % 1;
    const wander = drift(noise, { amount: 0.5 });
    const a = wander({ x: 3, y: 4 }, 2);
    const b = wander([3, 4], 2);
    expect(a).toEqual(b);
    expect(Math.hypot(a[0], a[1])).toBeCloseTo(0.5);
    expect(wander([3, 4], 3)).not.toEqual(a);
  });

  it('vocabulary: either spelling in, fresh tuples out, nothing mutated, unit(0) = 0', () => {
    const a: [number, number] = [1, 2];
    const b = { x: 3, y: 5 };
    expect(add(a, b)).toEqual([4, 7]);
    expect(sub(b, a)).toEqual([2, 3]);
    expect(mul(a, 3)).toEqual([3, 6]);
    expect(length([3, 4])).toBe(5);
    expect(distance(a, b)).toBeCloseTo(Math.sqrt(13));
    expect(unit([0, 3])).toEqual([0, 1]);
    expect(unit([0, 0])).toEqual([0, 0]);
    expect(perp([1, 0])).toEqual([-0, 1]);
    expect(limit([3, 4], 10)).toEqual([3, 4]);
    expect(limit([3, 4], 1)).toEqual([0.6, 0.8]);
    expect(limit([0, 0], 1)).toEqual([0, 0]);
    expect(sum([1, 2], [3, 4], [5, 6])).toEqual([9, 12]);
    expect(sumBy([1, 2, 3], (k) => [k, -k])).toEqual([6, -6]);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual({ x: 3, y: 5 });
    const r = add(a, a);
    r[0] = 99;
    expect(a[0]).toBe(1);
  });

  it('coincident vertices produce finite forces', () => {
    const c = curve([[5, 5], [5, 5], [5, 5], [9, 5]], { age: 0 });
    const pull = tension(c, { rest: 0.5 });
    const repel = separation(c, { radius: 3, excludeConnected: true });
    for (const p of c.points) {
      const f = sum(pull(p), repel(p));
      expect(Number.isFinite(f[0]) && Number.isFinite(f[1])).toBe(true);
    }
  });
});

describe('steps', () => {
  const march = (cur: Material, next: Next) => {
    for (const p of cur.points) {
      next.move(p.index, [1, 0]);
      next.set(p.index, { age: p.age + 1 });
    }
  };

  it('returns the final curve, preserves attributes on survivors, and never mutates the input', () => {
    const start = square();
    const grown = start.steps(2, march);
    expect(grown.iteration).toBe(2);
    expect(grown.history).toEqual([]);
    expect(start.x[0]).toBe(0);
    expect(start.iteration).toBe(0);
    expect(grown.x[0]).toBe(2);
    expect(Array.from(grown.attrs.age)).toEqual([2, 2, 2, 2]);
  });

  it('zero and one iteration', () => {
    const start = square();
    const same = start.steps(0, march);
    expect(same.pts).toEqual(start.pts);
    expect(same.iteration).toBe(0);
    expect(start.steps(0, march, { every: 5 }).history.map((h) => h.iteration)).toEqual([0]);
    const one = start.steps(1, march);
    expect(one.x[0]).toBe(1);
    expect(one.iteration).toBe(1);
  });

  it('history: iteration 0, every m-th, and the final one, once each, labelled', () => {
    const start = square();
    const g = start.steps(10, march, { every: 4 });
    expect(g.history.map((h) => h.iteration)).toEqual([0, 4, 8, 10]);
    expect(g.history.map((h) => h.material.x[0])).toEqual([0, 4, 8, 10]);
    // final iteration on the interval: not duplicated
    expect(start.steps(8, march, { every: 4 }).history.map((h) => h.iteration)).toEqual([0, 4, 8]);
    // snapshots carry no history of their own; the final curve is the last snapshot's state
    expect(g.history.every((h) => h.material.history.length === 0)).toBe(true);
    expect(g.history[3].material.pts).toEqual(g.pts);
    // the count continues across calls
    const more = g.steps(3, march, { every: 1 });
    expect(more.iteration).toBe(13);
    expect(more.history.map((h) => h.iteration)).toEqual([10, 11, 12, 13]);
  });

  it('history on and off give the same final geometry; later steps leave snapshots untouched', () => {
    const start = square();
    const rule = (cur: Material, n: Next) => {
      march(cur, n);
      n.splitEdges((e) => e.length > 12, { attributes: { age: 0 } });
    };
    const off = start.steps(6, rule);
    const on = start.steps(6, rule, { every: 2 });
    expect(on.pts).toEqual(off.pts);
    expect(Array.from(on.attrs.age)).toEqual(Array.from(off.attrs.age));
    const snap = on.history[1];
    const before = { pts: snap.material.pts, age: Array.from(snap.material.attrs.age), n: snap.material.n };
    on.steps(5, rule);
    snap.material.steps(5, rule);
    expect(snap.material.pts).toEqual(before.pts);
    expect(Array.from(snap.material.attrs.age)).toEqual(before.age);
    expect(snap.material.n).toBe(before.n);
    expect(Object.isFrozen(on.history)).toBe(true);
  });

  it('continuation: 100 steps then 100 more equals 200 uninterrupted, random state included', () => {
    // A seeded stream the rule closes over, as a sketch's t.chance would be.
    const makeRule = (seed: number) => {
      let s = seed;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      return (cur: Material, n: Next) => {
        for (const p of cur.points) {
          n.move(p.index, [rnd() - 0.5, rnd() - 0.5]);
          n.set(p.index, { age: p.age + 1 });
        }
        n.splitEdges((e) => e.length > 3 && rnd() < 0.3, { attributes: { age: 0 } });
      };
    };
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 0 });
    const whole = start.steps(200, makeRule(11));
    const rule = makeRule(11);
    const split = start.steps(100, rule).steps(100, rule);
    expect(split.iteration).toBe(200);
    expect(split.n).toBe(whole.n);
    expect(Array.from(split.x)).toEqual(Array.from(whole.x));
    expect(Array.from(split.y)).toEqual(Array.from(whole.y));
    expect(Array.from(split.attrs.age)).toEqual(Array.from(whole.attrs.age));
  });

  it('splits see the moved state, insert with explicit attributes, and reconnect the ring', () => {
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 5 });
    const next = start.steps(1, (cur, n) => {
      n.move(1, [10, 0]); // edge 0→1 becomes 20 long AFTER the move
      n.splitEdges((e) => e.length > 15, { attributes: { age: 0 } });
    });
    expect(next.n).toBe(5);
    expect(next.pts).toEqual([[0, 0], [10, 0], [20, 0], [10, 10], [0, 10]]);
    expect(Array.from(next.attrs.age)).toEqual([5, 0, 5, 5, 5]);
    expect(next.next(4)).toBe(0);
  });

  it('split predicates run in edge order on the moved edges; equal parameters share a vertex, conflicts throw', () => {
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 0 });
    const seen: [number, number][] = [];
    const out = start.steps(1, (cur, n) => {
      n.move(0, [-10, 0]);
      n.splitEdges((e) => { seen.push([e.a.index, Math.round(e.length)]); return e.length > 15; }, { point: { age: 9 } });
      n.splitEdges(() => true, { point: { age: 9 } }); // same parameter, same value: one vertex
    });
    expect(seen).toEqual([[0, 20], [1, 10], [2, 10], [3, 14]]);
    expect(out.n).toBe(8);
    expect(Array.from(out.attrs.age)).toEqual([0, 9, 0, 9, 0, 9, 0, 9]);
    expect(() => start.steps(1, (_, n) => {
      n.splitEdges(() => true, { point: { age: 1 } });
      n.splitEdges(() => true, { point: { age: 2 } }); // same parameter, different value
    })).toThrow(/conflicting 'age'/);
  });

  it('edge attributes on the start vertex: a split divides them between the children, total preserved', () => {
    // `rest` is the rest length of the OUTGOING edge of each vertex.
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 0, rest: 1 });
    const total = (c: Material) => Array.from(c.attrs.rest).reduce((a, b) => a + b, 0);
    const out = start.steps(1, (cur, n) => {
      n.move(1, [10, 0]); // edge 0→1 is 20 long after the move
      n.splitEdges((e) => e.length > 15, {
        at: 0.25,
        attributes: (e) => ({ age: 0, rest: e.a.rest * 0.75 }),
        parent: (e) => ({ rest: e.a.rest * 0.25 }),
      });
    });
    expect(out.n).toBe(5);
    expect(out.pts[1]).toEqual([5, 0]); // at 0.25 along 0→(20,0)
    expect(Array.from(out.attrs.rest)).toEqual([0.25, 0.75, 1, 1, 1]);
    expect(total(out)).toBeCloseTo(total(start), 12);
    // repeated splitting keeps the total exactly: every edge, ten steps
    const many = start.steps(10, (_, n) =>
      n.splitEdges(() => true, { attributes: (e) => ({ age: 0, rest: e.a.rest / 2 }), parent: (e) => ({ rest: e.a.rest / 2 }) }),
    );
    expect(many.n).toBe(4 * 2 ** 10);
    expect(total(many)).toBeCloseTo(4, 9);
    // the inserted vertex inherits what it is not told: rest interpolated, age interpolated
    const inherited = start.steps(1, (_, n) => n.splitEdges(() => true, { point: { age: 0 } }));
    expect(Array.from(inherited.attrs.rest).every((v) => v === 1)).toBe(true);
  });

  it('a split inherits unnamed columns; a new point must name them; unknown names are refused', () => {
    const start = curve([[0, 0], [10, 0], [10, 10]], { age: 0, energy: 1 });
    const out = start.steps(1, (_, n) => n.splitEdges(() => true, { attributes: { age: 0 } }));
    expect(Array.from(out.attrs.energy).every((v) => v === 1)).toBe(true);
    expect(() => start.steps(1, (_, n) => n.addPoint([1, 1], { age: 0 }))).toThrow(/must give 'energy'/);
    expect(() => start.steps(1, (_, n) => n.set(0, { branch: 1 }))).toThrow(/no attribute 'branch'/);
  });
});

describe('segmentRuns', () => {
  it('a uniform closed curve is one closed run', () => {
    const runs = segmentRuns(square(), () => 'a');
    expect(runs).toHaveLength(1);
    expect(runs[0].closed).toBe(true);
    expect(runs[0].pts).toHaveLength(4);
  });

  it('runs meet end to end and never split across the wrap-around', () => {
    // ages: 0 0 1 1 0 0 → by start vertex: the two 0-runs across the seam
    // (indices 4,5,0,1) must be ONE run.
    const c = curve([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], { age: [0, 0, 1, 1, 0, 0] });
    const runs = segmentRuns(c, (a) => a.age);
    expect(runs.map((r) => r.key)).toEqual([1, 0]);
    // 1-run: edges 2→3, 3→4 ; 0-run: edges 4→5, 5→0, 0→1, 1→2
    expect(runs[0].from).toBe(2);
    expect(runs[0].to).toBe(4);
    expect(runs[1].from).toBe(4);
    expect(runs[1].to).toBe(2);
    expect(runs[0].pts).toHaveLength(3);
    expect(runs[1].pts).toHaveLength(5);
    expect(runs.every((r) => !r.closed)).toBe(true);
    // Every edge drawn exactly once.
    expect(runs.reduce((s, r) => s + r.pts.length - 1, 0)).toBe(c.n);
  });

  it('the classification is the caller\'s: end-vertex and both-endpoint rules differ', () => {
    const c = curve([[0, 0], [1, 0], [2, 0], [3, 0]], { age: [0, 0, 0, 1] });
    // The single age-1 vertex owns its OUTGOING edge under the start rule
    // and its INCOMING edge under the end rule: a different segment inks.
    const byStart = segmentRuns(c, (a) => a.age).find((r) => r.key === 1)!;
    const byEnd = segmentRuns(c, (_, b) => b.age).find((r) => r.key === 1)!;
    expect(byStart.from).toBe(3);
    expect(byEnd.from).toBe(2);
    const both = segmentRuns(c, (a, b) => (a.age === b.age ? a.age : 'mixed')).map((r) => r.key);
    expect(both).toEqual(['mixed', 0]); // edges 2→3 and 3→0 straddle the age change
  });

  it('open curves run from the first vertex', () => {
    const c = curve([[0, 0], [1, 0], [2, 0]], { closed: false, age: [0, 1, 1] });
    const runs = segmentRuns(c, (a) => a.age);
    expect(runs.map((r) => r.key)).toEqual([0, 1]);
    expect(runs[0].from).toBe(0);
  });
});

describe('material: material beyond one chain', () => {
  it('material() from tuples, objects with extra columns, and constant options; connect.* builds topology', () => {
    const cloud = material([{ x: 0, y: 0, w: 0.5 }, { x: 3, y: 0, w: 1 }, { x: 0, y: 4, w: 2 }], { age: 0 });
    expect(cloud.attrNames.sort()).toEqual(['age', 'w']);
    expect(Array.from(cloud.attrs.w)).toEqual([0.5, 1, 2]);
    expect(cloud.edgeCount).toBe(0);
    expect(cloud.curves()).toEqual([]);
    const chain = connect.chain(cloud);
    expect(chain.edgeCount).toBe(2);
    expect(chain.curves().map((c) => [c.indices, c.closed])).toEqual([[[0, 1, 2], false]]);
    const ring = connect.ring(cloud);
    expect(ring.curves().map((c) => [c.indices, c.closed])).toEqual([[[0, 1, 2], true]]);
    expect(ring.closed).toBe(true);
    // nearest: undirected, no duplicates, self excluded, ties by lower row
    const sq = material([[0, 0], [1, 0], [1, 1], [0, 1]]);
    const near = connect.nearest(sq, { count: 2 });
    expect(near.edgeCount).toBe(4);
    expect(near.degree(0)).toBe(2);
    // pairs: both sets kept, coincident points distinct
    const a = material([[0, 0], [1, 0]]);
    const b = material([[0, 0], [1, 5]]);
    const paired = connect.pairs(a, b);
    expect(paired.n).toBe(4);
    expect(paired.isConnected(0, 2)).toBe(true);
    expect(() => connect.pairs(a, material([[0, 0]]))).toThrow(/lengths must match/);
    // triangulate: edges of the Delaunay triangles, accessible as connectivity
    const tri = connect.triangulate(sq);
    expect(tri.edgeCount).toBe(5);
    expect(() => material([[0, 0]], { edges: [[0, 0]] })).toThrow(/joins a vertex to itself/);
  });

  it('curves(): edge-disjoint walk ending at junctions, cycles closed, every edge once', () => {
    // a Y: 0-1, 1-2, 1-3 ; plus a separate triangle 4-5-6
    const y = material([[0, 0], [1, 0], [2, 1], [2, -1], [10, 10], [11, 10], [10, 11]], {
      edges: [[0, 1], [1, 2], [1, 3], [4, 5], [5, 6], [6, 4]],
    });
    const cs = y.curves();
    const covered = cs.reduce((n, c) => n + (c.closed ? c.indices.length : c.indices.length - 1), 0);
    expect(covered).toBe(6);
    expect(cs.filter((c) => c.closed)).toHaveLength(1);
    expect(cs.filter((c) => c.closed)[0].indices).toEqual([4, 5, 6]);
    expect(cs.filter((c) => !c.closed).every((c) => c.indices.includes(1))).toBe(true); // all three arms meet at the junction
    expect(() => y.contour).toThrow(/use curves\(\)/);
  });

  it('collection edits: move/set with where read the frozen state; moves add; last set wins', () => {
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 0, active: [1, 0, 1, 0] });
    const out = start.steps(1, (cur, next) => {
      next.move((p) => [p.x > 5 ? 1 : 0, 0]);
      next.move(() => [0, 2], { where: (p) => p.active === 1 });
      next.move(0, [0, 0.5]);
      next.set((p) => ({ age: p.age + 1 }));
      next.set(() => ({ active: 0 }), { where: (p) => p.active === 1 });
      next.set(1, { age: 9 });
    });
    expect(out.pts).toEqual([[0, 2.5], [11, 0], [11, 12], [0, 10]]);
    expect(Array.from(out.attrs.age)).toEqual([1, 9, 1, 1]);
    expect(Array.from(out.attrs.active)).toEqual([0, 0, 0, 0]);
    expect(start.pts[0]).toEqual([0, 0]);
  });

  it('branching: addPoint handles, connect, extend — junctions through ordinary edits', () => {
    const start = curve([[0, 0], [10, 0]], { closed: false, active: [0, 1], generation: 0 });
    const grown = start.steps(1, (cur, next) => {
      next.extend((p) => [
        { position: add(p, [5, 5]), attributes: { active: 1, generation: p.generation + 1 } },
        { position: add(p, [5, -5]), attributes: { active: 1, generation: p.generation + 1 } },
      ], { where: (p) => p.active === 1 });
      next.set(() => ({ active: 0 }), { where: (p) => p.active === 1 }); // current selection: not the children
      const h = next.addPoint([-5, 0], { active: 0, generation: 0 });
      next.connect(0, h);
    });
    expect(grown.n).toBe(5);
    expect(grown.degree(1)).toBe(3); // the tip became a junction
    expect(Array.from(grown.attrs.active)).toEqual([0, 0, 1, 1, 0]);
    expect(Array.from(grown.attrs.generation)).toEqual([0, 0, 1, 1, 0]);
    expect(grown.isConnected(0, 4)).toBe(true);
    expect(grown.curves()).toHaveLength(3); // 4→0→1 is one chain into the junction, then 1→2 and 1→3
    expect(() => start.steps(1, (_, n) => n.connect(0, 7))).toThrow(/no vertex 7/);
    expect(() => start.steps(1, (_, n) => n.addPoint([0, 0], { active: 0 }))).toThrow(/must give 'generation'/);
    // a handle from one batch is meaningless in another: resolved only in its own step
    expect(() => start.steps(1, (_, n) => n.connect(0, { __handle: 3, __batch: {} }))).toThrow(/another edit batch/);
  });

  it('nearby identity: membership in the source state, not coordinates or indices', () => {
    const a = curve([[0, 0], [5, 0], [5, 5]], { closed: false });
    const b = curve([[0, 0], [5, 0], [5, 5]], { closed: false }); // same coordinates, another material
    const count = nearby(b, { radius: 100 }, () => [1, 0]);
    expect(count(a.vertex(0))).toEqual([3, 0]); // all three of b, including the coincident one
    expect(count(b.vertex(0))).toEqual([2, 0]); // b's own vertex 0 skipped
    // adjacent(m) only means something for m's own vertices
    expect(adjacent(b)(a.vertex(0), b.vertex(1))).toBe(false);
    expect(adjacent(b)(b.vertex(0), b.vertex(1))).toBe(true);
  });

  it('resample: even spacing, endpoints and closure kept, transfer rules', () => {
    const open = curve([[0, 0], [10, 0], [10, 10]], { closed: false, age: [0, 10, 20], kind: [1, 2, 2] });
    const even = open.resample({ count: 5, transfer: { kind: 'nearest' } });
    expect(even.n).toBe(5);
    expect(even.pts[0]).toEqual([0, 0]);
    expect(even.pts[4]).toEqual([10, 10]);
    expect(even.pts[2]).toEqual([10, 0]); // half of 20 along: the corner, by luck of the count
    expect(Array.from(even.attrs.age)).toEqual([0, 5, 10, 15, 20]);
    expect(Array.from(even.attrs.kind)).toEqual([1, 1, 2, 2, 2]);
    expect(even.curves()[0].closed).toBe(false);
    const ring = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 7 });
    const r = ring.resample({ spacing: 5 });
    expect(r.n).toBe(8);
    expect(r.closed).toBe(true);
    expect(r.pts[0]).toEqual([0, 0]); // seam kept
    expect(Array.from(r.attrs.age).every((v) => v === 7)).toBe(true);
    const zeroed = ring.resample({ count: 6, transfer: { age: 0 } });
    expect(Array.from(zeroed.attrs.age).every((v) => v === 0)).toBe(true);
    const fn = ring.resample({ count: 4, transfer: { age: (a, b, t) => a.age * 100 + t } });
    expect(fn.attrs.age[1]).toBeCloseTo(701, 6); // lands exactly on vertex 1: a = vertex 0, t = 1
    expect(() => material([[0, 0], [1, 0], [2, 0], [1, 1]], { edges: [[0, 1], [1, 2], [1, 3]] }).resample({ spacing: 1 })).toThrow(/junction/);
  });

  it('extent and banding', () => {
    expect(extent([3, -1, 7])).toEqual([-1, 7]);
    expect(extent([])).toEqual([0, 0]);
    const band = banding({ min: 0, max: 10, count: 4 });
    expect([-5, 0, 2.4, 2.5, 9.9, 10, 99].map(band)).toEqual([0, 0, 0, 1, 3, 3, 3]);
    expect(banding({ min: 5, max: 5, count: 3 })(5)).toBe(0);
    expect(() => banding({ min: 0, max: 1, count: 0 })).toThrow(/positive integer/);
  });

  it('segmentRuns on a branched material: runs end at junctions and cover each edge once', () => {
    const y = material([[0, 0], [1, 0], [2, 1], [2, -1]], { edges: [[0, 1], [1, 2], [1, 3]], age: [0, 0, 5, 5] });
    const runs = segmentRuns(y, (a, b) => (a.age + b.age) / 2 > 2 ? 'old' : 'young');
    expect(runs.reduce((n, r) => n + r.pts.length - 1, 0)).toBe(3);
    expect(runs.every((r) => r.pts.length === 2)).toBe(true);
    const keys: string[] = runs.map((r) => r.key);
    expect(keys.sort()).toEqual(['old', 'old', 'young']);
  });

  it('relax on a junction pulls toward the mean of all branches; append re-bases edges', () => {
    const y = material([[0, 0], [1, 0], [2, 1], [2, -1]], { edges: [[0, 1], [1, 2], [1, 3]] });
    const smooth = relax(y);
    expect(smooth(y.vertex(1))[0]).toBeCloseTo(1 / 3, 12);
    expect(smooth(y.vertex(1))[1]).toBe(0);
    expect(smooth(y.vertex(0))).toEqual([0, 0]);
    const both = append(y, curve([[5, 5], [6, 5]], { closed: false }));
    expect(both.n).toBe(6);
    expect(both.isConnected(4, 5)).toBe(true);
    expect(tension(both, { rest: 0.5 })(both.vertex(4))).toEqual([0.5, 0]);
  });
});

describe('boundaries (review 2026-09-07)', () => {
  it('1. connecting an existing pair is idempotent — no second edge, no doubled tension', () => {
    const c = curve([[0, 0], [10, 0], [10, 10]], { closed: false });
    const pullBefore = tension(c, { rest: 1 })(c.vertex(0));
    const out = c.steps(1, (_, n) => { n.connect(0, 1); n.connect(1, 0); n.connect(0, 1); });
    expect(out.edgeCount).toBe(2);
    expect(tension(out, { rest: 1 })(out.vertex(0))).toEqual(pullBefore);
    expect(() => c.steps(1, (_, n) => n.connect(1, 1))).toThrow(/joins a vertex to itself/);
  });

  it('2. a handle is owned by its batch: one saved from an earlier step is refused', () => {
    const start = curve([[0, 0], [10, 0]], { closed: false });
    let saved: import('../src/material.js').Handle | null = null;
    const a = start.steps(1, (_, n) => { saved = n.addPoint([5, 5], {}); });
    expect(a.n).toBe(3);
    expect(() => a.steps(1, (_, n) => { n.addPoint([9, 9], {}); n.connect(0, saved!); })).toThrow(/another edit batch/);
  });

  it('3. resample: correct spacing on open chains, isolated vertices kept, inputs validated', () => {
    const line = curve([[0, 0], [10, 0]], { closed: false });
    const even = line.resample({ spacing: 2 });
    expect(even.n).toBe(6);
    expect(even.pts.map(([x]) => x)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(() => line.resample({ count: 1 })).toThrow(/at least 2/);
    expect(() => line.resample({ spacing: 0 })).toThrow(/positive/);
    expect(() => line.resample({ spacing: -1 })).toThrow(/positive/);
    const mixed = material([[0, 0], [10, 0], [50, 50]], { edges: [[0, 1]], age: [1, 2, 3] });
    const r = mixed.resample({ spacing: 5 });
    expect(r.n).toBe(4); // the isolated point first, then the 3-sample chain
    expect(r.pts[0]).toEqual([50, 50]);
    expect(r.attrs.age[0]).toBe(3);
    expect(r.edgeCount).toBe(2);
    expect(r.degree(0)).toBe(0);
    // a zero-length chain does not loop forever
    expect(curve([[3, 3], [3, 3]], { closed: false }).resample({ spacing: 1 }).n).toBe(1);
  });

  it('4. vertex views are valid point input: index is metadata, not a column', () => {
    const c = curve([[0, 0], [5, 0], [5, 5]], { age: 7 });
    const again = material(c.points);
    expect(again.n).toBe(3);
    expect(again.attrNames).toEqual(['age']);
    expect(Array.from(again.attrs.age)).toEqual([7, 7, 7]);
    const repel = separation(c.points, { radius: 100 });
    expect(Number.isFinite(repel(c.vertex(0))[0])).toBe(true);
  });

  it('5. segmentRuns classifies in stored edge orientation whatever the walk direction', () => {
    const m = material([[0, 0], [1, 0], [2, 0]], { edges: [[1, 0], [1, 2]], age: [0, 5, 9] });
    const seen: [number, number][] = [];
    segmentRuns(m, (a, b) => { seen.push([a.index, b.index]); return 'k'; });
    expect(seen.sort()).toEqual([[1, 0], [1, 2]]);
  });

  it('6. append refuses to drop a column silently; fill makes the choice explicit', () => {
    const a = curve([[0, 0], [1, 0]], { closed: false, age: 3 });
    const b = curve([[5, 5], [6, 5]], { closed: false });
    expect(() => append(a, b)).toThrow(/no 'age'.*fill/);
    const joined = append(a, b, { fill: { age: 0 } });
    expect(Array.from(joined.attrs.age)).toEqual([3, 3, 0, 0]);
    expect(() => append(b, a)).toThrow(/first material has no 'age'/);
  });

  it('7. derived materials never share columns with their source', () => {
    const src = curve([[0, 0], [1, 0], [1, 1]], { age: 1 });
    const derived = src.attribute('extra', 2);
    derived.x[0] = 99;
    expect(src.x[0]).toBe(0);
    const stepped = src.steps(2, () => undefined, { every: 1 });
    stepped.history[0].material.x[1] = 99;
    expect(src.x[1]).toBe(1);
    const ringed = connect.ring(material([[0, 0], [1, 0]]));
    const chained = connect.chain(ringed);
    chained.y[0] = 42;
    expect(ringed.y[0]).toBe(0);
  });
});

describe('structural editing (edges brief)', () => {
  const Y = () => material([[0, 0], [10, 0], [20, 5], [20, -5], [30, 0]], { edges: [[0, 1], [1, 2], [1, 3], [3, 4]], age: [1, 2, 3, 4, 5] })
    .edgeAttribute('rest', (e) => e.length)
    .edgeAttribute('strength', 1);

  it('edge attributes: per-edge rows, views expose them, columns survive steps and sets', () => {
    const y = Y();
    expect(y.edgeAttrNames).toEqual(['rest', 'strength']);
    expect(y.edge(0).attrs.rest).toBeCloseTo(10);
    expect(y.edge(1).attrs.rest).toBeCloseTo(Math.hypot(10, 5));
    const out = y.steps(1, (cur, n) => {
      n.move(() => [1, 0]);
      n.setEdges((e) => ({ strength: e.attrs.strength * 0.5 }));
      n.setEdges(() => ({ strength: 0 }), { where: (e) => e.length > 11 });
      n.setEdge(cur.edge(0), { rest: 99 });
    });
    expect(Array.from(out.edgeAttrs.strength)).toEqual([0.5, 0, 0, 0]); // the three diagonals are longer than 11
    expect(out.edge(0).attrs.rest).toBe(99);
    expect(y.edge(0).attrs.rest).toBeCloseTo(10); // source untouched
    expect(() => y.steps(1, (_, n) => n.setEdges(() => ({ tension: 1 })))).toThrow(/no edge attribute 'tension'/);
  });

  it('remove: an endpoint and a junction; incident edges go, survivors compact, attributes align', () => {
    const y = Y();
    const noTip = y.steps(1, (_, n) => n.remove(4));
    expect(noTip.n).toBe(4);
    expect(noTip.edgeCount).toBe(3);
    expect(Array.from(noTip.attrs.age)).toEqual([1, 2, 3, 4]);
    const noJunction = y.steps(1, (cur, n) => n.remove(cur.vertex(1)));
    expect(noJunction.n).toBe(4);
    expect(noJunction.edgeCount).toBe(1); // only 3–4 survives, re-based
    expect(Array.from(noJunction.attrs.age)).toEqual([1, 3, 4, 5]);
    expect(noJunction.edgeList[0]).toBe(2);
    expect(noJunction.edgeList[1]).toBe(3);
    expect(noJunction.edge(0).attrs.rest).toBeCloseTo(Math.hypot(10, 5));
    expect(noJunction.degree(0)).toBe(0); // 0 is isolated now, never joined to anything
    // idempotent, by predicate too
    const twice = y.steps(1, (_, n) => { n.remove(4); n.remove(4); n.remove((p) => p.age === 5); });
    expect(twice.n).toBe(4);
  });

  it('disconnect keeps the points; repeated disconnect is a no-op; predicate form', () => {
    const y = Y();
    const cut = y.steps(1, (cur, n) => { n.disconnect(cur.edge(1)); n.disconnect(cur.edge(1)); });
    expect(cut.n).toBe(5);
    expect(cut.edgeCount).toBe(3);
    expect(cut.degree(2)).toBe(0);
    const pruned = y.steps(1, (_, n) => n.disconnect((e) => e.length > 11));
    expect(pruned.edgeCount).toBe(1); // the three ~11.18 diagonals go, the 10-long base stays
  });

  it('split returns a handle usable in the batch; foreign and stale references are refused', () => {
    const y = Y();
    const out = y.steps(1, (cur, n) => {
      const mid = n.split(cur.edge(0), { at: 0.25 });
      const leaf = n.addPoint([2.5, 8], { age: 0 });
      n.connect(mid, leaf, { rest: 8, strength: 1 });
    });
    expect(out.n).toBe(7);
    expect(out.pts[1]).toEqual([2.5, 0]); // inserted after the edge's start row
    expect(out.attrs.age[1]).toBeCloseTo(1.25); // interpolated between 1 and 2
    expect(out.edge(0).attrs.rest).toBeCloseTo(10); // children inherit the parent's rest
    expect(out.edge(1).attrs.rest).toBeCloseTo(10);
    expect(out.degree(1)).toBe(3);
    const other = Y();
    expect(() => y.steps(1, (_, n) => n.split(other.edge(0)))).toThrow(/another material/);
    expect(() => y.steps(1, (_, n) => n.remove(other.vertex(0)))).toThrow(/another material/);
    let stale: import('../src/material.js').Ref | null = null;
    const a = y.steps(1, (cur, n) => { stale = n.split(cur.edge(0)); });
    expect(() => a.steps(1, (cur, n) => { n.split(cur.edge(0)); n.connect(stale!, 4, { rest: 1, strength: 1 }); })).toThrow(/another edit batch/);
  });

  it('several splits of one edge: sorted parameters, equal ones merge, endpoints create nothing', () => {
    const line = curve([[0, 0], [10, 0]], { closed: false, age: [0, 10] }).edgeAttribute('rest', 10);
    const share = (p: import('../src/material.js').Edge, c: import('../src/material.js').ChildInterval) => ({ rest: p.attrs.rest * c.fraction });
    const out = line.steps(1, (cur, n) => {
      const e = cur.edge(0);
      n.split(e, { at: 0.7, edges: share });
      n.split(e, { at: 0.2, edges: share }); // the same definition again: fine
      n.split(e, { at: 0.7, point: { age: 7 } });
      const end = n.split(e, { at: 1 });
      expect(end).toBe(1);
    });
    expect(out.pts.map(([x]) => x)).toEqual([0, 2, 7, 10]);
    expect(Array.from(out.attrs.age)).toEqual([0, 2, 7, 10]);
    const rests = Array.from(out.edgeAttrs.rest);
    expect(rests.map((r) => +r.toFixed(9))).toEqual([2, 5, 3]);
    expect(rests.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 9);
    expect(() => line.steps(1, (cur, n) => n.split(cur.edge(0), { at: 1, point: { age: 0 } }))).toThrow(/creates nothing/);
    expect(() => line.steps(1, (cur, n) => n.split(cur.edge(0), { at: 1.5 }))).toThrow(/within \[0, 1\]/);
    // distinct child-edge definitions on one parent are a conflict; the same one twice is fine
    const same = (p: import('../src/material.js').Edge, c: import('../src/material.js').ChildInterval) => ({ rest: p.attrs.rest * c.fraction });
    expect(() => line.steps(1, (cur, n) => { n.split(cur.edge(0), { at: 0.3, edges: same }); n.split(cur.edge(0), { at: 0.6, edges: same }); })).not.toThrow();
    expect(() => line.steps(1, (cur, n) => { n.split(cur.edge(0), { at: 0.3, edges: same }); n.split(cur.edge(0), { at: 0.6, edges: () => ({ rest: 1 }) }); })).toThrow(/two different child-edge definitions/);
  });

  it('transfer policies: nearest copies (ties to a), per-operation overrides win, resample obeys them', () => {
    const line = curve([[0, 0], [10, 0]], { closed: false }).attribute('kind', (p) => (p.x < 5 ? 1 : 2), { transfer: 'nearest' }).attribute('age', (p) => p.x);
    const mid = line.steps(1, (cur, n) => n.split(cur.edge(0)));
    expect(mid.attrs.kind[1]).toBe(1); // midpoint tie → stored endpoint a
    expect(mid.attrs.age[1]).toBe(5);
    const later = line.steps(1, (cur, n) => n.split(cur.edge(0), { at: 0.75 }));
    expect(later.attrs.kind[1]).toBe(2);
    const forced = line.steps(1, (cur, n) => n.split(cur.edge(0), { at: 0.75, point: { kind: 9 } }));
    expect(forced.attrs.kind[1]).toBe(9);
    const rs = line.resample({ count: 5 });
    expect(Array.from(rs.attrs.kind)).toEqual([1, 1, 1, 2, 2]);
    expect(Array.from(rs.attrs.age)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it('conflicts throw and publish nothing', () => {
    const y = Y();
    const before = { pts: y.pts, edges: Array.from(y.edgeList), age: Array.from(y.attrs.age) };
    expect(() => y.steps(1, (_, n) => { n.remove(1); n.move(1, [1, 0]); })).toThrow(/removed and also moved/);
    expect(() => y.steps(1, (_, n) => { n.remove((p) => p.age === 2); n.set(() => ({ age: 0 })); })).toThrow(/use a selector/);
    expect(() => y.steps(1, (cur, n) => { n.split(cur.edge(0)); n.disconnect(cur.edge(0)); })).toThrow(/split and disconnected/);
    expect(() => y.steps(1, (cur, n) => { n.setEdge(cur.edge(0), { strength: 0 }); n.disconnect(cur.edge(0)); })).toThrow(/attributes set and is disconnected/);
    expect(() => y.steps(1, (cur, n) => { n.remove(0); n.split(cur.edge(0)); })).toThrow(/vertices is removed/);
    expect(() => y.steps(1, (_, n) => { n.remove(0); n.connect(0, 4, { rest: 1, strength: 1 }); })).toThrow(/is removed in this step/);
    expect(() => y.steps(1, (_, n) => n.connect(0, 4))).toThrow(/must give 'rest'/);
    expect(() => y.steps(1, (_, n) => n.addPoint([NaN, 0], { age: 0 }))).toThrow(/not finite/);
    // explicit disconnect of an edge dying with its point is allowed
    expect(() => y.steps(1, (cur, n) => { n.remove(4); n.disconnect(cur.edge(3)); })).not.toThrow();
    expect(y.pts).toEqual(before.pts);
    expect(Array.from(y.edgeList)).toEqual(before.edges);
    expect(Array.from(y.attrs.age)).toEqual(before.age);
    // attributes set on an edge that is then split feed the children
    const fed = y.steps(1, (cur, n) => { n.setEdge(cur.edge(0), { strength: 7 }); n.split(cur.edge(0)); });
    expect(fed.edge(0).attrs.strength).toBe(7);
    expect(fed.edge(1).attrs.strength).toBe(7);
  });

  it('extend to a fresh child, an existing point, and a split result; one, many, none', () => {
    const line = curve([[0, 0], [10, 0], [20, 0]], { closed: false, active: [0, 0, 1] });
    const out = line.steps(1, (cur, n) => {
      n.extend((p) => [
        { position: [25, 5], attributes: { active: 1 } },
        { to: 0 },
        { to: n.split(cur.edge(0), { at: 0.5 }) },
      ], { where: (p) => p.active === 1 });
      n.extend(() => [], { where: (p) => p.active === 0 });
    });
    expect(out.n).toBe(5);
    expect(out.degree(3)).toBe(4); // the tip: its chain edge, the new child, vertex 0, and the split vertex
    expect(out.isConnected(3, 0)).toBe(true); // rows: 0, split(1), 1→2, 2→3, child→4
    expect(out.isConnected(3, 1)).toBe(true);
    expect(out.isConnected(3, 4)).toBe(true);
    expect(() => line.steps(1, (_, n) => n.extend(() => ({ position: [1, 1], attributes: { active: 0 }, to: 0 } as never)))).toThrow(/exactly one of/);
  });

  it('a stale handle never resolves even when its row exists', () => {
    const line = curve([[0, 0], [10, 0]], { closed: false });
    let h: import('../src/material.js').Ref | null = null;
    const a = line.steps(1, (_, n) => { h = n.addPoint([5, 5], {}); });
    expect(a.n).toBe(3);
    expect(() => a.steps(1, (_, n) => { n.addPoint([9, 9], {}); n.connect(h!, 0); })).toThrow(/another edit batch/);
  });
});

describe('query.edges', () => {
  const sq = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]]);
  it('nearest: within is inclusive, ties go to the earlier edge, zero-length edges are points', async () => {
    const { query } = await import('../src/query.js');
    const q = query.edges(sq());
    expect(q.nearest([5, -3], { within: 2 })).toBeNull();
    const hit = q.nearest([5, -3], { within: 3 })!;
    expect(hit.edge.index).toBe(0);
    expect(hit.t).toBeCloseTo(0.5);
    expect(hit.position).toEqual([5, 0]);
    expect(hit.distance).toBeCloseTo(3);
    const centre = q.nearest([5, 5], { within: 100 })!;
    expect(centre.edge.index).toBe(0); // all four at distance 5: the first wins
    const dot = material([[3, 3], [3, 3]], { edges: [[0, 1]] });
    const d = query.edges(dot).nearest([4, 3], { within: 5 })!;
    expect(d.t).toBe(0);
    expect(d.distance).toBeCloseTo(1);
    expect(() => q.nearest([0, 0], { within: -1 })).toThrow(/non-negative/);
  });

  it('firstHit: miss, crossing, endpoint touch, overlap, equal-hit tie, exclusion, point query', async () => {
    const { query } = await import('../src/query.js');
    const m = sq();
    const q = query.edges(m);
    expect(q.firstHit([5, 5], [6, 6])).toBeNull();
    const cross = q.firstHit([5, 5], [5, 15])!;
    expect(cross.edge.index).toBe(2);
    expect(cross.kind).toBe('crossing');
    expect(cross.along).toBeCloseTo(0.5);
    expect(cross.t).toBeCloseTo(0.5);
    expect(cross.distance).toBeCloseTo(5);
    expect(cross.position[1]).toBeCloseTo(10);
    const touch = q.firstHit([5, 5], [10, 10])!;
    expect(touch.kind).toBe('touch');
    expect(touch.edge.index).toBe(1); // edges 1 and 2 both meet at (10,10): earlier wins
    const overlap = q.firstHit([-5, 0], [15, 0])!;
    expect(overlap.kind).toBe('overlap');
    expect(overlap.along).toBeCloseTo(0.25); // enters the edge at x = 0
    expect(overlap.edge.index).toBe(0);
    // edge 0 (0→1) is incident to vertex 0: excluded, so the move meets nothing
    expect(q.firstHit([5, 5], [5, -5], { excludeIncident: m.vertex(0) })).toBeNull();
    expect(q.firstHit([5, 5], [5, -5])!.edge.index).toBe(0);
  });

  it('firstHit respects excludeIncident and refuses foreign vertices', async () => {
    const { query } = await import('../src/query.js');
    const m = sq();
    const q = query.edges(m);
    // moving from vertex 0 outward must not hit its own edges
    expect(q.firstHit([0, 0], [5, 0], { excludeIncident: m.vertex(0) })).toBeNull();
    expect(q.firstHit([0, 0], [5, 0], { excludeIncident: 0 })).toBeNull();
    expect(() => q.firstHit([0, 0], [5, 0], { excludeIncident: sq().vertex(0) })).toThrow(/vertex of the queried material/);
    const point = q.firstHit([10, 5], [10, 5])!;
    expect(point.kind).toBe('touch');
    expect(point.along).toBe(0);
    expect(point.edge.index).toBe(1);
    // the index is of the state it was built for: later moves do not change it
    const moved = m.steps(1, (_, n) => n.move(() => [100, 0]));
    expect(q.firstHit([5, 5], [5, 15])!.edge.index).toBe(2);
    expect(query.edges(moved).firstHit([5, 5], [5, 15])).toBeNull();
  });
});

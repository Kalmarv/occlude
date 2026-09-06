import { describe, expect, it } from 'vitest';
import {
  add, curve, distance, length, limit, mul, neighbours, perp, segmentRuns, separation, sub, sum, sumBy, tension, unit,
} from '../src/curve.js';

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
    expect(tension(c, c.vertex(0), { rest: 20 })).toEqual([0, 0]);
    const [fx, fy] = tension(c, c.vertex(0), { rest: 4 });
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
    const near = neighbours(c, { radius: 4 });
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
      const [gx, gy] = separation(c, p, near, { radius: 4 });
      expect(gx).toBeCloseTo(fx, 9);
      expect(gy).toBeCloseTo(fy, 9);
    }
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
    const near = neighbours(c, { radius: 3 });
    for (const p of c.points) {
      const f = sum(tension(c, p, { rest: 0.5 }), separation(c, p, near, { radius: 3 }));
      expect(Number.isFinite(f[0]) && Number.isFinite(f[1])).toBe(true);
    }
  });
});

describe('steps', () => {
  const march = (cur: import('../src/curve.js').Curve, next: import('../src/curve.js').Next) => {
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
    expect(g.history.map((h) => h.curve.x[0])).toEqual([0, 4, 8, 10]);
    // final iteration on the interval: not duplicated
    expect(start.steps(8, march, { every: 4 }).history.map((h) => h.iteration)).toEqual([0, 4, 8]);
    // snapshots carry no history of their own; the final curve is the last snapshot's state
    expect(g.history.every((h) => h.curve.history.length === 0)).toBe(true);
    expect(g.history[3].curve.pts).toEqual(g.pts);
    // the count continues across calls
    const more = g.steps(3, march, { every: 1 });
    expect(more.iteration).toBe(13);
    expect(more.history.map((h) => h.iteration)).toEqual([10, 11, 12, 13]);
  });

  it('history on and off give the same final geometry; later steps leave snapshots untouched', () => {
    const start = square();
    const rule = (cur: import('../src/curve.js').Curve, n: import('../src/curve.js').Next) => {
      march(cur, n);
      n.splitEdges((e) => e.length > 12, { attributes: { age: 0 } });
    };
    const off = start.steps(6, rule);
    const on = start.steps(6, rule, { every: 2 });
    expect(on.pts).toEqual(off.pts);
    expect(Array.from(on.attrs.age)).toEqual(Array.from(off.attrs.age));
    const snap = on.history[1];
    const before = { pts: snap.curve.pts, age: Array.from(snap.curve.attrs.age), n: snap.curve.n };
    on.steps(5, rule);
    snap.curve.steps(5, rule);
    expect(snap.curve.pts).toEqual(before.pts);
    expect(Array.from(snap.curve.attrs.age)).toEqual(before.age);
    expect(snap.curve.n).toBe(before.n);
    expect(Object.isFrozen(on.history)).toBe(true);
  });

  it('continuation: 100 steps then 100 more equals 200 uninterrupted, random state included', () => {
    // A seeded stream the rule closes over, as a sketch's t.chance would be.
    const makeRule = (seed: number) => {
      let s = seed;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      return (cur: import('../src/curve.js').Curve, n: import('../src/curve.js').Next) => {
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

  it('split predicates run in edge order on the moved edges, once per edge', () => {
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 0 });
    const seen: [number, number][] = [];
    const out = start.steps(1, (cur, n) => {
      n.move(0, [-10, 0]);
      n.splitEdges((e) => { seen.push([e.a.index, Math.round(e.length)]); return e.length > 15; }, { attributes: { age: 0 } });
      n.splitEdges(() => true, { attributes: { age: 9 } }); // second request: only edges the first declined
    });
    expect(seen).toEqual([[0, 20], [1, 10], [2, 10], [3, 14]]);
    // edge 0→1 split by the first request (age 0), the other three by the second (age 9)
    expect(Array.from(out.attrs.age)).toEqual([0, 0, 0, 9, 0, 9, 0, 9]);
  });

  it('edge attributes on the start vertex: a split divides them between the children, total preserved', () => {
    // `rest` is the rest length of the OUTGOING edge of each vertex.
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 0, rest: 1 });
    const total = (c: import('../src/curve.js').Curve) => Array.from(c.attrs.rest).reduce((a, b) => a + b, 0);
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
    // the function form must still name every column
    expect(() => start.steps(1, (_, n) => n.splitEdges(() => true, { attributes: () => ({ age: 0 }) }))).toThrow(/must give 'rest'/);
  });

  it('refuses silent attribute loss and unknown attributes', () => {
    const start = curve([[0, 0], [10, 0], [10, 10]], { age: 0, energy: 1 });
    expect(() =>
      start.steps(1, (_, n) => n.splitEdges(() => true, { attributes: { age: 0 } })),
    ).toThrow(/must give 'energy'/);
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

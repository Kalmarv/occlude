import { describe, expect, it } from 'vitest';
import {
  add, curve, distance, evolve, length, mul, neighbours, perp, segmentRuns, separation, sub, sum, sumBy, tension, unit,
} from '../src/curve.js';

const square = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 0 });

describe('curve values', () => {
  it('holds columns, exposes vertex views, and is frozen', () => {
    const c = curve([[0, 0], [10, 0], { x: 10, y: 10 }], { age: [1, 2, 3], energy: 0.5 });
    expect(c.n).toBe(3);
    expect(c.closed).toBe(true);
    expect(c.attrNames).toEqual(['age', 'energy']);
    expect(c.vertex(1)).toEqual({ id: 1, x: 10, y: 0, age: 2, energy: 0.5 });
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
      for (let j = 0; j < c.n; j++) if (j !== p.id && distance(p, c.vertex(j)) < 4) brute.push(j);
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
        if (j === p.id || j === c.prev(p.id) || j === c.next(p.id)) continue;
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

describe('evolve', () => {
  it('keeps every state, preserves attributes on survivors, and never mutates the input', () => {
    const start = square();
    const history = evolve(start, 2, (cur, next) => {
      for (const p of cur.points) {
        next.move(p.id, [1, 0]);
        next.set(p.id, { age: p.age + 1 });
      }
    });
    expect(history).toHaveLength(3);
    expect(history[0]).toBe(start);
    expect(start.x[0]).toBe(0);
    expect(history[2].x[0]).toBe(2);
    expect(Array.from(history[2].attrs.age)).toEqual([2, 2, 2, 2]);
    expect(Array.from(history[1].attrs.age)).toEqual([1, 1, 1, 1]);
  });

  it('splits see the moved state, insert with explicit attributes, and reconnect the ring', () => {
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { age: 5 });
    const [, next] = evolve(start, 1, (cur, n) => {
      n.move(1, [10, 0]); // edge 0→1 becomes 20 long AFTER the move
      n.splitEdges((e) => e.length > 15, { attributes: { age: 0 } });
    });
    expect(next.n).toBe(5);
    expect(next.pts).toEqual([[0, 0], [10, 0], [20, 0], [10, 10], [0, 10]]);
    expect(Array.from(next.attrs.age)).toEqual([5, 0, 5, 5, 5]);
    expect(next.next(4)).toBe(0);
  });

  it('refuses silent attribute loss and unknown attributes', () => {
    const start = curve([[0, 0], [10, 0], [10, 10]], { age: 0, energy: 1 });
    expect(() =>
      evolve(start, 1, (_, n) => n.splitEdges(() => true, { attributes: { age: 0 } })),
    ).toThrow(/must give 'energy'/);
    expect(() => evolve(start, 1, (_, n) => n.set(0, { branch: 1 }))).toThrow(/no attribute 'branch'/);
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

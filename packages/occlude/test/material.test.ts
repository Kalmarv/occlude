import { describe, expect, it } from 'vitest';
import {
  append, connect, curve, extent, material,
  type Material, type Vertex, type PointId,
} from '../src/material.js';
import { add, distance, length, mul, perp, sub, sum, sumBy, unit } from '../src/vec.js';
import { point } from '../src/tables.js';
import { toolkit } from './helpers/run.js';
import { force } from '../src/forces.js';
import { xy, oneRing, rec } from './helpers/xy.js';
const { boundary, drift, field, relax, separation, tension, vortex } = force;

const square = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, age: 0 });

describe('curve values', () => {
  it('holds columns, exposes vertex views, and is frozen', () => {
    const c = curve([[0, 0], [10, 0], { x: 10, y: 10 }], { closed: true, age: [1, 2, 3], energy: 0.5 });
    expect(c.n).toBe(3);
    expect(oneRing(c)).toBe(true);
    expect(Object.keys(c.attrs)).toEqual(['age', 'energy']);
    expect(c.points.at(1)).toEqual({ index: 1, x: 10, y: 0, age: 2, energy: 0.5 });
    expect(c.points.map(xy)).toEqual([[0, 0], [10, 0], [10, 10]]);
    expect(c.curves.map(rec)).toEqual([{ pts: [[0, 0], [10, 0], [10, 10]], closed: true, indices: [0, 1, 2] }]);
    expect(Object.isFrozen(c)).toBe(true);
    expect(() => curve([[0, 0]], { closed: true, x: 1 })).toThrow(/reserved/);
  });

  it('connectivity is the order; open curves end', () => {
    const c = square();
    expect(c.points.at(0).adjacent.indices).toEqual([1, 3]);
    expect(c.points.at(0).edges.length).toBe(2);
    expect(c.edges).toHaveLength(4);
    expect(oneRing(c)).toBe(true);
    const o = curve([[0, 0], [10, 0], [10, 10]], { closed: false });
    expect(o.points.at(0).adjacent.indices).toEqual([1]);
    expect(o.points.at(2).edges.length).toBe(1);
    expect(o.edges).toHaveLength(2);
    expect(o.curves.map(rec)[0].closed).toBe(false);
  });
});

describe('positions are columns', () => {
  const src = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, age: [1, 2, 3, 4] }).edges.set('w', (e) => e.index);

  it('setting x and y moves every vertex and keeps rows, ids and columns', () => {
    const m = src();
    const moved = m.points.set({ x: (p) => p.x + 3, y: (p) => p.y - 1 });
    expect(moved.n).toBe(m.n);
    expect(moved.edgeCount).toBe(m.edgeCount);
    expect(moved.points.map(xy)).toEqual(m.points.map(xy).map(([x, y]) => [x + 3, y - 1]));
    expect([...moved.points].map((p) => p.id)).toEqual([...m.points].map((p) => p.id));
    expect([...moved.edges].map((e) => e.id)).toEqual([...m.edges].map((e) => e.id));
    expect([...moved.attrs.age]).toEqual([1, 2, 3, 4]);
    expect([...moved.edgeAttrs.w]).toEqual([...m.edgeAttrs.w]);
    expect(oneRing(moved)).toBe(true);
  });

  it('is a position, not a displacement, and reads the vertex as it was', () => {
    const m = src();
    // The whole material onto one point: a position says WHERE, not how far.
    expect(m.points.set({ x: 5, y: 5 }).points.map(xy)).toEqual([[5, 5], [5, 5], [5, 5], [5, 5]]);
    // One instant: y reads the x the vertex had, not the one just written.
    expect(m.points.set({ x: (p) => p.age, y: (p) => p.x }).points.map(xy)).toEqual([[1, 0], [2, 10], [3, 10], [4, 0]]);
    // A move is the displacement.
    expect(m.move((p) => [p.age, 0]).points.map(xy)).toEqual([[1, 0], [12, 0], [13, 10], [4, 10]]);
  });

  it('a value that is not finite leaves that vertex where it was', () => {
    expect(src().points.set('x', (p) => (p.index === 1 ? NaN : p.x + 1)).points.map(xy)).toEqual([[1, 0], [10, 0], [11, 10], [1, 10]]);
  });
});

describe('forces', () => {
  it('tension is zero within rest and pulls beyond it', () => {
    const c = square();
    expect(tension(c, { rest: 20 })(c.points.at(0))).toEqual([0, 0]);
    const [fx, fy] = tension(c, { rest: 4 })(c.points.at(0));
    expect(fx).toBeCloseTo(6);
    expect(fy).toBeCloseTo(6);
  });

  it('neighbours: prepared once, self excluded, topological neighbours included, matches brute force', () => {
    const pts: [number, number][] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) pts.push([rnd() * 50, rnd() * 50]);
    const c = curve(pts, { closed: true });
    for (const p of c.points.filter((p) => p.index < 30)) {
      const brute: number[] = [];
      for (let j = 0; j < c.n; j++) if (j !== p.index && distance(p, c.points.at(j)) < 4) brute.push(j);
      expect([...c.points.near(p, { radius: 4 }).indices].sort((a, b) => a - b)).toEqual(brute);
    }
  });

  it('separation matches a brute-force sum and skips curve neighbours', () => {
    const pts: [number, number][] = [];
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200; i++) pts.push([rnd() * 50, rnd() * 50]);
    const c = curve(pts, { closed: true });
    const repel = separation(c, { radius: 4, excludeConnected: true });
    for (const p of c.points.filter((p) => p.index < 20)) {
      let fx = 0;
      let fy = 0;
      const joined = new Set(p.adjacent.indices);
      for (let j = 0; j < c.n; j++) {
        if (j === p.index || joined.has(j)) continue;
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

  it('the neighbourhood recipe sums over sources within the radius; self skipped, chain not', () => {
    const c = curve([[0, 0], [1, 0], [2, 0], [10, 10]], { closed: true });
    const count = (p: Vertex) => sumBy(c.points.near(p, { radius: 5 }), () => [1, 0]);
    expect(count(c.points.at(0))).toEqual([2, 0]); // vertices 1 and 2; not itself, not the far one
    const noChain = (p: Vertex) => sumBy(c.points.near(p, { radius: 5 }).without(p.adjacent), () => [1, 0]);
    expect(noChain(c.points.at(0))).toEqual([1, 0]); // 1 is joined; 2 is not adjacent to 0; 3 is far
    expect(noChain(c.points.at(1))).toEqual([0, 0]); // 0 and 2 are its chain neighbours
    // foreign sources: another material, nothing is "self", q carries its index
    const obstacles = material([[0, 1], [0, 2], [50, 50]]);
    const seen: number[] = [];
    const push = (p: Vertex) => sumBy(obstacles.points.near(p, { radius: 3 }), (q) => { seen.push(q.index); return sub(p, q); });
    expect(push(c.points.at(0))).toEqual([0, -3]);
    expect(seen.sort()).toEqual([0, 1]);
    // a vertex at an obstacle's exact position still interacts with it (no false self)
    const here = material([[0, 0]]);
    expect(sumBy(here.points.near(c.points.at(0), { radius: 3 }), () => [7, 0])).toEqual([7, 0]);
  });

  it('separation matches the hand-written recipe to the last few bits', () => {
    const pts: [number, number][] = [];
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 150; i++) pts.push([rnd() * 40, rnd() * 40]);
    const c = curve(pts, { closed: true });
    const repel = separation(c, { radius: 4, excludeConnected: true });
    const byHand = (p: Vertex) => sumBy(c.points.near(p, { radius: 4 }).without(p.adjacent), (q) => {
      const d = sub(p, q);
      return mul(unit(d), (1 - length(d) / 4) * 4);
    });
    // The recipe sums over a SELECTION, which is in row order; the fixed-law
    // recipe sums in the spatial index's own order. Same terms, same total
    // to within the order of summation — not the same last bit.
    for (const p of c.points) {
      const [ax, ay] = repel(p);
      const [bx, by] = byHand(p);
      expect(ax).toBeCloseTo(bx, 12);
      expect(ay).toBeCloseTo(by, 12);
    }
  });

  it('a negative separation pulls toward sources, fading to zero at the radius', () => {
    const c = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    // 2 when touching: an amount of −2 / radius turns the push round.
    const pull = separation([[4, 0]], { radius: 8, amount: -2 / 8 });
    const [px, py] = pull(c.points.at(0)); // distance 4 of 8 → half strength, toward +x
    expect(px).toBeCloseTo(1, 12);
    expect(py).toBeCloseTo(0, 12);
    expect(Math.hypot(...pull(c.points.at(2)))).toBe(0); // out of range
    // on the curve itself, chain neighbours included unless skipped
    const self = separation(c, { radius: 12, amount: -1 / 12 });
    const withSkip = separation(c, { radius: 12, excludeConnected: true, amount: -1 / 12 });
    expect(self(c.points.at(0))).not.toEqual(withSkip(c.points.at(0)));
    // A function of the point scales it point by point.
    const half = separation([[4, 0]], { radius: 8, amount: (p) => (p.x < 1 ? -1 / 8 : 0) });
    expect(half(c.points.at(0))[0]).toBeCloseTo(0.5, 12);
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
    expect(smooth(c.points.at(1))).toEqual([0, -2.5]); // midpoint (10, 0) − (10, 5), halved
    expect(smooth(c.points.at(0))).toEqual([0, 0]); // open end stays
  });

  it('drift is pure and deterministic given the noise it is handed, and turns with the step a move reads', () => {
    const noise = (x: number, y: number, z: number) => ((Math.sin(x) + Math.cos(y) + z * 1000) % 1 + 1) % 1;
    const wander = drift(noise, { amount: 0.5 });
    const a = wander({ x: 3, y: 4 });
    const b = wander([3, 4]);
    expect(a).toEqual(b);
    expect(Math.hypot(a[0], a[1])).toBeCloseTo(0.5);
    // Inside a run, the move hands the drift the step the material reached:
    // the same place drifts another way three steps on, alone or in a sum.
    const t = toolkit({ seed: 1 });
    const one = material([[3, 4]]);
    const first = sub(one.move(wander).points.map(xy)[0], [3, 4]);
    expect(first[0]).toBeCloseTo(a[0], 12);
    const later = t.steps(3, one, (g) => g);
    const third = sub(later.move(wander).points.map(xy)[0], [3, 4]);
    expect(third).not.toEqual(first);
    expect(sub(later.move(force.sum(wander)).points.map(xy)[0], [3, 4])).toEqual(third);
  });

  it('drift with the toolkit noise turns with the run\'s step, whatever holds the values', () => {
    const t = toolkit({ seed: 1 });
    const wander = drift(t.noise, { amount: 0.5 });
    const seen: number[][] = [];
    // A plain object holding a material: nothing restamps the material,
    // and the drift still reads the step the run is making.
    t.steps(3, { a: material([[3, 4]]) }, (s) => {
      seen.push(wander(s.a.points.at(0)!));
      return s;
    });
    expect(seen[1]).not.toEqual(seen[0]);
    expect(seen[2]).not.toEqual(seen[1]);
    // Outside a run it is the step the material reached, as before.
    expect(wander([3, 4])).toEqual(seen[0]);
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
    expect(length([3, 4, 12])).toBe(13);
    expect(length({ x: 3, y: 4, z: 12 })).toBe(13);
    expect(distance([0, 0, 0], { x: 3, y: 4, z: 12 })).toBe(13);
    expect(distance([3, 4], [0, 0, 12])).toBe(13); // a 2-vector stands at z = 0
    expect(unit({ x: 3, y: 4, z: 12 } as never)).toEqual([0.6, 0.8]); // unit is plane arithmetic
    expect(sum([1, 2], [3, 4], [5, 6])).toEqual([9, 12]);
    expect(sumBy([1, 2, 3], (k) => [k, -k])).toEqual([6, -6]);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual({ x: 3, y: 5 });
    const r = add(a, a);
    r[0] = 99;
    expect(a[0]).toBe(1);
  });

  it('coincident vertices produce finite forces', () => {
    const c = curve([[5, 5], [5, 5], [5, 5], [9, 5]], { closed: true, age: 0 });
    const pull = tension(c, { rest: 0.5 });
    const repel = separation(c, { radius: 3, excludeConnected: true });
    for (const p of c.points) {
      const f = sum(pull(p), repel(p));
      expect(Number.isFinite(f[0]) && Number.isFinite(f[1])).toBe(true);
    }
  });
});

describe('t.steps over a material', () => {
  const march = (g: Material) => g.move([1, 0]).points.set('age', (p) => p.age + 1);

  it('returns the final curve, preserves columns on survivors, and never mutates the input', () => {
    const t = toolkit({ seed: 1 });
    const start = square();
    const grown = t.steps(2, start, march);
    expect(grown.iteration).toBe(2);
    expect(grown.history).toEqual([]);
    expect(start.x[0]).toBe(0);
    expect(start.iteration).toBe(0);
    expect(grown.x[0]).toBe(2);
    expect(Array.from(grown.attrs.age)).toEqual([2, 2, 2, 2]);
  });

  it('zero and one step', () => {
    const t = toolkit({ seed: 1 });
    const start = square();
    const same = t.steps(0, start, march);
    expect(same.points.map(xy)).toEqual(start.points.map(xy));
    expect(same.iteration).toBe(0);
    expect(t.steps(0, start, march, { every: 5 }).history.map((h) => h.iteration)).toEqual([0]);
    const one = t.steps(1, start, march);
    expect(one.x[0]).toBe(1);
    expect(one.iteration).toBe(1);
  });

  it('history: the start, every m-th, and the final one, once each', () => {
    const t = toolkit({ seed: 1 });
    const start = square();
    const g = t.steps(10, start, march, { every: 4 });
    expect(g.history.map((h) => h.iteration)).toEqual([0, 4, 8, 10]);
    expect(g.history.map((h) => h.x[0])).toEqual([0, 4, 8, 10]);
    // final step on the interval: not duplicated
    expect(t.steps(8, start, march, { every: 4 }).history.map((h) => h.iteration)).toEqual([0, 4, 8]);
    // snapshots carry no history of their own; the final curve is the last snapshot's state
    expect(g.history.every((h) => h.history.length === 0)).toBe(true);
    expect(g.history[3].points.map(xy)).toEqual(g.points.map(xy));
    // the count continues across runs, and the start of the next run keeps no history
    const more = t.steps(3, g, march, { every: 1 });
    expect(more.iteration).toBe(13);
    expect(more.history.map((h) => h.iteration)).toEqual([10, 11, 12, 13]);
    expect(more.history.every((h) => h.history.length === 0)).toBe(true);
  });

  it('history on and off give the same final geometry; later steps leave snapshots untouched', () => {
    const t = toolkit({ seed: 1 });
    const start = square();
    const rule = (g: Material) => {
      const before = g.n;
      return g.split(g.edges.filter((e) => e.length > 12)).points.set('age', 0, (p) => p.index >= before);
    };
    const off = t.steps(6, start, march, rule);
    const on = t.steps(6, start, march, rule, { every: 2 });
    expect(on.points.map(xy)).toEqual(off.points.map(xy));
    expect(Array.from(on.attrs.age)).toEqual(Array.from(off.attrs.age));
    const snap = on.history[1];
    const before = { pts: snap.points.map(xy), age: Array.from(snap.attrs.age), n: snap.n };
    t.steps(5, on, march, rule);
    t.steps(5, snap, march, rule);
    expect(snap.points.map(xy)).toEqual(before.pts);
    expect(Array.from(snap.attrs.age)).toEqual(before.age);
    expect(snap.n).toBe(before.n);
    expect(Object.isFrozen(on.history)).toBe(true);
  });

  it('continuation: 100 steps then 100 more equals 200 uninterrupted, random state included', () => {
    const t = toolkit({ seed: 1 });
    // A seeded stream the passes close over, as a sketch's t.chance would be.
    const makeRule = (seed: number) => {
      let s = seed;
      const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      return [
        (g: Material) => g.move(() => [rnd() - 0.5, rnd() - 0.5]).points.set('age', (p) => p.age + 1),
        (g: Material) => {
          const before = g.n;
          return g.split(g.edges.filter((e) => e.length > 3 && rnd() < 0.3)).points.set('age', 0, (p) => p.index >= before);
        },
      ] as const;
    };
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, age: 0 });
    const whole = t.steps(200, start, ...makeRule(11));
    const rule = makeRule(11);
    const split = t.steps(100, t.steps(100, start, ...rule), ...rule);
    expect(split.iteration).toBe(200);
    expect(split.n).toBe(whole.n);
    expect(Array.from(split.x)).toEqual(Array.from(whole.x));
    expect(Array.from(split.y)).toEqual(Array.from(whole.y));
    expect(Array.from(split.attrs.age)).toEqual(Array.from(whole.attrs.age));
  });

  it('a later pass reads what the one before it returned: splits see the moved state', () => {
    const t = toolkit({ seed: 1 });
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, age: 5 });
    const seen: [number, number][] = [];
    const next = t.steps(1, start, (g) => g.move([10, 0], g.points.at(1)), (g) => {
      const before = g.n;
      // edge 0→1 is 20 long AFTER the move
      return g.split(g.edges.filter((e) => { seen.push([e.a.index, Math.round(e.length)]); return e.length > 15; })).points.set('age', 0, (p) => p.index >= before);
    });
    expect(seen).toEqual([[0, 20], [1, 14], [2, 10], [3, 10]]);
    expect(next.n).toBe(5);
    // The new point is a new row, at the end.
    expect(next.points.map(xy)).toEqual([[0, 0], [20, 0], [10, 10], [0, 10], [10, 0]]);
    expect(Array.from(next.attrs.age)).toEqual([5, 5, 5, 5, 0]);
    expect(next.points.at(4).adjacent.indices).toEqual([0, 1]);
  });

  it('a split vertex takes what it is not told: every column interpolated; a new point must name them', () => {
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, age: 0, rest: 1, energy: [1, 3, 1, 3] });
    const out = start.split(start.edges);
    expect(Array.from(out.attrs.rest).every((v) => v === 1)).toBe(true);
    expect(Array.from(out.attrs.energy).slice(4)).toEqual([2, 2, 2, 2]);
    expect(() => start.points.add([1, 1], { age: 0 })).toThrow(/must give 'rest'/);
  });
});

describe('edges.groupBy, then curves (what segmentRuns was)', () => {
  it('a uniform closed curve is one group, one closed curve', () => {
    const groups = square().edges.groupBy(() => 'a');
    expect(groups).toHaveLength(1);
    expect(groups[0].curves).toHaveLength(1);
    expect(groups[0].curves.at(0).closed).toBe(true);
    expect(groups[0].curves.at(0).points).toHaveLength(4);
  });

  it('a group across the seam of a ring is one curve, walked the way its edges run', () => {
    // ages 0 0 1 1 0 0, keyed by the start of each edge: the 0-edges 4→5,
    // 5→0, 0→1, 1→2 meet across the seam and are ONE curve.
    const c = curve([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], { closed: true, age: [0, 0, 1, 1, 0, 0] });
    const groups = c.edges.groupBy((e) => e.a.age);
    expect(groups.map((g) => g.key)).toEqual([0, 1]);
    const zero = groups[0].curves;
    expect(zero).toHaveLength(1);
    expect(zero.at(0).closed).toBe(false);
    expect(zero.at(0).points.map((p) => p.index)).toEqual([4, 5, 0, 1, 2]);
    expect(groups[1].curves.at(0).points.map((p) => p.index)).toEqual([2, 3, 4]);
    // Every edge drawn exactly once.
    expect(groups.reduce((s, g) => s + g.curves.sum((k) => k.edges.length), 0)).toBe(c.n);
  });

  it('the classification is the caller\'s: end-vertex and both-endpoint rules differ', () => {
    const c = curve([[0, 0], [1, 0], [2, 0], [3, 0]], { closed: true, age: [0, 0, 0, 1] });
    // The single age-1 vertex owns its OUTGOING edge under the start rule
    // and its INCOMING edge under the end rule: a different segment inks.
    const byStart = c.edges.groupBy((e) => e.a.age).find((g) => g.key === 1)!;
    const byEnd = c.edges.groupBy((e) => e.b.age).find((g) => g.key === 1)!;
    expect(byStart.map((e) => [e.a.index, e.b.index])).toEqual([[3, 0]]);
    expect(byEnd.map((e) => [e.a.index, e.b.index])).toEqual([[2, 3]]);
    const both = c.edges.groupBy((e) => (e.a.age === e.b.age ? e.a.age : 'mixed')).map((g) => g.key);
    expect(both).toEqual([0, 'mixed']); // edges 2→3 and 3→0 straddle the age change
  });

  it('a group through a junction of the whole graph is one curve when only two of its edges are in it', () => {
    const y = material([[0, 0], [1, 0], [2, 1], [2, -1]], { edges: [[0, 1], [1, 2], [1, 3]], age: [0, 0, 5, 5] });
    const groups = y.edges.groupBy((e) => ((e.a.age + e.b.age) / 2 > 2 ? 'old' : 'young'));
    expect(groups.reduce((n, g) => n + g.curves.sum((k) => k.edges.length), 0)).toBe(3);
    const old = groups.find((g) => g.key === 'old')!;
    expect(old.curves).toHaveLength(1);
    expect(old.curves.at(0).points.map((p) => p.index)).toEqual([2, 1, 3]);
  });
});

describe('material: material beyond one chain', () => {
  it('material() from tuples, objects with extra columns, and constant options; connect.* builds topology', () => {
    const cloud = material([{ x: 0, y: 0, w: 0.5 }, { x: 3, y: 0, w: 1 }, { x: 0, y: 4, w: 2 }], { age: 0 });
    expect(Object.keys(cloud.attrs).sort()).toEqual(['age', 'w']);
    expect(Array.from(cloud.attrs.w)).toEqual([0.5, 1, 2]);
    expect(cloud.edgeCount).toBe(0);
    expect(cloud.curves.map(rec)).toEqual([]);
    const chain = curve(cloud);
    expect(chain.edgeCount).toBe(2);
    expect(chain.curves.map(rec).map((c) => [c.indices, c.closed])).toEqual([[[0, 1, 2], false]]);
    const ring = curve(cloud, { closed: true });
    expect(ring.curves.map(rec).map((c) => [c.indices, c.closed])).toEqual([[[0, 1, 2], true]]);
    expect(oneRing(ring)).toBe(true);
    // nearest: undirected, no duplicates, self excluded, ties by lower row
    const sq = material([[0, 0], [1, 0], [1, 1], [0, 1]]);
    const near = connect.nearest(sq, { count: 2 });
    expect(near.edgeCount).toBe(4);
    expect(near.points.at(0).adjacent.length).toBe(2);
    // pairs: both sets kept, coincident points distinct
    const a = material([[0, 0], [1, 0]]);
    const b = material([[0, 0], [1, 5]]);
    const paired = connect.pairs(a, b);
    expect(paired.n).toBe(4);
    expect(paired.points.at(0).adjacent.has(paired.points.at(2))).toBe(true);
    // A row with no partner is carried through as a point, not an error.
    const short = connect.pairs(a, material([[0, 0]]));
    expect(short.n).toBe(3);
    expect(short.edgeCount).toBe(1);
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
    const cs = y.curves.map(rec);
    const covered = cs.reduce((n, c) => n + (c.closed ? c.indices.length : c.indices.length - 1), 0);
    expect(covered).toBe(6);
    expect(cs.filter((c) => c.closed)).toHaveLength(1);
    expect(cs.filter((c) => c.closed)[0].indices).toEqual([4, 5, 6]);
    expect(cs.filter((c) => !c.closed).every((c) => c.indices.includes(1))).toBe(true); // all three arms meet at the junction
  });

  it('writes with a where: a move sums its displacements in one instant; a chain of sets is a sequence', () => {
    const start = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, age: 0, active: [1, 0, 1, 0] });
    const active = start.points.filter((p) => p.active === 1);
    const out = start
      .move((p) => [p.x > 5 ? 1 : 0, 0])
      .move([0, 2], active)
      .move([0, 0.5], start.points.at(0))
      .points.set('age', (p) => p.age + 1)
      .points.set('active', 0, active)
      .points.set('age', 9, start.points.at(1));
    expect(out.points.map(xy)).toEqual([[0, 2.5], [11, 0], [11, 12], [0, 10]]);
    expect(Array.from(out.attrs.age)).toEqual([1, 9, 1, 1]);
    expect(Array.from(out.attrs.active)).toEqual([0, 0, 0, 0]);
    expect(start.points.map(xy)[0]).toEqual([0, 0]);
    // Several displacements in one move are read on one state and add up.
    expect(start.move([1, 0], (p) => [p.x, 0]).points.map(xy)).toEqual([[1, 0], [21, 0], [21, 10], [1, 10]]);
  });

  it('branching: extrude, a point value and a join — junctions through ordinary writes', () => {
    const start = curve([[0, 0], [10, 0]], { closed: false, active: [0, 1], generation: 0 });
    const tips = start.points.filter((p) => p.active === 1);
    let grown = start;
    for (const p of tips) {
      grown = grown
        .extrude(p, [5, 5], { active: 1, generation: p.generation + 1 })
        .extrude(p, [5, -5], { active: 1, generation: p.generation + 1 });
    }
    // The tips as they were: not the children.
    grown = grown.points.set('active', 0, tips);
    const h = point([-5, 0], { active: 0, generation: 0 });
    grown = grown.points.add(h).edges.add([start.points.at(0), h]);
    expect(grown.n).toBe(5);
    expect(grown.points.at(1).adjacent.length).toBe(3); // the tip became a junction
    expect(Array.from(grown.attrs.active)).toEqual([0, 0, 1, 1, 0]);
    expect(Array.from(grown.attrs.generation)).toEqual([0, 0, 1, 1, 0]);
    expect(grown.points.at(0).adjacent.has(grown.points.at(4))).toBe(true);
    expect(grown.curves.map(rec)).toHaveLength(3); // 4→0→1 is one chain into the junction, then 1→2 and 1→3
    expect(start.rowOfPoint(7 as PointId)).toBe(-1); // 7 is no id of this state, whatever row 7 would be
    expect(() => start.points.add([0, 0], { active: 0 })).toThrow(/must give 'generation'/);
    // something that is no point at all is a wrong program
    expect(() => start.edges.add([start.points.at(0), { __handle: 3 } as never])).toThrow(/expected a point — a vertex view or a point value/);
  });

  it('neighbourhood identity: membership in the source state, not coordinates or indices', () => {
    const a = curve([[0, 0], [5, 0], [5, 5]], { closed: false });
    const b = curve([[0, 0], [5, 0], [5, 5]], { closed: false }); // same coordinates, another material
    const count = (p: Vertex) => sumBy(b.points.near(p, { radius: 100 }), () => [1, 0]);
    expect(count(a.points.at(0))).toEqual([3, 0]); // all three of b, including the coincident one
    expect(count(b.points.at(0))).toEqual([2, 0]); // b's own vertex 0 skipped
    // `adjacent` is topology, and only b's own vertices are in b's topology
    expect(b.points.at(0).adjacent.has(b.points.at(1))).toBe(true);
    expect(b.points.at(0).adjacent.has(a.points.at(1))).toBe(false);
  });

  it('resample: even spacing, endpoints and closure kept, transfer rules', () => {
    const open = curve([[0, 0], [10, 0], [10, 10]], { closed: false, age: [0, 10, 20], kind: [1, 2, 2] });
    const even = open.resample({ count: 5, transfer: { kind: 'nearest' } });
    expect(even.n).toBe(5);
    expect(even.points.map(xy)[0]).toEqual([0, 0]);
    expect(even.points.map(xy)[4]).toEqual([10, 10]);
    expect(even.points.map(xy)[2]).toEqual([10, 0]); // half of 20 along: the corner, by luck of the count
    expect(Array.from(even.attrs.age)).toEqual([0, 5, 10, 15, 20]);
    expect(Array.from(even.attrs.kind)).toEqual([1, 1, 2, 2, 2]);
    expect(even.curves.map(rec)[0].closed).toBe(false);
    const ring = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, age: 7 });
    const r = ring.resample({ spacing: 5 });
    expect(r.n).toBe(8);
    expect(oneRing(r)).toBe(true);
    expect(r.points.map(xy)[0]).toEqual([0, 0]); // seam kept
    expect(Array.from(r.attrs.age).every((v) => v === 7)).toBe(true);
    // A rule says what a NEW vertex gets: the seam is kept, as it was.
    const zeroed = ring.resample({ count: 6, transfer: { age: 0 } });
    expect(Array.from(zeroed.attrs.age)).toEqual([7, 0, 0, 0, 0, 0]);
    const fn = ring.resample({ count: 4, transfer: { age: (a, b, t) => a.age * 100 + t } });
    expect(fn.attrs.age[1]).toBeCloseTo(701, 6); // lands exactly on vertex 1: a = vertex 0, t = 1
    // A junction is kept: one vertex, three chains still meeting there.
    const fork = material([[0, 0], [1, 0], [2, 0], [1, 1]], { edges: [[0, 1], [1, 2], [1, 3]] }).resample({ spacing: 0.25 });
    expect([...fork.points].filter((p) => p.edges.length === 3).map((p) => [p.x, p.y])).toEqual([[1, 0]]);
  });

  it('along: points by arc length with a heading and transferred columns; the material untouched', () => {
    const open = curve([[0, 0], [10, 0], [10, 10]], { closed: false, age: [0, 10, 20], kind: [1, 2, 2] });
    const st = open.along({ count: 5, transfer: { kind: 'nearest' } });
    expect(st.points).toHaveLength(5);
    expect(st.edges).toHaveLength(0); // points, not a chain
    expect(open.n).toBe(3); // nothing rebuilt
    expect(xy(st.points.at(0))).toEqual([0, 0]);
    expect(xy(st.points.at(4))).toEqual([10, 10]);
    expect(st.points.map((q) => q.age)).toEqual([0, 5, 10, 15, 20]);
    expect(st.points.map((q) => q.kind)).toEqual([1, 1, 2, 2, 2]);
    expect(st.points.map((q) => q.s)).toEqual([0, 5, 10, 15, 20]);
    expect(st.points.map((q) => q.u)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    // tangent follows the segment under the point; on the corner, the bisector
    const near = (v: readonly number[], w: readonly number[]) => { expect(v[0]).toBeCloseTo(w[0], 12); expect(v[1]).toBeCloseTo(w[1], 12); };
    near(st.points.at(1).tangent, [1, 0]);
    near(st.points.at(2).tangent, [Math.SQRT1_2, Math.SQRT1_2]);
    near(st.points.at(0).tangent, [1, 0]); // an open end: its one segment
    expect(st.points.at(3).heading).toBeCloseTo(Math.PI / 2);
    near(st.points.at(1).normal, [0, 1]);
    // The frame at a point, as a placement.
    const pl = st.points.at(1).placement();
    expect([pl.x, pl.y, pl.heading]).toEqual([5, 0, 0]);
  });

  it('along: closed chains, several chains, and edge columns by copy and distribute', () => {
    const ring = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, age: 7 })
      .edges.set('side', (e) => (e.a.y === e.b.y ? 1 : 2))
      .edges.set('ink', 10, { transfer: 'distribute' });
    const st = ring.along({ spacing: 5 }).points;
    expect(st).toHaveLength(8);
    expect(xy(st.at(0))).toEqual([0, 0]); // seam first, never repeated
    expect(st.every((q) => q.age === 7)).toBe(true);
    expect(st.map((q) => q.side)).toEqual([1, 1, 2, 2, 1, 1, 2, 2]);
    // every point owns 5 of the 40 units of chain: an eighth of the 40 ink
    for (const q of st) expect(q.ink).toBeCloseTo(5);
    expect(st.sum('ink')).toBeCloseTo(40);
    const two = material([[0, 0], [4, 0], [20, 0], [20, 3]], { edges: [[0, 1], [2, 3]] });
    const both = two.along({ count: 2 }).points;
    expect(both.map((q) => q.s)).toEqual([0, 4, 0, 3]);
    expect(both.map((q) => q.u)).toEqual([0, 1, 0, 1]);
    expect(both.at(3).heading).toBeCloseTo(Math.PI / 2, 12);
    // A junction ends each of the three chains that meet there.
    expect(material([[0, 0], [1, 0], [2, 0], [1, 1]], { edges: [[0, 1], [1, 2], [1, 3]] }).along({ spacing: 1 }).points.map((q) => q.u)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(() => ring.along({ spacing: 5, count: 3 })).toThrow(/exactly one/);
    // One column name in both domains has no one meaning on a point.
    expect(() => ring.points.set('side', 0).along({ spacing: 5 })).toThrow(/both a point column and an edge column/);
  });

  it('along(): the vertices themselves, exact columns, bisector tangents', () => {
    const sq = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true, age: [1, 2, 3, 4] })
      .edges.set('ink', 10, { transfer: 'distribute' });
    const st = sq.along().points;
    expect(st.map(xy)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(st.map((q) => q.age)).toEqual([1, 2, 3, 4]);
    expect(st.map((q) => q.s)).toEqual([0, 10, 20, 30]);
    expect(st.at(1).tangent[0]).toBeCloseTo(Math.SQRT1_2); // corner: bisector of right and up
    expect(st.at(1).tangent[1]).toBeCloseTo(Math.SQRT1_2);
    for (const q of st) expect(q.ink).toBeCloseTo(10); // half of each adjacent edge
    expect(st.at(0).heading).toBeCloseTo(-Math.PI / 4); // seam: bisector of the closing edge (down) and the first (right)
    const open = curve([[0, 0], [10, 0], [10, 10]], { closed: false });
    const ends = open.along().points;
    expect(ends).toHaveLength(3);
    expect(ends.at(0).tangent[0]).toBeCloseTo(1, 12);
    expect(ends.at(2).tangent[1]).toBeCloseTo(1, 12);
    expect(ends.at(2).u).toBe(1);
    // The same derived columns a curve's own points carry.
    expect(open.curves.at(0).points.map((p) => [p.s, p.u, p.heading])).toEqual(ends.map((p) => [p.s, p.u, p.heading]));
  });

  it('a setting outside its range clamps instead of refusing', () => {
    // One policy, wherever a setting has a range: the nearest value in it.
    // Wrong types and missing options are still mistakes.
    const pts = material([[0, 0], [10, 0], [5, 8], [14, 7]]);
    expect(Array.from(connect.unimpeded(pts, { room: 0.25 }).edgeList))
      .toEqual(Array.from(connect.unimpeded(pts, { room: 1 }).edgeList));
    const line = curve([[0, 0], [10, 0]], { closed: false });
    expect(line.split(line.edges, 9).n).toBe(line.n);
    expect(line.split(line.edges, -9).n).toBe(line.n);
    expect(() => connect.unimpeded(pts, { room: 'wide' as never })).toThrow(/must be a number/);
  });

  it('extent', () => {
    expect(extent([3, -1, 7])).toEqual([-1, 7]);
    expect(extent([])).toEqual([0, 0]);
  });

  it('relax on a junction pulls toward the mean of all branches; append re-bases edges', () => {
    const y = material([[0, 0], [1, 0], [2, 1], [2, -1]], { edges: [[0, 1], [1, 2], [1, 3]] });
    const smooth = relax(y);
    expect(smooth(y.vertex(1))[0]).toBeCloseTo(1 / 3, 12);
    expect(smooth(y.vertex(1))[1]).toBe(0);
    expect(smooth(y.vertex(0))).toEqual([0, 0]);
    const both = append(y, curve([[5, 5], [6, 5]], { closed: false }));
    expect(both.n).toBe(6);
    expect(both.points.at(4).adjacent.has(both.points.at(5))).toBe(true);
    expect(tension(both, { rest: 0.5 })(both.vertex(4))).toEqual([0.5, 0]);
  });
});

describe('boundaries (review 2026-09-07)', () => {
  it('1. joining an existing pair is idempotent — no second edge, no doubled tension', () => {
    const c = curve([[0, 0], [10, 0], [10, 10]], { closed: false });
    const pullBefore = tension(c, { rest: 1 })(c.points.at(0));
    const [p, q] = [c.points.at(0), c.points.at(1)];
    const out = c.edges.add([p, q]).edges.add([q, p]).edges.add([[p, q], [q, p]]);
    expect(out.edgeCount).toBe(2);
    expect(tension(out, { rest: 1 })(out.vertex(0))).toEqual(pullBefore);
    // A join of a point to itself is no edge.
    expect(c.edges.add([q, q]).edgeCount).toBe(2);
  });

  it('3. resample: correct spacing on open chains, isolated vertices kept, inputs validated', () => {
    const line = curve([[0, 0], [10, 0]], { closed: false });
    const even = line.resample({ spacing: 2 });
    expect(even.n).toBe(6);
    expect(even.points.map(xy).map(([x]) => x)).toEqual([0, 2, 4, 6, 8, 10]);
    // Nothing to place — fewer than two samples, or a spacing with no length
    // in it — builds nothing; a fractional count is still a mistake.
    expect(line.resample({ count: 1 }).n).toBe(0);
    expect(line.resample({ spacing: 0 }).n).toBe(0);
    expect(line.resample({ spacing: -1 }).n).toBe(0);
    expect(() => line.resample({ count: 2.5 })).toThrow(/integer/);
    const mixed = material([[0, 0], [10, 0], [50, 50]], { edges: [[0, 1]], age: [1, 2, 3] });
    const r = mixed.resample({ spacing: 5 });
    expect(r.n).toBe(4); // the isolated point first, then the 3-sample chain
    expect(r.points.map(xy)[0]).toEqual([50, 50]);
    expect(r.attrs.age[0]).toBe(3);
    expect(r.edgeCount).toBe(2);
    expect(r.points.at(0).adjacent.length).toBe(0);
    // a zero-length chain does not loop forever
    expect(curve([[3, 3], [3, 3]], { closed: false }).resample({ spacing: 1 }).n).toBe(1);
  });

  it('4. vertex views are valid point input: index is metadata, not a column', () => {
    const c = curve([[0, 0], [5, 0], [5, 5]], { closed: true, age: 7 });
    const again = material(c.points);
    expect(again.n).toBe(3);
    expect(Object.keys(again.attrs)).toEqual(['age']);
    expect(Array.from(again.attrs.age)).toEqual([7, 7, 7]);
    const repel = separation(c.points, { radius: 100 });
    expect(Number.isFinite(repel(c.points.at(0))[0])).toBe(true);
  });

  it('6. append refuses to drop a column silently; fill makes the choice explicit', () => {
    const a = curve([[0, 0], [1, 0]], { closed: false, age: 3 });
    const b = curve([[5, 5], [6, 5]], { closed: false });
    expect(() => append(a, b)).toThrow(/no column 'age'.*fill/);
    const joined = append(a, b, { fill: { age: 0 } });
    expect(Array.from(joined.attrs.age)).toEqual([3, 3, 0, 0]);
    expect(() => append(b, a)).toThrow(/first material has no column 'age'/);
  });

  it('7. derived materials share the columns they did not write, and leave their source as it was', () => {
    const src = curve([[0, 0], [1, 0], [1, 1]], { closed: true, age: 1 });
    const derived = src.points.set('extra', 2);
    expect(derived.store.x).toBe(src.store.x);
    expect(derived.store.attrs.age).toBe(src.store.attrs.age);
    expect(Object.keys(src.attrs)).toEqual(['age']);
    const moved = src.points.set('x', 5);
    expect(moved.store.x).not.toBe(src.store.x);
    expect(Array.from(src.x)).toEqual([0, 1, 1]);
    const stepped = toolkit({ seed: 1 }).steps(2, src, (g) => g, { every: 1 });
    expect(stepped.history[0].store.x).toBe(src.store.x);
    const loose = material([[0, 0], [1, 0], [2, 0]]);
    const chained = curve(loose);
    expect(chained.store.y).toBe(loose.store.y);
    expect(loose.edgeCount).toBe(0);
  });
});

describe('structural editing (edges brief)', () => {
  const Y = () => material([[0, 0], [10, 0], [20, 5], [20, -5], [30, 0]], { edges: [[0, 1], [1, 2], [1, 3], [3, 4]], age: [1, 2, 3, 4, 5] })
    .edges.set({ rest: (e) => e.length, strength: 1 });

  it('edge columns: per-edge rows, views expose them, columns survive moves and sets', () => {
    const y = Y();
    expect(Object.keys(y.edgeAttrs)).toEqual(['rest', 'strength']);
    expect(y.edge(0).rest).toBeCloseTo(10);
    expect(y.edge(1).rest).toBeCloseTo(Math.hypot(10, 5));
    const moved = y.move([1, 0]);
    const out = moved
      .edges.set('strength', (e) => e.strength * 0.5)
      .edges.set('strength', 0, moved.edges.filter((e) => e.length > 11))
      .edges.set('rest', 99, moved.edges.at(0));
    expect(Array.from(out.edgeAttrs.strength)).toEqual([0.5, 0, 0, 0]); // the three diagonals are longer than 11
    expect(out.edge(0).rest).toBe(99);
    expect(y.edge(0).rest).toBeCloseTo(10); // source untouched
    // A column a write names for the first time is declared.
    expect(Array.from(y.edges.set('tension', 1, y.edges.at(0)).edgeAttrs.tension)).toEqual([1, 0, 0, 0]);
  });

  it('remove: an endpoint and a junction; incident edges go, survivors compact, columns align', () => {
    const y = Y();
    const noTip = y.points.remove(y.points.at(4));
    expect(noTip.n).toBe(4);
    expect(noTip.edgeCount).toBe(3);
    expect(Array.from(noTip.attrs.age)).toEqual([1, 2, 3, 4]);
    const noJunction = y.points.remove(y.vertex(1));
    expect(noJunction.n).toBe(4);
    expect(noJunction.edgeCount).toBe(1); // only 3–4 survives, re-based
    expect(Array.from(noJunction.attrs.age)).toEqual([1, 3, 4, 5]);
    expect(noJunction.edgeList[0]).toBe(2);
    expect(noJunction.edgeList[1]).toBe(3);
    expect(noJunction.edge(0).rest).toBeCloseTo(Math.hypot(10, 5));
    expect(noJunction.points.at(0).adjacent.length).toBe(0); // 0 is isolated now, never joined to anything
    // A point that is gone removes nothing, by value or by a test.
    const twice = noTip.points.remove(y.points.at(4)).points.remove(noTip.points.filter((p) => p.age === 5));
    expect(twice.n).toBe(4);
  });

  it('edges.remove keeps the points; a removed edge removes nothing again; a selection form', () => {
    const y = Y();
    const cut = y.edges.remove(y.edge(1));
    expect(cut.n).toBe(5);
    expect(cut.edgeCount).toBe(3);
    expect(cut.edges.remove(y.edge(1)).edgeCount).toBe(3);
    expect(cut.points.at(2).adjacent.length).toBe(0);
    const pruned = y.edges.remove(y.edges.filter((e) => e.length > 11));
    expect(pruned.edgeCount).toBe(1); // the three ~11.18 diagonals go, the 10-long base stays
  });

  it('split, then join the new point by the view it became; views of another material name nothing here', () => {
    const y = Y();
    const cut = y.split(y.edge(0), 0.25);
    expect(cut.n).toBe(6);
    const mid = cut.points.at(5);
    expect([mid.x, mid.y]).toEqual([2.5, 0]);
    expect(mid.age).toBeCloseTo(1.25); // interpolated between 1 and 2
    // Children take the parent's rest as a copy, the default.
    expect(cut.edges.filter((e) => e.a.index === 5 || e.b.index === 5).map((e) => e.rest)).toEqual([10, 10]);
    const leaf = point([2.5, 8], { age: 0 });
    const out = cut.points.add(leaf).edges.add([mid, leaf], { rest: 8, strength: 1 });
    expect(out.n).toBe(7);
    expect(out.points.at(5).adjacent.length).toBe(3);
    // A view of a material that shares no identity is the wrong program: a
    // write refuses it by name, as `rows` does.
    const other = Y();
    expect(() => y.split(other.edge(0))).toThrow(/split: that edge is a row of an unrelated material/);
    expect(() => y.points.remove(other.vertex(0))).toThrow(/points\.remove: that point is a row of an unrelated material/);
  });

  it('a split shares a distributed column by length and interpolates the points; an end cuts nothing', () => {
    const line = curve([[0, 0], [10, 0]], { closed: false, age: [0, 10] }).edges.set('rest', 10, { transfer: 'distribute' });
    const once = line.split(line.edges, 0.2);
    expect(once.points.map(xy).map(([x]) => x)).toEqual([0, 10, 2]);
    expect(Array.from(once.attrs.age)).toEqual([0, 10, 2]);
    const twice = once.split(once.edges.filter((e) => e.length > 5), 5 / 8);
    expect(twice.points.map(xy).map(([x]) => x).sort((a, b) => a - b)).toEqual([0, 2, 7, 10]);
    const rests = Array.from(twice.edgeAttrs.rest);
    expect(rests.map((r) => +r.toFixed(9)).sort((a, b) => a - b)).toEqual([2, 3, 5]);
    expect(rests.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 9);
    // A cut at an end, or past it, creates nothing.
    expect(line.split(line.edges, 1)).toBe(line);
    expect(line.split(line.edges, 1.5)).toBe(line);
    // A column set on an edge before a split feeds its children.
    const fed = line.edges.set('strength', 7).split(line.edges);
    expect(Array.from(fed.edgeAttrs.strength)).toEqual([7, 7]);
    // A new edge that does not give every declared column is a wrong program.
    expect(() => line.points.add([5, 5], { age: 0 }).edges.add([line.points.at(0), line.points.at(1)], {})).not.toThrow();
    const three = line.points.add([5, 5], { age: 0 });
    expect(() => three.edges.add([three.points.at(0), three.points.at(2)])).toThrow(/must give 'rest'/);
  });

  it('transfer policies: nearest copies (ties to a), a later write keeps the policy, resample obeys them', () => {
    const line = curve([[0, 0], [10, 0]], { closed: false }).points.set('kind', (p) => (p.x < 5 ? 1 : 2), { transfer: 'nearest' }).points.set('age', (p) => p.x);
    expect(line.transfers.kind).toBe('nearest');
    const mid = line.split(line.edges);
    expect(mid.attrs.kind[2]).toBe(1); // midpoint tie → stored endpoint a
    expect(mid.attrs.age[2]).toBe(5);
    const later = line.split(line.edges, 0.75);
    expect(later.attrs.kind[2]).toBe(2);
    // Setting a value keeps the declared policy; declaring the default restores it.
    expect(line.points.set('kind', 3).transfers.kind).toBe('nearest');
    expect(line.points.set('kind', 3, { transfer: 'interpolate' }).transfers.kind).toBeUndefined();
    const rs = line.resample({ count: 5 });
    expect(Array.from(rs.attrs.kind)).toEqual([1, 1, 1, 2, 2]);
    expect(Array.from(rs.attrs.age)).toEqual([0, 2.5, 5, 7.5, 10]);
  });
});

describe('edges.nearest and edges.firstHit (what query.edges was)', () => {
  const sq = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
  it('nearest: within is inclusive, ties go to the earlier edge, zero-length edges are points', async () => {
    const q = sq().edges;
    expect(q.nearest([5, -3], { within: 2 })).toBeNull();
    const hit = q.nearest([5, -3], { within: 3 })!;
    expect(hit.edge.index).toBe(0);
    expect(hit.t).toBeCloseTo(0.5);
    expect(hit.position).toEqual([5, 0]);
    expect(hit.distance).toBeCloseTo(3);
    const centre = q.nearest([5, 5], { within: 100 })!;
    expect(centre.edge.index).toBe(0); // all four at distance 5: the first wins
    const dot = material([[3, 3], [3, 3]], { edges: [[0, 1]] });
    const d = dot.edges.nearest([4, 3], { within: 5 })!;
    expect(d.t).toBe(0);
    expect(d.distance).toBeCloseTo(1);
    expect(() => q.nearest([0, 0], { within: -1 })).toThrow(/non-negative/);
  });

  it('firstHit: miss, crossing, endpoint touch, overlap, equal-hit tie, exclusion, point query', async () => {
    const m = sq();
    const q = m.edges;
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

  it('firstHit respects excludeIncident, found by identity; a row number is not a vertex', async () => {
    const m = sq();
    const q = m.edges;
    // moving from vertex 0 outward must not hit its own edges
    expect(q.firstHit([0, 0], [5, 0], { excludeIncident: m.vertex(0) })).toBeNull();
    // A vertex of an unrelated material names no row here: it skips nothing.
    expect(q.firstHit([0, 0], [5, 0], { excludeIncident: sq().vertex(0) })).not.toBeNull();
    expect(() => q.firstHit([0, 0], [5, 0], { excludeIncident: 0 as never })).toThrow(/edges\.firstHit: excludeIncident: expected a point/);
    const point = q.firstHit([10, 5], [10, 5])!;
    expect(point.kind).toBe('touch');
    expect(point.along).toBe(0);
    expect(point.edge.index).toBe(1);
    // the index is of the state it was built for: later moves do not change it
    const moved = m.move([100, 0]);
    expect(q.firstHit([5, 5], [5, 15])!.edge.index).toBe(2);
    expect(moved.edges.firstHit([5, 5], [5, 15])).toBeNull();
  });
});

describe('edges.nearest / firstHit: pruning keeps the full scan’s answer', () => {
  // 21 × 21 lattice of unit-spaced lines: query points and moves land exactly
  // on cell boundaries, and every move spans many grid cells.
  const lattice = () => {
    const K = 20;
    const pts: [number, number][] = [];
    for (let i = 0; i <= K; i++) for (let j = 0; j <= K; j++) pts.push([i * 5, j * 5]);
    const id = (i: number, j: number) => i * (K + 1) + j;
    const eds: [number, number][] = [];
    for (let i = 0; i <= K; i++) for (let j = 0; j < K; j++) { eds.push([id(i, j), id(i, j + 1)]); eds.push([id(j, i), id(j + 1, i)]); }
    return material(pts, { edges: eds });
  };
  let s = 12345;
  const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);

  it('a move across the whole drawing meets the first line it crosses, not a later one', async () => {
    const q = lattice().edges;
    for (let i = 0; i < 300; i++) {
      // start and end off the lines, so the answer is a clean interior crossing
      const from: [number, number] = [1 + rnd() * 98, 1 + rnd() * 98];
      const to: [number, number] = [1 + rnd() * 98, 1 + rnd() * 98];
      // analytic first crossing of a line x = 5k or y = 5k inside [0, 100]
      let want = Infinity;
      for (let k = 0; k <= 20; k++) {
        for (const [p0, p1] of [[from[0], to[0]], [from[1], to[1]]] as [number, number][]) {
          const d = p1 - p0;
          if (d === 0) continue;
          const a = (5 * k - p0) / d;
          if (a > 0 && a <= 1) want = Math.min(want, a);
        }
      }
      const hit = q.firstHit(from, to);
      if (!Number.isFinite(want)) { expect(hit).toBeNull(); continue; }
      expect(hit).not.toBeNull();
      expect(hit!.along).toBeCloseTo(want, 9);
    }
  });

  it('nearest over a wide radius agrees with a full scan, ties to the earlier edge', async () => {
    const m = lattice();
    const q = m.edges;
    const scan = (px: number, py: number, within: number) => {
      let bestE = -1;
      let bestD = Infinity;
      for (let e = 0; e < m.edgeCount; e++) {
        const a = m.edgeList[2 * e];
        const b = m.edgeList[2 * e + 1];
        const dx = m.x[b] - m.x[a];
        const dy = m.y[b] - m.y[a];
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - m.x[a]) * dx + (py - m.y[a]) * dy) / len2)) : 0;
        const d = Math.hypot(px - (m.x[a] + dx * t), py - (m.y[a] + dy * t));
        if (d <= within && d < bestD) { bestD = d; bestE = e; }
      }
      return bestE;
    };
    for (const within of [0, 1e-12, 2.5, 5, 60, 1e6]) {
      for (let i = 0; i < 60; i++) {
        const px = rnd() * 110 - 5;
        const py = rnd() * 110 - 5;
        expect(q.nearest([px, py], { within })?.edge.index ?? -1).toBe(scan(px, py, within));
      }
      // exactly on a lattice vertex: four edges at distance 0, the earliest wins
      const on = q.nearest([25, 40], { within });
      expect(on?.edge.index ?? -1).toBe(scan(25, 40, within));
    }
  });

  it('a long edge beside short ones is still found from far along its length', async () => {
    // the cell is at least the mean edge extent, so the long edge spans many cells
    const m = material([[0, 0], [1000, 3], [1, 1], [1.2, 1], [999, 2], [999.5, 2.4]], { edges: [[0, 1], [2, 3], [4, 5]] });
    const q = m.edges;
    const mid = q.nearest([500, 1.5], { within: 1 })!;
    expect(mid.edge.index).toBe(0);
    expect(q.firstHit([500, -10], [500, 10])!.edge.index).toBe(0);
    expect(q.nearest([500, 1.51], { within: 1e-6 })).toBeNull();
  });
});

describe('correctness pass (review of 22c9887)', () => {
  it('2. derived materials share the topology they did not change', () => {
    const src = square();
    const derived = src.points.set('age', 1);
    expect(derived.store.edgeList).toBe(src.store.edgeList);
    const e2 = src.edges.set('rest', 1);
    expect(e2.store.edgeList).toBe(src.store.edgeList);
    const stepped = toolkit({ seed: 1 }).steps(2, src, (g) => g, { every: 1 });
    expect(stepped.store.edgeList).toBe(src.store.edgeList);
    for (const s of stepped.history) expect(s.store.edgeList).toBe(src.store.edgeList);
    // A write that changes the edges makes a new list and leaves the old one.
    const cut = src.split(src.edges.at(0));
    expect(cut.store.edgeList).not.toBe(src.store.edgeList);
    expect(Array.from(src.edgeList)).toEqual([0, 1, 1, 2, 2, 3, 3, 0]);
  });

  it('3. resample keeps edge attributes at samples that land on existing vertices', () => {
    const chain = material([[0, 0], [10, 0], [20, 0]], { edges: [[0, 1], [1, 2]] }).edges.set('w', (e) => (e.index === 0 ? 10 : 20));
    const same = chain.resample({ count: 3 });
    expect(Array.from(same.x)).toEqual([0, 10, 20]);
    expect(Array.from(same.edgeAttrs.w)).toEqual([10, 20]);
    // a new edge takes the attributes of the source edge under its midpoint
    const denser = chain.resample({ count: 5 });
    expect(Array.from(denser.edgeAttrs.w)).toEqual([10, 10, 20, 20]);
  });

  it('4. append compares effective transfer policies, defaults included', () => {
    const a = curve([[0, 0], [10, 0]], { closed: false, age: 0 }); // age interpolates by default
    const b = curve([[20, 0], [30, 0]], { closed: false }).points.set('age', 5, { transfer: 'nearest' });
    expect(() => append(a, b)).toThrow(/transfer/);
    expect(() => append(b, a)).toThrow(/transfer/);
    const explicit = curve([[20, 0], [30, 0]], { closed: false }).points.set('age', 5, { transfer: 'interpolate' });
    expect(append(a, explicit).transfers.age ?? 'interpolate').toBe('interpolate');
  });

  it('5. joining an existing pair with columns is a no-op and needs no columns', () => {
    const m = curve([[0, 0], [10, 0]], { closed: false }).edges.set('rest', 3);
    const same = m.edges.add([m.points.at(0), m.points.at(1)]);
    expect(same.edgeCount).toBe(1);
    expect(same.edgeAttrs.rest[0]).toBe(3);
    expect(() => m.edges.add([m.points.at(1), m.points.at(0)])).not.toThrow();
    // a genuinely new edge still demands every column
    const three = material([[0, 0], [10, 0], [20, 0]], { edges: [[0, 1]] }).edges.set('rest', 3);
    expect(() => three.edges.add([three.points.at(1), three.points.at(2)])).toThrow(/rest/);
  });

  it('6. firstHit keeps along within [0, 1] for tolerated endpoint contact', async () => {
    const m = material([[10, 0], [20, 0]], { edges: [[0, 1]] });
    const q = m.edges;
    // a move ending just short of the edge's start, within tolerance
    const hit = q.firstHit([0, 0], [10 - 1e-12, 0]);
    if (hit) {
      expect(hit.along).toBeLessThanOrEqual(1);
      expect(hit.along).toBeGreaterThanOrEqual(0);
      expect(hit.t).toBeGreaterThanOrEqual(0);
      expect(hit.t).toBeLessThanOrEqual(1);
      expect(hit.kind).toBe('touch');
    }
    // sweep a few near-endpoint offsets in both branches; nothing may leave its range
    for (const dy of [0, 1e-13, -1e-13]) {
      for (const dx of [-1e-12, 0, 1e-12]) {
        const h = q.firstHit([0, dy], [10 + dx, dy]);
        if (!h) continue;
        expect(h.along).toBeGreaterThanOrEqual(0);
        expect(h.along).toBeLessThanOrEqual(1);
        expect(h.t).toBeGreaterThanOrEqual(0);
        expect(h.t).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('view identity: the brand lives off the view, not on it', () => {
  it('a view enumerates, spreads and serialises as a plain object; copies are not owned', async () => {
    const { ownedBy } = await import('../src/views.js');
    const { viewKind } = await import('../src/views.js');
    const c = curve([[0, 0], [10, 0], [10, 10]], { closed: true, age: [1, 2, 3] });
    const v = c.points.at(1);
    expect(Object.keys(v)).toEqual(['index', 'x', 'y', 'age']);
    expect(JSON.stringify(v)).toBe('{"index":1,"x":10,"y":0,"age":2}');
    expect(v).toEqual({ index: 1, x: 10, y: 0, age: 2 });
    const seen: string[] = [];
    for (const k in v) seen.push(k);
    expect(seen).toEqual(['index', 'x', 'y', 'age']);
    expect(Object.getOwnPropertySymbols(v)).toEqual([]);
    // the brand is readable through the view, and a copy of it is not owned
    expect(ownedBy(v, c)).toBe(true);
    expect(viewKind(v)).toBe('vertex');
    expect(ownedBy({ ...v }, c)).toBe(false);
    expect(viewKind({ ...v })).toBeUndefined();
    expect(ownedBy(Object.assign({}, v), c)).toBe(false);
    expect(ownedBy(v, curve([[0, 0], [10, 0], [10, 10]], { closed: true }))).toBe(false);
    // edges and faces carry their own kind, and a face view is frozen
    const e = c.edge(0);
    expect(viewKind(e)).toBe('edge');
    expect(ownedBy(e, c)).toBe(true);
    expect(Object.keys(e)).toEqual(['a', 'b', 'length', 'index']);
    const f = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true }).faces;
    const { faceTableOf } = await import('../src/faces.js');
    expect(viewKind(f.at(0))).toBe('face');
    expect(ownedBy(f.at(0), faceTableOf(f))).toBe(true);
    expect(Object.isFrozen(f.at(0))).toBe(true);
    expect(Object.keys(f.at(0))).toEqual(['index', 'area', 'perimeter', 'bounds', 'centroid']);
  });
});

it('material(existing) is identity and rejects options instead of ignoring them', () => {
  const m = material([[0, 0], [10, 0]], { edges: [[0, 1]], weight: 2 });
  expect(material(m)).toBe(m);
  expect(material(m, {})).toBe(m);
  expect(() => material(m, { added: 7 })).toThrow(/options.*existing Material/);
  expect(() => material(m, { weight: [3, 4] })).toThrow(/options.*existing Material/);
  expect(() => material(m, { edges: [] })).toThrow(/options.*existing Material/);
  expect([...m.attrs.weight]).toEqual([2, 2]);
  expect(m.edgeCount).toBe(1);
});

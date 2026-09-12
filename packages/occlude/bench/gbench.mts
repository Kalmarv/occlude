// The iterative path: many small calls per step, hundreds of steps. Seeds
// fixed; medians of 5 unless a row says otherwise. Ordinary sizes first, then
// the demanding ones.
import { performance } from 'node:perf_hooks';
import { curve, material, neighbours, sub, mul, length, unit, sum, sumBy, force } from '../src/index.js';

let s = 7;
const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
const med = (label: string, f: () => unknown, runs = 5) => {
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); f(); ms.push(performance.now() - t0); }
  ms.sort((a, b) => a - b);
  console.log(label.padEnd(56), ms[ms.length >> 1].toFixed(0).padStart(6), 'ms', `  (${ms.map((v) => v.toFixed(0)).join(', ')})`);
};

const ring = (n: number, radius: number) => curve(Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return [50 + Math.cos(a) * radius, 50 + Math.sin(a) * radius] as [number, number];
}));

// the ring-growth recipe, written as the sketches write it: user callbacks
// over vertex views, a spatial neighbourhood rebuilt each step
const growth = (start: ReturnType<typeof ring>, steps: number, split: boolean) => {
  const rest = 1.7;
  const push = 2.1;
  const pull = (p: { x: number; y: number }, q: { x: number; y: number }) => {
    const d = sub(q, p);
    return mul(unit(d), Math.max(0, length(d) - rest));
  };
  const repel = (p: { x: number; y: number }, q: { x: number; y: number }) => {
    const d = sub(p, q);
    return mul(unit(d), (1 - length(d) / push) * push);
  };
  return start.steps(steps, (cur, next) => {
    const near = neighbours(cur, { radius: push });
    for (const p of cur.points) {
      const prev = cur.prev(p.index);
      const nxt = cur.next(p.index);
      const f = sum(
        sumBy([prev, nxt], (jj) => pull(p, cur.vertex(jj))),
        sumBy(near(p), (jj) => (jj === prev || jj === nxt ? [0, 0] : repel(p, cur.vertex(jj)))),
      );
      next.move(p.index, mul(f, 0.15));
    }
  }, (cur, next) => {
    if (split) next.splitEdges(cur.edges.filter((e) => e.length > 0.9 && rnd() < 0.25), { attributes: {} });
  });
};

med('growth: 500-vertex ring, 40 steps, no split', () => growth(ring(500, 20), 40, false), 3);
med('growth: 2 000-vertex ring, 40 steps, no split', () => growth(ring(2000, 60), 40, false), 3);
console.log(`  -> a splitting run grows: 48 vertices, 195 steps`);
med('growth: the ring-growth-alt shape (48 → n, 195 steps)', () => growth(ring(48, 6), 195, true), 3);

// the machinery a step pays for, isolated from the user's force callbacks
for (const n of [2000, 20000]) {
  const r = ring(n, n / 100);
  med(`${n}: cur.points (a view per vertex)`, () => r.points);
  med(`${n}: cur.edges (a view per edge, two per view)`, () => r.edges);
  med(`${n}: neighbours prepare`, () => neighbours(r, { radius: 2 }));
  const near = neighbours(r, { radius: 2 });
  const pts = r.points;
  med(`${n}: neighbours query ×n`, () => { for (const p of pts) near(p); });
  med(`${n}: steps(1), move only`, () => r.steps(1, (cur, next) => { for (const p of cur.points) next.move(p.index, [0.01, 0]); }));
  med(`${n}: steps(1), split every edge`, () => r.steps(1, (_c, next) => next.splitEdges(_c.edges.filter(() => true), { attributes: {} })));
  const sep = force.separation(r, { radius: 2, excludeConnected: true });
  med(`${n}: force.separation evaluate ×n`, () => { for (const p of pts) sep(p); });
}

// demanding: one very large state, one very long run
med('200 000-vertex ring: points + one move step', () => {
  const big = ring(200000, 300);
  big.steps(1, (cur, next) => { for (const p of cur.points) next.move(p.index, [0.01, 0]); });
}, 3);
med('2 000 steps of a 200-vertex ring', () => growth(ring(200, 8), 2000, false), 3);
// a state with no edges at all: adjacency, chains and edge views on nothing
med('100 000 isolated points: 50 move steps', () => {
  const dust = material(Array.from({ length: 100000 }, () => [rnd() * 100, rnd() * 100] as [number, number]));
  dust.steps(50, (cur, next) => { for (const p of cur.points) next.move(p.index, [0.001, 0]); });
}, 3);

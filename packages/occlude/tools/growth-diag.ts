#!/usr/bin/env tsx
/**
 * Growth diagnostics: run the ring-growth rules (copied from the study
 * sketches — recipes are meant to be copied) with instrumentation at
 * regular iteration intervals, under a time budget, and report where the
 * cost goes. Simulation only: no drawing interpretation, no engine render.
 *
 *   pnpm --filter occlude growth-diag --rule alt --splitAt 0.6 --budget 20 --every 10
 *
 * Per interval: iteration, points, splits in the interval, spatial-query
 * candidates examined vs actual neighbours within the radius, interval
 * ms, and points retained in history (0 without --history).
 */
import { curve, neighbours, sub, mul, length, unit, limit, perp, sum, sumBy, type Curve, type NeighbourStats, type Vertex } from '../src/index.js';
import { Rng } from '../src/random.js';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const num = (k: string, d: number) => Number(opt(k, String(d)));
const ruleName = opt('rule', 'base');
const iterations = num('iterations', 160);
const every = num('every', 10);
const budgetMs = num('budget', 20) * 1000;
const rest = num('rest', ruleName === 'alt' ? 1.0 : 0.8);
const push = num('push', 2.0);
const splitAt = num('splitAt', 0.9);
const grow = num('grow', 0.25);
const speed = num('speed', 0.15);
const wander = num('wander', 0.12);
const swirl = num('swirl', 0.35);
const withHistory = args.includes('--history');

// Seeded chance/noise stand-ins for the toolkit's, so the run is repeatable.
const rng = new Rng(3);
const chance = (p: number) => rng.float() < p;
const noiseAngle = (x: number, y: number, k: number) => ((Math.sin(x * 0.08) + Math.cos(y * 0.08) + Math.sin(k * 0.01)) / 3 + 1) * Math.PI;

const start = curve(
  Array.from({ length: 48 }, (_, i) => {
    const a = (i / 48) * Math.PI * 2;
    const r = 6 + (rng.float() - 0.5) * 0.6;
    return [50 + Math.cos(a) * r, 50 + Math.sin(a) * r] as [number, number];
  }),
  { age: 0 },
);

const stats: NeighbourStats = { queries: 0, candidates: 0, hits: 0 };

const slackPull = (p: Vertex, q: Vertex) => { const d = sub(q, p); return mul(unit(d), Math.max(0, length(d) - rest)); };
const repelFrom = (p: Vertex, q: Vertex) => { const d = sub(p, q); return mul(unit(d), (1 - length(d) / push) * push); };
const spring = (p: Vertex, q: Vertex) => { const d = sub(q, p); return mul(unit(d), length(d) - rest); };
const shove = (p: Vertex, q: Vertex) => {
  const delta = sub(p, q);
  const d = Math.max(length(delta), 0.2);
  const away = mul(unit(delta), 0.2 / (d * d));
  return sum(away, mul(perp(away), swirl));
};

const rule = ruleName === 'alt'
  ? (current: Curve, next: import('../src/index.js').Next) => {
      const near = neighbours(current, { radius: push, stats });
      for (const p of current.points) {
        const prev = current.prev(p.index);
        const nxt = current.next(p.index);
        const force = sum(
          sumBy([prev, nxt], (j) => spring(p, current.vertex(j))),
          sumBy(near(p), (j) => (j === prev || j === nxt ? [0, 0] : shove(p, current.vertex(j)))),
        );
        next.move(p.index, limit(mul(force, speed), splitAt / 2));
        next.set(p.index, { age: p.age + 1 });
      }
      next.splitEdges((e) => e.length > splitAt && chance(grow), { attributes: { age: 0 } });
    }
  : (current: Curve, next: import('../src/index.js').Next, k: number) => {
      const near = neighbours(current, { radius: push, stats });
      for (const p of current.points) {
        const prev = current.prev(p.index);
        const nxt = current.next(p.index);
        const a = noiseAngle(p.x, p.y, k);
        const force = sum(
          sumBy([prev, nxt], (j) => slackPull(p, current.vertex(j))),
          sumBy(near(p), (j) => (j === prev || j === nxt ? [0, 0] : repelFrom(p, current.vertex(j)))),
          [Math.cos(a) * wander, Math.sin(a) * wander],
        );
        next.move(p.index, mul(force, speed));
        next.set(p.index, { age: p.age + 1 });
      }
      next.splitEdges((e) => e.length > splitAt && chance(grow), { attributes: { age: 0 } });
    };

console.log(`rule=${ruleName} rest=${rest} push=${push} splitAt=${splitAt} grow=${grow} speed=${speed} history=${withHistory ? `every ${every}` : 'off'} budget=${budgetMs / 1000}s`);
console.log('iter   points  splits  candidates     hits  cand/pt  hits/pt   ms   histPts');
let cur = start;
let historyPts = 0;
const t0 = performance.now();
let done = 0;
let interval = 0;
while (done < iterations) {
  const n = Math.min(every, iterations - done);
  const before = cur.n;
  stats.queries = stats.candidates = stats.hits = 0;
  const ti = performance.now();
  const out = cur.steps(n, rule, withHistory ? { every: 1 } : {});
  const ms = performance.now() - ti;
  if (withHistory) historyPts += out.history.slice(1).reduce((s, h) => s + h.curve.n, 0);
  cur = out;
  done += n;
  interval++;
  const q = Math.max(1, stats.queries);
  console.log(
    `${String(done).padStart(4)} ${String(cur.n).padStart(8)} ${String(cur.n - before).padStart(7)} ${String(stats.candidates).padStart(11)} ${String(stats.hits).padStart(8)} ${(stats.candidates / q).toFixed(1).padStart(8)} ${(stats.hits / q).toFixed(1).padStart(8)} ${ms.toFixed(0).padStart(5)} ${String(historyPts).padStart(9)}`,
  );
  if (performance.now() - t0 > budgetMs) {
    console.log(`budget exhausted at iteration ${done} of ${iterations} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    break;
  }
}
console.log(`total ${((performance.now() - t0) / 1000).toFixed(2)} s, final ${cur.n} points, iteration ${cur.iteration}`);

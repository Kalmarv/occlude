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
import { curve, neighbours, sub, mul, length, unit, limit, perp, sum, sumBy, type Mesh, type NeighbourStats, type Vertex, type Next } from '../src/index.js';
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
// --material: each edge keeps its own rest length (start-vertex column),
// halved into both children at a split — the ring-growth-material variant.
const material = args.includes('--material');
// Isolation switches: which chain pull and which repulsion each rule uses.
const pullKind = opt('pull', ruleName === 'alt' ? 'spring' : 'slack');
const repelKind = opt('repel', ruleName === 'alt' ? 'inverse' : 'linear');

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
  material ? { age: 0, rest } : { age: 0 },
);

const stats: NeighbourStats = { queries: 0, candidates: 0, hits: 0 };
const moves: number[] = [];
let capped = 0;

const slackPull = (p: Vertex, q: Vertex) => { const d = sub(q, p); return mul(unit(d), Math.max(0, length(d) - rest)); };
const repelFrom = (p: Vertex, q: Vertex) => { const d = sub(p, q); return mul(unit(d), (1 - length(d) / push) * push); };
const spring = (p: Vertex, q: Vertex) => { const d = sub(q, p); return mul(unit(d), length(d) - rest); };
const shove = (p: Vertex, q: Vertex) => {
  const delta = sub(p, q);
  const d = Math.max(length(delta), 0.2);
  const away = mul(unit(delta), 0.2 / (d * d));
  return sum(away, mul(perp(away), swirl));
};

const pull = pullKind === 'spring' ? spring : slackPull;
const repel = repelKind === 'inverse' ? shove : repelFrom;
const rule = ruleName === 'alt'
  ? (current: Mesh, next: Next) => {
      const near = neighbours(current, { radius: push, stats });
      for (const p of current.points) {
        const prev = current.prev(p.index);
        const nxt = current.next(p.index);
        const force = sum(
          sumBy([prev, nxt], (j) => pull(p, current.vertex(j))),
          sumBy(near(p), (j) => (j === prev || j === nxt ? [0, 0] : repel(p, current.vertex(j)))),
        );
        const step = limit(mul(force, speed), splitAt / 2);
        if (length(mul(force, speed)) > splitAt / 2) capped++;
        moves.push(length(step));
        next.move(p.index, step);
        next.set(p.index, { age: p.age + 1 });
      }
      next.splitEdges((e) => e.length > splitAt && chance(grow), { attributes: { age: 0 } });
    }
  : (current: Mesh, next: Next, k: number) => {
      const near = neighbours(current, { radius: push, stats });
      for (const p of current.points) {
        const prev = current.prev(p.index);
        const nxt = current.next(p.index);
        const a = noiseAngle(p.x, p.y, k);
        const edgeRest = (j: number) => (material ? current.attrs.rest[j] : rest);
        const pullEdge = (q: Vertex, r: number) => {
          const d = sub(q, p);
          return mul(unit(d), Math.max(0, length(d) - r));
        };
        const force = sum(
          material
            ? sum(pullEdge(current.vertex(prev), edgeRest(prev)), pullEdge(current.vertex(nxt), edgeRest(p.index)))
            : sumBy([prev, nxt], (j) => pull(p, current.vertex(j))),
          sumBy(near(p), (j) => (j === prev || j === nxt ? [0, 0] : repel(p, current.vertex(j)))),
          [Math.cos(a) * wander, Math.sin(a) * wander],
        );
        const step = mul(force, speed);
        moves.push(length(step));
        next.move(p.index, step);
        next.set(p.index, { age: p.age + 1 });
      }
      if (material) {
        next.splitEdges((e) => e.length > splitAt && chance(grow), {
          attributes: (e) => ({ age: 0, rest: e.a.rest * 0.5 }),
          parent: (e) => ({ rest: e.a.rest * 0.5 }),
        });
      } else {
        next.splitEdges((e) => e.length > splitAt && chance(grow), { attributes: { age: 0 } });
      }
    };

console.log(`rule=${ruleName}${material ? ' MATERIAL' : ''} pull=${pullKind} repel=${repelKind} rest=${rest} push=${push} splitAt=${splitAt} grow=${grow} speed=${speed} history=${withHistory ? `every ${every}` : 'off'} budget=${budgetMs / 1000}s`);
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
  // One iteration at a time so the budget is checked between iterations —
  // an explosive interval must not run for minutes before it reports.
  let out = cur;
  let ran = 0;
  let over = false;
  for (let i = 0; i < n; i++) {
    out = out.steps(1, rule);
    ran++;
    if (withHistory) historyPts += out.n;
    if (performance.now() - t0 > budgetMs) { over = true; break; }
  }
  const ms = performance.now() - ti;
  cur = out;
  done += ran;
  interval++;
  const q = Math.max(1, stats.queries);
  console.log(
    `${String(done).padStart(4)} ${String(cur.n).padStart(8)} ${String(cur.n - before).padStart(7)} ${String(stats.candidates).padStart(11)} ${String(stats.hits).padStart(8)} ${(stats.candidates / q).toFixed(1).padStart(8)} ${(stats.hits / q).toFixed(1).padStart(8)} ${ms.toFixed(0).padStart(5)} ${String(historyPts).padStart(9)}`,
  );
  if (over) {
    console.log(`budget exhausted at iteration ${done} of ${iterations} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    break;
  }
}
console.log(`total ${((performance.now() - t0) / 1000).toFixed(2)} s, final ${cur.n} points, iteration ${cur.iteration}${material ? `, total rest ${Array.from(cur.attrs.rest).reduce((a, b) => a + b, 0).toFixed(3)}` : ''}`);

// ---- shape of the final curve: what the pen will see ----
const pct = (xs: number[], q: number) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
const edgeLen = cur.edges.map((e) => e.length);
const turn: number[] = [];
for (let i = 0; i < cur.n; i++) {
  const a = cur.vertex(cur.prev(i)); const b = cur.vertex(i); const c = cur.vertex(cur.next(i));
  const u = unit(sub(b, a)); const v = unit(sub(c, b));
  turn.push(Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI);
}
const fmt = (xs: number[]) => `p10 ${pct(xs, 0.1).toFixed(2)}  median ${pct(xs, 0.5).toFixed(2)}  p90 ${pct(xs, 0.9).toFixed(2)}  max ${xs.reduce((m, v) => (v > m ? v : m), -Infinity).toFixed(2)}`;
console.log(`edge length      ${fmt(edgeLen)}`);
console.log(`turn per vertex° ${fmt(turn)}   (share > 45°: ${(100 * turn.filter((t) => t > 45).length / turn.length).toFixed(1)}%)`);
console.log(`step per point   ${fmt(moves)}   capped: ${(100 * capped / Math.max(1, moves.length)).toFixed(1)}% of moves`);

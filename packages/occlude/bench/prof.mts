import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as O from '../src/index.js';
// `neighbours` is the internal machinery behind `points.near`; it is not
// on the public surface (the vocabulary word is `points.near`), but a
// bench profiling the primitive itself imports it directly.
import { neighbours } from '../src/forces.js';
const { material, curve, connect, force, mul, segmentRuns, initOcclude, sketch, circle, render, planBuffer, decodePlanBuffer, hashPlan, planToolpath, makePlan, selectAll, Execution, bindToolkit } = O;
const t = (label: string, f: () => unknown, n = 1) => { const t0 = performance.now(); let r; for (let i = 0; i < n; i++) r = f(); const ms = (performance.now() - t0) / n; console.log(label.padEnd(58), ms.toFixed(2).padStart(9), 'ms'); return r; };
let s = 11; const rnd = (a = 0, b = 1) => ((s = (s * 48271) % 2147483647) / 2147483647) * (b - a) + a;
const noise = (x: number, y: number, z = 0) => Math.sin(x * 0.7 + z) * Math.cos(y * 0.9 - z);

// A bare toolkit, bound to a fresh execution, so `tk.steps` works outside a
// sketch function.
const freshToolkit = () => { const exec = new Execution({ paper: { w: 200, h: 200 } }); exec.begin({}); return bindToolkit(exec); };

// ---- growth: ring under tension + separation + drift, split when long ----
for (const N of [500, 2000, 5000]) {
  let ring = curve(Array.from({ length: N }, (_, i) => { const a = (i / N) * Math.PI * 2; return [50 + Math.cos(a) * 20, 50 + Math.sin(a) * 20] as [number, number]; }), { age: 0 });
  const tk = freshToolkit();
  const wander = force.drift(noise, { amount: 0.3, rate: 0.01 });
  // One step: a push pass (tension + separation + drift, then age++) and a
  // grow pass (split long edges, new points reset to age 0 — new rows land
  // at the end of the points table).
  const push = (cur: typeof ring) => {
    const pull = force.tension(cur, { rest: 1.0 });
    const repel = force.separation(cur, { radius: 2, excludeConnected: true });
    return cur.move((p) => mul(O.sum(pull(p), repel(p), wander(p)), 0.15)).points.set('age', (p) => p.age + 1);
  };
  const grow = (cur: typeof ring) => {
    const before = cur.n;
    const cut = cur.split(cur.edges.filter((e) => e.length > 1.3));
    return cut.points.set('age', 0, cut.points.slice(before));
  };
  console.log(`\n== growth ring N=${N}`);
  t(`  one step (steps(1))`, () => { ring = tk.steps(1, ring, push, grow); }, 3);
  const cur = ring;
  t(`  cur.points (view creation, ${cur.n} views)`, () => cur.points, 5);
  t(`  force.separation prepare (grid)`, () => force.separation(cur, { radius: 2, excludeConnected: true }), 5);
  const repel = force.separation(cur, { radius: 2, excludeConnected: true });
  const pts = cur.points;
  t(`  separation evaluate ×N`, () => { for (const p of pts) repel(p); }, 3);
  const pull = force.tension(cur, { rest: 1 });
  t(`  tension evaluate ×N`, () => { for (const p of pts) pull(p); }, 3);
  t(`  neighbours(cur,{radius:2}) build`, () => neighbours(cur, { radius: 2 }), 5);
  t(`  steps(1, move only)`, () => tk.steps(1, cur, (c) => c.move((p) => [0.01, 0])), 3);
  t(`  steps(1, splitEdges all)`, () => tk.steps(1, cur, (c) => { const before = c.n; const cut = c.split(c.edges.filter(() => true)); return cut.points.set('age', 0, cut.points.slice(before)); }), 2);
  t(`  curves()`, () => cur.curves(), 5);
  t(`  segmentRuns by age band`, () => segmentRuns(cur, (e) => Math.floor(((e.a.age + e.b.age) / 2) / 5)), 3);
  t(`  resample({spacing:1})`, () => cur.resample({ spacing: 1 }), 3);
  t(`  filter + extract half`, () => cur.edges.filter((e) => e.index % 2 === 0).extract(), 3);
}
// ---- topology at scale ----
console.log('\n== topology');
let net = material([]);
for (let i = 0; i < 400; i++) net = O.append(net, material([[rnd(0, 100), rnd(0, 100)], [rnd(0, 100), rnd(0, 100)]], { edges: [[0, 1]] }));
t(`  append ×400 (incremental, O(n²) total)`, () => { let m = material([]); for (let i = 0; i < 400; i++) m = O.append(m, material([[rnd(0, 100), rnd(0, 100)], [rnd(0, 100), rnd(0, 100)]], { edges: [[0, 1]] })); return m; });
const pn = t(`  planarize 400 chords`, () => net.planarize()) as O.Material;
console.log(`     -> ${pn.n} vertices ${pn.edgeCount} edges`);
const fc = t(`  faces of it`, () => pn.faces()) as O.Faces;
t(`  faces.filter area>1 + contours`, () => fc.filter((f) => f.area > 1).contours());
t(`  pn.curves()`, () => pn.curves(), 3);
t(`  pn.edges (views)`, () => pn.edges, 3);
t(`  query.edges prepare + 1000 firstHit`, () => { const q = O.query.edges(pn); for (let i = 0; i < 1000; i++) q.firstHit([rnd(0, 100), rnd(0, 100)], [rnd(0, 100), rnd(0, 100)]); });
const tri = connect.triangulate(Array.from({ length: 5000 }, () => [rnd(0, 100), rnd(0, 100)] as [number, number]));
t(`  triangulate 5000 pts (d3) -> ${tri.edgeCount} edges`, () => connect.triangulate(Array.from({ length: 5000 }, () => [rnd(0, 100), rnd(0, 100)] as [number, number])));
t(`  tri.faces()`, () => tri.faces());
t(`  components(tri)`, () => tri.points.components(), 3);
// ---- plan pipeline crossings on a dense drawing ----
console.log('\n== plan pipeline (wasm crossings)');
await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
const dense = sketch({ aspect: [1, 1], seed: 3 }, (tk) => tk.times(60, (i) => tk.times(60, (j) => circle(2 + i * 1.6, 2 + j * 1.6, 0.6))));
const r = t(`  render 3600 circles`, () => render(dense, { paper: 'Square20' })) as O.RenderResult;
console.log(`     -> ${r.frags.length} frags, raw prims ${r.raw.prims.length} f64, frags ${r.raw.frags.length} f64`);
const pb = t(`  wasm_plan (merge+tour+bridge, encode)`, () => planBuffer(r)) as ReturnType<typeof planBuffer>;
console.log(`     -> plan buffer ${pb.buffer.length} f64 = ${(pb.buffer.byteLength / 1024).toFixed(0)} KB`);
t(`  decodePlanBuffer (JS objects)`, () => decodePlanBuffer(pb.buffer), 3);
const t0 = performance.now(); const p = await makePlan(pb.buffer, pb.settings); console.log('  makePlan (decode + sha256)'.padEnd(58), (performance.now() - t0).toFixed(2).padStart(9), 'ms');
const flat = t(`  planToolpath full (wasm flatten + parse)`, () => planToolpath(p, selectAll(p), 0.05)) as O.FlatChain[];
console.log(`     -> ${flat.length} chains, ${flat.reduce((a, c) => a + c.pts.length, 0)} f64`);
t(`  schedulePlan (JS)`, () => O.schedulePlan(flat, () => ({ feed: 3000, penDelay: 100 }), { travelFeed: 6000, acceleration: 800, travelAcceleration: 1500, junctionDeviation: 0.05, minimumCruiseRatio: 0.5 }), 3);
t(`  planSvg full`, () => O.planSvg(p, selectAll(p), O.DEFAULT_PENS));

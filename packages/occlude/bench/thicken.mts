// pnpm exec tsx bench/thicken.mts [--baseline ../src/.thicken-baseline.ts]
// Save the pre-change module beside thicken.ts so both use the same Material
// class. Comparisons include exact array bytes and the complete callback stream.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { material, curve, connect, thicken, type Material, type ThickenOpts } from '../src/index.js';

const baselineArg = process.argv.indexOf('--baseline');
const baseline: typeof thicken | undefined = baselineArg < 0 ? undefined
  : (await import(pathToFileURL(resolve(process.argv[baselineArg + 1])).href)).thicken;
const profile = process.argv.includes('--profile');
const runs = profile ? 15 : 5;
let seed = 42;
const rnd = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
const cloud = (n: number, width: number) => material(Array.from({ length: n }, () => [rnd() * width, rnd() * width]));
const fixtures: [string, Material, ThickenOpts][] = [
  ['separate discs / 2000', material(Array.from({ length: 2000 }, (_, i) => [(i % 50) * 4, Math.floor(i / 50) * 4])), { radius: 0.6 }],
  ['overlapping discs / 600', cloud(600, 60), { radius: 2 }],
  ['nearest network / 700', connect.nearest(cloud(700, 150), { count: 3 }), { radius: 0.6 }],
  ['variable chain / 1500', curve(Array.from({ length: 1500 }, (_, i) => [i * 0.1, 10 * Math.sin(i * 0.04)]), { closed: false }).attribute('width', p => 0.3 + (1 + Math.sin(p.x)) * 0.3), { radius: p => p.width }],
  ['long crossing lines / 100', material(Array.from({ length: 200 }, (_, i) => [i % 2 ? 100 : 0, rnd() * 100]), { edges: Array.from({ length: 100 }, (_, i) => [2 * i, 2 * i + 1]) }), { radius: 0.2 }],
  ['near tangent / subtraction', material([[-1, 0], [0.9999999999999999, 0]]), { radius: 1 }],
  ['near tangent / height', material([[0, 0], [2 * Math.cos(0.1), 2 * Math.sin(0.1)]]), { radius: 1 }],
];

function fingerprint(fn: typeof thicken, source: Material, opts: ThickenOpts): string {
  const hash = createHash('sha256');
  const addArrays = (out: Material) => {
    for (const array of [out.x, out.y, out.edgeList]) {
      hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    }
    for (const name of out.attrNames) {
      hash.update(name);
      const values = Float64Array.from({ length: out.n }, (_, i) => out.vertex(i)[name]);
      hash.update(Buffer.from(values.buffer));
    }
  };
  addArrays(fn(source, opts));
  const out = fn(source, { ...opts, point: event => {
    hash.update(JSON.stringify(event, (_, value) => Object.is(value, -0) ? '-0' : value));
    return { candidates: event.candidates.length };
  } });
  addArrays(out);
  return hash.digest('hex');
}

if (process.argv.includes('--verify')) {
  let failures = 0;
  for (let i = 0; i < 800; i++) {
    const count = 1 + Math.floor(rnd() * 6);
    const source = cloud(count, 20).attribute('radius', () => 0.1 + rnd() * 4);
    const edges: [number, number][] = [];
    for (let j = 1; j < count; j++) if (rnd() < 0.7) edges.push([Math.floor(rnd() * j), j]);
    const net = source.withEdges(edges);
    const opts: ThickenOpts = { radius: p => p.radius, tolerance: 0.02 };
    const outcome = (fn: typeof thicken) => {
      try { return fingerprint(fn, net, opts); }
      catch (err) { return `ERROR: ${err instanceof Error ? err.message : String(err)}`; }
    };
    // Without a baseline this is also a no-crash/determinism check of the
    // fractional corpus that originally exposed shared-circle case 211.
    const before = baseline ? outcome(baseline) : fingerprint(thicken, net, opts);
    if (outcome(thicken) !== before) throw new Error(`random case ${i}: output/callback mismatch`);
    if (before.startsWith('ERROR:')) {
      failures++;
      console.log(`unchanged baseline failure at random case ${i}: ${before}`);
    }
  }
  console.log(`${800 - failures} randomized outputs ${baseline ? 'identical to baseline' : 'stable'} (geometry bytes, attributes, callback order/candidates); ${failures} unchanged baseline errors`);
}

for (const [name, source, opts] of fixtures) {
  const hash = fingerprint(thicken, source, opts);
  if (baseline && fingerprint(baseline, source, opts) !== hash) throw new Error(`${name}: output/callback mismatch`);
  const timings: number[][] = [[], []];
  const functions = baseline ? [baseline, thicken] : [thicken];
  for (const fn of functions) { fn(source, opts); fn(source, opts); }
  for (let i = 0; i < runs; i++) {
    // Alternate execution order to limit warm-up/load bias.
    for (const j of i % 2 ? functions.map((_, j) => j).reverse() : functions.map((_, j) => j)) {
      const start = performance.now();
      functions[j](source, opts);
      timings[j].push(performance.now() - start);
    }
  }
  const medians = functions.map((_, j) => timings[j].sort((a, b) => a - b)[runs >> 1]);
  console.log(name.padEnd(30), medians.map(ms => `${ms.toFixed(2)} ms`).join(' -> '), baseline ? `${(medians[0] / medians[1]).toFixed(2)}x` : '', hash.slice(0, 16));
}

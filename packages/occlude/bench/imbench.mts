// Image sampling: the summed-area tables an asset builds once, and the
// per-sample cost a stipple or a flow field pays millions of times.
// Uses the committed studio asset nyx.jpeg. Medians of 5 unless noted.
import { performance } from 'node:perf_hooks';
import { image as sampler, type ImagePlacement } from '../src/imageAsset.js';
import { assetsFromDisk } from '../tools/asset-preload.js';

// `t.image` in a sketch: the run's captured assets, one sampler per call.
const assets = assetsFromDisk(`image('nyx.jpeg')`);
const image = (name: string, place: ImagePlacement) => sampler(assets, name, place);

const med = (label: string, f: () => number, runs = 5) => {
  const ms: number[] = [];
  let sink = 0;
  for (let i = 0; i < runs; i++) { const t0 = performance.now(); sink += f(); ms.push(performance.now() - t0); }
  ms.sort((a, b) => a - b);
  console.log(label.padEnd(52), ms[ms.length >> 1].toFixed(0).padStart(6), 'ms', `  (${ms.map((v) => v.toFixed(0)).join(', ')})  sink ${sink.toFixed(3)}`);
};

const img = image('nyx.jpeg', { x: 0, y: 0, width: 100 });
console.log(`  placed ${img.width.toFixed(1)} × ${img.height.toFixed(1)} sketch units`);

const N = 500_000;
const xs = new Float64Array(N);
const ys = new Float64Array(N);
let s = 9;
for (let i = 0; i < N; i++) {
  xs[i] = ((s = (s * 48271) % 2147483647) / 2147483647) * img.width;
  ys[i] = ((s = (s * 48271) % 2147483647) / 2147483647) * img.height;
}

// the summed-area table is built lazily, once per channel and asset: time
// the first area sample of each channel on a freshly decoded asset
const decoded = Array.from({ length: 3 }, () => assetsFromDisk(`image('nyx.jpeg')`));
med('first area sample per channel (builds 4 SATs)', () => {
  const fresh = sampler(decoded.pop(), 'nyx.jpeg', { x: 0, y: 0, width: 100 });
  return fresh.lum(10, 10, 1) + fresh.a(10, 10, 1) + fresh.field('r', { area: 1 })(10, 10);
}, 3);

med(`${N} × lum (bilinear)`, () => { let a = 0; for (let i = 0; i < N; i++) a += img.lum(xs[i], ys[i]); return a; });
med(`${N} × lum (area 0.5, summed-area)`, () => { let a = 0; for (let i = 0; i < N; i++) a += img.lum(xs[i], ys[i], 0.5); return a; });
const green = img.field('g');
med(`${N} × g (one colour channel as a field)`, () => { let a = 0; for (let i = 0; i < N; i++) a += green(xs[i], ys[i]); return a; });
med(`${N} × edge (four lum samples)`, () => { let a = 0; for (let i = 0; i < N; i++) a += img.edge(xs[i], ys[i]); return a; });
med(`${N} × dir (four lum samples)`, () => { let a = 0; for (let i = 0; i < N; i++) a += img.dir(xs[i], ys[i]); return a; });
med(`${N} × lum outside the placed rect (early out)`, () => { let a = 0; for (let i = 0; i < N; i++) a += img.lum(-1, ys[i]); return a; });

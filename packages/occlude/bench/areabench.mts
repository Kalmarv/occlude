// pnpm --filter occlude exec tsx bench/areabench.mts [baseline-module.ts]
// Median of three warm runs; compare on the same machine, without concurrent gates.
import { pathToFileURL } from 'node:url';
import { areaFill } from '../src/area.js';

type Loop = [number, number][];
const circle = (n: number): Loop => Array.from({ length: n }, (_, i) =>
  [50 + 45 * Math.cos(2 * Math.PI * i / n), 50 + 45 * Math.sin(2 * Math.PI * i / n)]);
const box = (x: number, y: number, w: number, h: number): Loop =>
  [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const grid = [circle(1760),
  ...Array.from({ length: 40 }, (_, i) => box(20 + i, 20, 0.4, 40)),
  ...Array.from({ length: 20 }, (_, i) => box(20, 20.2 + i * 2, 40, 0.4))];
const cases: [string, Loop[], 'evenodd' | 'nonzero'][] = [
  ['circle 20000 / evenodd', [circle(20000)], 'evenodd'],
  ['circle 2000 / nonzero', [circle(2000)], 'nonzero'],
  ['grid 2000 / nonzero', grid, 'nonzero'],
];
const implementations: [string, typeof areaFill][] = [];
if (process.argv[2]) implementations.push(['before', (await import(pathToFileURL(process.argv[2]).href)).areaFill]);
implementations.push(['current', areaFill]);
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const [label, loops, rule] of cases) {
  const results = implementations.map(() => ({ prep: [] as number[], sample: [] as number[], checksum: 0 }));
  for (let run = 0; run < 4; run++) {
    for (let i = 0; i < implementations.length; i++) {
      const [, prepare] = implementations[i];
      const result = results[i];
      const start = performance.now();
      const fill = prepare(loops, rule);
      const ready = performance.now();
      result.checksum = 0;
      for (let j = 0; j < 1000; j++) result.checksum += Math.sign(fill.at((j * 37 % 100) + 0.123, (j * 61 % 100) + 0.357));
      const end = performance.now();
      if (run > 0) { result.prep.push(ready - start); result.sample.push(end - ready); }
    }
  }
  for (let i = 0; i < implementations.length; i++) {
    const [name] = implementations[i];
    const { prep, sample, checksum } = results[i];
    if (checksum !== results[0].checksum) throw new Error(`${label}: sample answers changed`);
    console.log(`${label.padEnd(24)} ${name.padEnd(7)} prepare ${median(prep).toFixed(2)} ms; 1000 samples ${median(sample).toFixed(2)} ms; checksum ${checksum}`);
  }
}

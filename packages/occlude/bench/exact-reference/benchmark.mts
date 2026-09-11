import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  append,
  sketch,
  compileSketch,
  setPaperHint,
  material,
  thicken,
  type Material,
  type ThickenOpts,
} from '../../src/index.js';
const at = process.argv.indexOf('--baseline');
const before: typeof thicken | undefined =
  at < 0
    ? undefined
    : (await import(pathToFileURL(resolve(process.argv[at + 1])).href)).thicken;
function recursive(paper: number, depth: number): Material {
  let source: Material | undefined;
  setPaperHint(paper, paper);
  compileSketch(
    sketch({ aspect: [1, 1], margin: 6, seed: 42 }, (t) => {
      const b = t.bounds();
      let width = 40,
        m = t.material(t.rect(b.cx - 20, b.cy - 20, 40, 40));
      for (let i = 0; i <= depth; i++) {
        const shapes = m
          .along()
          .map((p) =>
            t.rect(p.x - width / 4, p.y - width / 4, width / 2, width / 2),
          );
        m = shapes.reduce((m, s) => append(m, t.material(s)), m);
        width /= 2;
      }
      source = m;
      return [];
    }),
  );
  return source!;
}
const fixtures: [string, Material, ThickenOpts][] = [
  [
    'capsule',
    material(
      [
        [0, 0],
        [10, 1],
      ],
      { edges: [[0, 1]], radius: [1, 2] },
    ),
    { radius: (p) => p.radius },
  ],
  [
    'A / 100 mm / depth 1 / 1..5',
    recursive(100, 1),
    { radius: (p) => 1 + (p.x / 100) * 4 },
  ],
  [
    'A / 304.8 mm / depth 1 / 1..5',
    recursive(304.8, 1),
    { radius: (p) => 1 + (p.x / 100) * 4 },
  ],
  [
    'B / 304.8 mm / depth 3 / 0.1..1',
    recursive(304.8, 3),
    { radius: (p) => 0.1 + (p.x / 100) * 0.9 },
  ],
];
for (const [name, source, opts] of fixtures) {
  for (const [label, fn] of [
    ['before', before],
    ['after', thicken],
  ] as const) {
    if (!fn) continue;
    const times: number[] = [];
    let result: Material | undefined;
    try {
      fn(source, opts); // one warmup
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        result = fn(source, opts);
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          name,
          label,
          inputEdges: source.edgeCount,
          vertices: result!.n,
          loops: result!.curves().length,
          medianMs: times[1],
          maxMs: times[2],
          processPeakRssKiB: process.resourceUsage().maxRSS,
        }),
      );
    } catch (error) {
      console.log(JSON.stringify({ name, label, error: String(error) }));
    }
  }
}

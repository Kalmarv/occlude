#!/usr/bin/env tsx
/**
 * The perf baseline: one repeatable case set, run the way a sketch runs.
 *
 *   pnpm --filter occlude bench                 every case, median of 3
 *   pnpm --filter occlude bench --runs 1        one run each
 *   pnpm --filter occlude bench --only "hatch sphere,merge"
 *   pnpm --filter occlude bench --list
 *   pnpm --filter occlude bench --profile "hatch sphere"   → .cpuprofile
 *
 * Every case goes through exactly the path the docs checker and the studio
 * worker take — `liveExampleToJs` → the sketch runner's `require` →
 * `renderAsync` — so a number here is a number a drawing pays. The cases
 * that quote a docs fence read the fence off the page at run time, so they
 * cannot drift from what the docs show.
 *
 * `--profile <case>` re-runs one case in a child node started with
 * `--cpu-prof`, which writes a V8 CPU profile next to the other scratch
 * files. Profiling a case runs it once, warm-up included: read the profile
 * for shape, not for a wall time.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { findSourceMap, stripTypeScriptTypes } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from 'occlude-core';
import {
  DEFAULT_PAPERS, DEFAULT_PENS, initOcclude, isSketch, isSketchAsync, pensToJson, renderAsync,
  type AsyncSketchDef, type SketchDef,
} from '../src/index.js';
import { docsPaper, liveExampleToJs, parseLiveMeta } from '../src/docsExamples.js';
import { assetsFromDisk } from './asset-preload.js';
import { fillsFromDisk } from './fill-preload.js';
import { requireFor } from './inputs.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const runsWanted = Number(opt('runs') ?? 3);
const only = opt('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const profileCase = opt('profile');
const docsDir = fileURLToPath(new URL('../../../docs/', import.meta.url));
const fixtures = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const studioAssets = fileURLToPath(new URL('../../occlude-studio/assets/', import.meta.url));
const scratchRoot = process.env.BENCH_SCRATCH
  ?? '/tmp/claude-1000/-home-kalmarv-containers-occlude-3d/66e3548a-318c-48de-8b20-e2db1c905da6/scratchpad';
const scratch = `${scratchRoot}/profiles`;

/** The `ts live` fence on a docs page whose source contains `needle`, with
 * the page's own paper settings — read from the page, never copied. */
function fence(page: string, needle: string, edit?: (src: string) => string): Case['load'] {
  return () => {
    const md = readFileSync(docsDir + page, 'utf8');
    const hits = [...md.matchAll(/```ts live([^\n]*)\n([\s\S]*?)```/g)].filter((m) => m[2].includes(needle));
    if (hits.length !== 1) throw new Error(`${page}: ${hits.length} fences contain ${JSON.stringify(needle)} (want exactly 1)`);
    const meta = parseLiveMeta(hits[0][1]);
    return { src: edit ? edit(hits[0][2]) : hits[0][2], paper: docsPaper(meta), marginPct: meta.margin ?? 5 };
  };
}

/** An inline sketch, on the docs' own default sheet. */
function inline(src: string, assetDir?: string): Case['load'] {
  return () => ({ src, paper: { paper: 'Square20' as const }, marginPct: 5, assetDir });
}

interface Loaded { src: string; paper: { paper: string | { w: number; h: number }; landscape?: boolean }; marginPct: number; assetDir?: string }
interface Case {
  name: string;
  /** What makes this case big — the number a later pass would watch. */
  size: string;
  load: () => Loaded;
  /** Also time the plan (merge + tour + bridge + encode) after the render. */
  plan?: boolean;
  runs?: number;
}

const paragraph = 'The pen is the medium. A plotter draws what the sketch says and nothing else, '
  + 'so a stroke that is not wanted is a stroke that was asked for. Occlusion is exact, opt in, '
  + 'and computed before a single line reaches the paper, which is why the preview and the plot agree.';

const CASES: Case[] = [
  {
    name: 'hidden-line bunny',
    size: '69451 tris',
    runs: 1,
    load: inline(`import { sketch, pen, mm } from 'occlude';
import { obj, view, orthographic } from 'occlude/3d';

export default sketch({ aspect: [1, 1], pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, (t) =>
  view(obj(t.asset('stanford-bunny.obj')).scale(20), {
    camera: orthographic({ eye: [6, -8, 5], target: [-0.3, 0, 2.2], span: 4 }),
    stroke: 'ink', creaseAngle: 180,
  }));`, fixtures),
  },
  {
    name: 'hidden-line boxes',
    size: '200 boxes / 2400 tris',
    load: inline(`import { sketch, pen, mm } from 'occlude';
import { box, view, orthographic } from 'occlude/3d';

export default sketch({ aspect: [1, 1], seed: 7, pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, () => {
  const boxes = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 10; j++) {
    const h = 0.4 + ((i * 7 + j * 5) % 6) * 0.35;
    boxes.push(box([0.8, 0.8, h]).translate([i - 9.5, j - 4.5, h / 2]));
  }
  return view(boxes, { camera: orthographic({ eye: [9, -13, 8], span: 17 }), stroke: 'ink', creaseAngle: 20 });
});`),
  },
  {
    name: 'hatch sphere',
    size: '96x48 sphere, 0.4 mm hatch',
    load: inline(`import { sketch, pen, mm } from 'occlude';
import { sphere, view, orthographic } from 'occlude/3d';

export default sketch({ aspect: [1, 1], pens: { ink: pen({ width: mm(0.25), color: '#18202A' }), shade: pen({ width: mm(0.15), color: '#56626A' }) } }, () =>
  view(sphere(1.2, { segments: 96, rings: 48 }), {
    camera: orthographic({ eye: [4, -6, 3], span: 3 }), stroke: 'ink',
    hatch: { spacing: mm(0.4), angle: 35, stroke: 'shade' },
  }));`),
  },
  { name: 'isosurface', size: 'resolution 44', load: fence('reference/3d/primitives.mdx', 'sdf3.blend') },
  {
    name: 'isosurface 2x',
    size: 'resolution 88',
    load: fence('reference/3d/primitives.mdx', 'sdf3.blend', (s) => s.replace('resolution: 44', 'resolution: 88')),
  },
  {
    name: 'boolean box-sphere',
    size: 'sphere 64x32',
    load: inline(`import { sketch, pen, mm } from 'occlude';
import { box, sphere, view, orthographic } from 'occlude/3d';

export default sketch({ aspect: [1, 1], pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, () =>
  view(box(1.4).subtract(sphere(1, { segments: 64, rings: 32 })), {
    camera: orthographic({ eye: [4, -6, 3], span: 2.6 }), stroke: 'ink', creaseAngle: 25,
  }));`),
  },
  {
    name: 'boolean torus-slab',
    size: 'torus 64x24',
    load: inline(`import { sketch, pen, mm } from 'occlude';
import { box, torus, view, orthographic } from 'occlude/3d';

export default sketch({ aspect: [1, 1], pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, () =>
  view(torus(1, 0.38, { segments: 64, tubeSegments: 24 }).subtract(box([4, 4, 0.36]).translate([0, 0, 0.18])), {
    camera: orthographic({ eye: [4, -6, 3], span: 3.2 }), stroke: 'ink', creaseAngle: 25,
  }));`),
  },
  {
    name: 'geodesic',
    size: 'frequency [8,3] = 1940 faces',
    load: inline(`import { sketch, pen, mm } from 'occlude';
import { geodesic, view, orthographic } from 'occlude/3d';

export default sketch({ aspect: [1, 1], pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, () =>
  view(geodesic(1, { frequency: [8, 3] }), {
    camera: orthographic({ eye: [4, 7, 5], span: 2.3 }), stroke: 'ink', creaseAngle: 0,
  }));`),
  },
  {
    name: 'geodesic dual',
    size: 'frequency [8,3] dual',
    load: inline(`import { sketch, pen, mm } from 'occlude';
import { geodesic, view, orthographic } from 'occlude/3d';

export default sketch({ aspect: [1, 1], pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, () =>
  view(geodesic(1, { frequency: [8, 3] }).dual(), {
    camera: orthographic({ eye: [4, 7, 5], span: 2.3 }), stroke: 'ink', creaseAngle: 0,
  }));`),
  },
  { name: 'travelTime', size: '100x100 at spacing 0.5 + isolines', load: fence('fields.md', 't.travelTime({ fromPoints: [[W * 0.78') },
  { name: 'spacefill ivy', size: 'spacing 0.4 mm', load: fence('images.md', 't.spacefill(circle(50, 50, 44)') },
  { name: 'residual portrait', size: '12000 candidate steps', load: fence('images.md', 't.residual(tone, { spacing: mm(0.7) })') },
  { name: 'lattice gray-scott', size: '5000 steps, spacing 1', load: fence('fields.md', 'seeded.steps(5000') },
  { name: 'lattice physarum', size: '60 ticks', load: fence('reference/fields.mdx', 'SENSE = 5') },
  {
    name: 'palette/regions',
    size: 'ivy.png, palette 4 + regions 3',
    load: inline(`import { sketch, dots, polygon, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const img = t.image('ivy.png', { x: 2, y: 2, width: 96 });
  const bands = img.palette(4);
  const regions = img.regions({ count: 3 });
  return [
    bands.map((e) => {
      const near = e.field({ area: 0.35 });
      return dots(t.scatter((x, y) => Math.max(0, near(x, y) * 2 - 1), { spacing: mm(1.4) }));
    }),
    regions.map((r) => polygon(r)),
  ];
});`, studioAssets),
  },
  {
    name: 'text',
    size: '2 x 400 characters',
    load: inline(`import { sketch, strokes, mm } from 'occlude';
import { relief, hersheyDuplex } from 'occlude/fonts';

const words = ${JSON.stringify(paragraph)};

export default sketch({ aspect: [1, 1] }, (t) => {
  const wrap = (n) => words.replace(new RegExp('(.{1,' + n + '})(\\\\s|$)', 'g'), '$1\\n').trim();
  return [
    strokes(t.text(wrap(34), { font: relief, size: 4.2, leading: 7, at: [6, 12] })),
    strokes(t.text(wrap(34), { font: hersheyDuplex, size: 4.2, leading: 7, at: [6, 58] })),
  ];
});`),
  },
  {
    name: 'merge',
    // Not snapped: a lattice makes several crossings land on one coordinate
    // without being provably one point, and planarize refuses that input.
    size: '2000 rects, 128k faces',
    load: inline(`import { sketch, strokes, rect } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 11 }, (t) => {
  const boxes = [];
  for (let k = 0; k < 2000; k++) boxes.push(rect(t.rnd(2, 86), t.rnd(2, 86), t.rnd(4, 12), t.rnd(4, 12)));
  const cells = t.material(...boxes).merge().planarize();
  void cells.faces();
  return strokes(cells);
});`),
  },
  { name: 'symmetry p6m', size: 'cell 26, 3 arcs', load: fence('reference/transforms.mdx', "t.symmetry('p6m'") },
  { name: 'streamlines maxLength', size: 'ivy.png, spacing 0.9-3.3 mm', load: fence('reference/fields.mdx', 'maxLength: (x, y) => mm(img.a(x, y)') },
  {
    name: 'globe contours',
    size: 'geodesic [20,20] dual ×2, displace, isolines count 20, intersections',
    load: () => ({ src: readFileSync(fileURLToPath(new URL('../test/fixtures/globe-contours.ts', import.meta.url)), 'utf8'), paper: { paper: 'Square20' }, marginPct: 5 }),
  },
  {
    name: 'plan (church)',
    size: 'church.svg, A4, render + wasm_plan',
    plan: true,
    load: () => ({
      src: readFileSync(`${scratchRoot}/church.ts`, 'utf8'),
      paper: { paper: 'A4' },
      marginPct: 6,
      assetDir: studioAssets,
    }),
  },
];

if (args.includes('--list')) {
  for (const c of CASES) console.log(c.name);
  process.exit(0);
}

const chosen = CASES.filter((c) => (profileCase ? c.name === profileCase : !only || only.includes(c.name)));
if (chosen.length === 0) {
  console.error(`no case matched (${(profileCase ?? only?.join(',')) ?? ''}) — --list shows them`);
  process.exit(1);
}

// --profile: hand the one case to a child node started with --cpu-prof, so
// the profile holds that case and not the harness around it.
if (profileCase && !args.includes('--child')) {
  mkdirSync(scratch, { recursive: true });
  const self = fileURLToPath(import.meta.url);
  const name = `${profileCase.replace(/[^a-z0-9]+/gi, '-')}.cpuprofile`;
  const r = spawnSync(process.execPath, [
    // The runner transpiles TypeScript onto one long line, so a V8 frame's
    // position means nothing on its own. `--enable-source-maps` makes node
    // keep each module's map, and the child writes them out beside the
    // profile: the reader turns a frame back into file:line with them.
    '--cpu-prof', `--cpu-prof-dir=${scratch}`, `--cpu-prof-name=${name}`, '--enable-source-maps',
    '--import', 'tsx', self, '--profile', profileCase, '--child', '--runs', String(runsWanted),
  ], { stdio: 'inherit', cwd: fileURLToPath(new URL('..', import.meta.url)) });
  console.log(`profile → ${scratch}/${name} (maps: ${scratch}/sourcemaps.json)`);
  process.exit(r.status ?? 0);
}

const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
await initOcclude(readFileSync(wasmPath));

const isDefinition = (v: unknown): v is SketchDef | AsyncSketchDef => isSketch(v) || isSketchAsync(v);

interface Row { name: string; size: string; frags: number; ms: number[]; planMs: number[]; error?: string }
const rows: Row[] = [];

for (const c of chosen) {
  const row: Row = { name: c.name, size: c.size, frags: 0, ms: [], planMs: [] };
  rows.push(row);
  try {
    const { src, paper, marginPct, assetDir } = c.load();
    const js = liveExampleToJs(stripTypeScriptTypes(src, { mode: 'strip' }));
    const runs = c.runs ?? runsWanted;
    for (let i = 0; i < runs; i++) {
      const module = { exports: {} as Record<string, unknown> };
      new Function('require', 'exports', 'module', js)(
        requireFor(DEFAULT_PENS, DEFAULT_PAPERS), module.exports, module,
      );
      const def = (isDefinition(module.exports.default)
        ? module.exports.default
        : Object.values(module.exports).find(isDefinition)) as SketchDef | AsyncSketchDef | undefined;
      if (!def) throw new Error('no sketch exported');
      const t0 = performance.now();
      const out = await renderAsync(def, {
        paper: paper as never, coarsen: 1, marginPct,
        library: structuredClone(DEFAULT_PENS),
        assets: assetsFromDisk(js, assetDir),
        fills: fillsFromDisk(js),
      });
      row.ms.push(performance.now() - t0);
      row.frags = out.frags.length;
      if (c.plan) {
        const t1 = performance.now();
        (core as never as { wasm_plan(p: Float64Array, f: Float64Array, pens: string, b: number, g: number): Float64Array })
          .wasm_plan(out.raw.prims, out.raw.frags, pensToJson(out.pens), 200_000, -1);
        row.planMs.push(performance.now() - t1);
      }
    }
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    console.error(`${c.name}: ${median(row.ms).toFixed(0)} ms, ${row.frags} frags`);
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
    console.error(`${c.name}: FAILED ${row.error}`);
  }
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (n: number): string => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
console.log('');
console.log('| case | size | frags | median ms | runs |');
console.log('| --- | --- | ---: | ---: | ---: |');
for (const r of rows) {
  if (r.error) { console.log(`| ${r.name} | ${r.size} | — | FAILED: ${r.error} | — |`); continue; }
  const plan = r.planMs.length ? ` (+${fmt(median(r.planMs))} plan)` : '';
  console.log(`| ${r.name} | ${r.size} | ${r.frags} | ${fmt(median(r.ms))}${plan} | ${r.ms.length} |`);
}

// In the profiled child: every library module node kept a map for, written
// out so the profile's one-line positions can be read as file:line.
if (args.includes('--child')) {
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
  const maps: Record<string, unknown> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const sm = findSourceMap(pathToFileURL(p).href);
        if (sm) maps[pathToFileURL(p).href] = sm.payload;
      }
    }
  };
  walk(srcRoot);
  writeFileSync(`${scratch}/sourcemaps.json`, JSON.stringify(maps));
}

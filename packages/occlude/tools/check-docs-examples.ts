#!/usr/bin/env tsx
/**
 * Docs example checker: every `ts live` fence on every topic page under
 * docs/ (the same pages the docs site lists) and in the gallery must
 * execute and render to visible strokes against the CURRENT engine, on the
 * same sheet the docs site shows it on. A fence may carry settings after
 * `ts live`: `paper=A5`, `paper=120x80`, `margin=8`, `landscape`. Ink
 * outside the drawable is reported (an honest frame, not a crop, is what
 * the site shows). Run before committing doc changes:
 *
 *   pnpm --filter occlude docs:check
 *   pnpm --filter occlude docs:check --times   # per-fence ms, slowest ten
 *   pnpm --filter occlude docs:check --space hyperbolic   # the whole corpus
 *                                                        # in a curved space
 *
 * `--space <kind>` injects `space` into every fence's own config before the
 * run, so the corpus becomes the coverage test for a geometry: a word that
 * has not been taught the space draws through the projection and measures
 * flat, and it must not throw. It is an EXPERIMENT — the hashes are never
 * saved with it, and `docs:hashes` knows nothing about it.
 *
 * Uses the same import/export transform the docs page applies in-browser,
 * so a fence that passes here runs there.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOC_PAGES, parseLiveMeta, docsPaper } from '../src/docsExamples.js';
import * as occlude from '../src/index.js';
import {
  initOcclude, isSketch, isSketchAsync, renderAsync,
  DEFAULT_PENS, paperSize, type SketchDef, type AsyncSketchDef, DEFAULT_PAPERS } from '../src/index.js';
import { liveExampleToJs } from '../src/docsExamples.js';
import { assetsFromDisk } from './asset-preload.js';
import { fillsFromDisk } from './fill-preload.js';
import { requireFor } from './inputs.js';

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await initOcclude(readFileSync(wasmPath));
const readme = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');
// Every live fence on every listed page, with its own settings; the
// README's headline example is the deleted-API canary: it runs too.
const fences: { src: string; meta: ReturnType<typeof parseLiveMeta>; page: string }[] = [];
// `DOCS_PAGE=fills` (comma-separated slugs) checks a subset while editing.
const only = process.env.DOCS_PAGE?.split(',').filter(Boolean);
for (const page of DOC_PAGES.filter((p) => p.live && (!only || only.includes(p.slug)))) {
  const md = readFileSync(fileURLToPath(new URL(`../../../docs/${page.file}`, import.meta.url)), 'utf8');
  for (const m of md.matchAll(/```ts live([^\n]*)\n([\s\S]*?)```/g)) fences.push({ src: m[2], meta: parseLiveMeta(m[1]), page: page.slug });
}
for (const m of only ? [] : readme.matchAll(/```ts\n([\s\S]*?)```/g)) {
  if (m[1].includes('export default sketch')) fences.push({ src: m[1], meta: parseLiveMeta(''), page: 'readme' });
}
if (fences.length === 0) {
  console.error('no `ts live` fences found — wrong file?');
  process.exit(1);
}

let failed = 0;
let outside = 0;
// `--times` adds each fence's own render time to its line and lists the ten
// slowest at the end — what a perf pass needs from a run the checker already
// makes. It measures, it never changes what is checked.
const times = process.argv.includes('--times');
const spaceArg = process.argv[process.argv.indexOf('--space') + 1];
const injectSpace = process.argv.includes('--space') && spaceArg && !spaceArg.startsWith('--') ? spaceArg : undefined;
if (injectSpace) console.log(`running the corpus with space: '${injectSpace}'`);
const timed: { ms: number; page: string; n: number; head: string }[] = [];
for (const [i, { src, meta, page }] of fences.entries()) {
  // First line of the example names it in failures.
  const head = src.split('\n').find((l) => l.trim() && !l.startsWith('import')) ?? `#${i}`;
  try {
    const js = liveExampleToJs(src);
    const module = { exports: {} as Record<string, unknown> };
    new Function('require', 'exports', 'module', js)(
      requireFor(DEFAULT_PENS, DEFAULT_PAPERS),
      module.exports,
      module,
    );
    const isDefinition = (v: unknown): v is SketchDef | AsyncSketchDef => isSketch(v) || isSketchAsync(v);
    const def = (isDefinition(module.exports.default)
      ? module.exports.default
      : Object.values(module.exports).find(isDefinition)) as SketchDef | AsyncSketchDef | undefined;
    if (!def) throw new Error('no sketch exported');
    // The fence's own config, under the space this run asks for. The
    // definition is a plain record, so a copy of it is one too.
    const run = injectSpace ? { ...def, config: { ...def.config, space: injectSpace } } as typeof def : def;
    const sheet = docsPaper(meta);
    const t0 = performance.now();
    const out = await renderAsync(run, { paper: sheet, coarsen: 1, marginPct: meta.margin ?? 5, library: structuredClone(DEFAULT_PENS), assets: assetsFromDisk(js), fills: fillsFromDisk(js) });
    const ms = performance.now() - t0;
    if (times) timed.push({ ms, page, n: i + 1, head });
    if (out.stats.fragments === 0) throw new Error('rendered zero visible strokes');
    // How much of the ink lies outside the drawable? (on paper but off the
    // frame is allowed; a drawing that mostly misses its frame is reported)
    const f = out.frame;
    const x0 = f.offsetX; const y0 = f.offsetY; const x1 = x0 + f.inner.innerW; const y1 = y0 + f.inner.innerH;
    let off = 0;
    for (const frag of out.frags) {
      const [ax, ay] = occlude.evalPrim(frag.geom, 0.5);
      if (ax < x0 - 0.5 || ax > x1 + 0.5 || ay < y0 - 0.5 || ay > y1 + 0.5) off++;
    }
    const share = off / out.frags.length;
    // and how much of the drawable does the ink's box cover? A drawing
    // that fills a quarter of its frame is framed for a different frame.
    let bx0 = Infinity; let by0 = Infinity; let bx1 = -Infinity; let by1 = -Infinity;
    for (const frag of out.frags) for (const s of [0, 0.5, 1]) { const [px, py] = occlude.evalPrim(frag.geom, s); bx0 = Math.min(bx0, px); by0 = Math.min(by0, py); bx1 = Math.max(bx1, px); by1 = Math.max(by1, py); }
    const cover = ((Math.min(bx1, x1) - Math.max(bx0, x0)) * (Math.min(by1, y1) - Math.max(by0, y0))) / ((x1 - x0) * (y1 - y0));
    if (share > 0.02) { outside++; console.log(`off #${i + 1} ${page}: ${(share * 100).toFixed(0)}% of the ink lies outside the drawable${times ? ` (${ms.toFixed(0)} ms)` : ''}  ${head.slice(0, 50)}`); }
    else if (cover < 0.4) { outside++; console.log(`small #${i + 1} ${page}: the ink covers ${(cover * 100).toFixed(0)}% of the drawable${times ? ` (${ms.toFixed(0)} ms)` : ''}  ${head.slice(0, 50)}`); }
    else console.log(`ok  #${i + 1} ${page} (${out.stats.fragments} frags, ${(cover * 100).toFixed(0)}% of the drawable)${times ? ` ${ms.toFixed(0)} ms` : ''}  ${head.slice(0, 60)}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL #${i + 1}: ${e instanceof Error ? e.message : e}\n     ${head.slice(0, 70)}`);
  }
}
console.log(`${fences.length - failed}/${fences.length} examples pass${outside ? `, ${outside} framed badly (off or small)` : ''}`);
if (times && timed.length) {
  const total = timed.reduce((s, t) => s + t.ms, 0);
  console.log(`\nrendered ${timed.length} fences in ${(total / 1000).toFixed(1)} s — the slowest ten:`);
  for (const t of [...timed].sort((a, b) => b.ms - a.ms).slice(0, 10)) {
    console.log(`${t.ms.toFixed(0).padStart(7)} ms  #${t.n} ${t.page}  ${t.head.slice(0, 58)}`);
  }
}
process.exit(failed === 0 ? 0 : 1);

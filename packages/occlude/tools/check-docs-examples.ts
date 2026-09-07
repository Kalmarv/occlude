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
 *
 * Uses the same import/export transform the docs page applies in-browser,
 * so a fence that passes here runs there.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOC_PAGES, parseLiveMeta, docsPaper } from '../src/docsExamples.js';
import * as occlude from '../src/index.js';
import {
  compileSketch, initOcclude, isSketch, render, setPaperHint, setPenLibrary,
  DEFAULT_PENS, paperSize, type SketchDef,
} from '../src/index.js';
import { liveExampleToJs } from '../src/docsExamples.js';
import { preloadAssetsFromDisk } from './asset-preload.js';
import { preloadFillsFromDisk } from './fill-preload.js';

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await initOcclude(readFileSync(wasmPath));
setPenLibrary(structuredClone(DEFAULT_PENS));
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
fences.forEach(({ src, meta, page }, i) => {
  // First line of the example names it in failures.
  const head = src.split('\n').find((l) => l.trim() && !l.startsWith('import')) ?? `#${i}`;
  try {
    const js = liveExampleToJs(src);
    preloadAssetsFromDisk(js);
    preloadFillsFromDisk(js);
    const module = { exports: {} as Record<string, unknown> };
    new Function('require', 'exports', 'module', js)(
      (name: string) => {
        if (name === 'occlude') return occlude;
        throw new Error(`examples may only import from 'occlude' (tried '${name}')`);
      },
      module.exports,
      module,
    );
    const def = (isSketch(module.exports.default)
      ? module.exports.default
      : Object.values(module.exports).find(isSketch)) as SketchDef | undefined;
    if (!def) throw new Error('no sketch exported');
    const sheet = docsPaper(meta);
    const size = paperSize(sheet);
    setPaperHint(size.w, size.h);
    compileSketch(def, { marginPct: meta.margin ?? 5 });
    const out = render({ paper: sheet, coarsen: 1 });
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
    if (share > 0.02) { outside++; console.log(`off #${i + 1} ${page}: ${(share * 100).toFixed(0)}% of the ink lies outside the drawable  ${head.slice(0, 50)}`); }
    else if (cover < 0.4) { outside++; console.log(`small #${i + 1} ${page}: the ink covers ${(cover * 100).toFixed(0)}% of the drawable  ${head.slice(0, 50)}`); }
    else console.log(`ok  #${i + 1} ${page} (${out.stats.fragments} frags, ${(cover * 100).toFixed(0)}% of the drawable)  ${head.slice(0, 60)}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL #${i + 1}: ${e instanceof Error ? e.message : e}\n     ${head.slice(0, 70)}`);
  }
});
console.log(`${fences.length - failed}/${fences.length} examples pass${outside ? `, ${outside} framed badly (off or small)` : ''}`);
process.exit(failed === 0 ? 0 : 1);

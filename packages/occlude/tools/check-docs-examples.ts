#!/usr/bin/env tsx
/**
 * Docs example checker: every `ts live` fence in docs/reference.md must
 * execute and render to visible strokes against the CURRENT engine. Run in
 * CI-ish contexts / before committing reference changes:
 *
 *   pnpm --filter occlude docs:check
 *
 * Uses the same import/export transform the docs page applies in-browser,
 * so a fence that passes here runs there.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
const size = paperSize({ paper: 'Square20' });
setPaperHint(size.w, size.h);

const md = readFileSync(
  fileURLToPath(new URL('../../../docs/reference.md', import.meta.url)),
  'utf8',
);
const readme = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');
// The README's headline example is the deleted-API canary: it runs too.
const fences = [
  ...[...md.matchAll(/```ts live\n([\s\S]*?)```/g)].map((m) => m[1]),
  ...[...readme.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((src) => src.includes('export default sketch')),
];
if (fences.length === 0) {
  console.error('no `ts live` fences found — wrong file?');
  process.exit(1);
}

let failed = 0;
fences.forEach((src, i) => {
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
    compileSketch(def);
    const out = render({ paper: 'Square20' });
    if (out.stats.fragments === 0) throw new Error('rendered zero visible strokes');
    console.log(`ok  #${i + 1} (${out.stats.fragments} frags)  ${head.slice(0, 60)}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL #${i + 1}: ${e instanceof Error ? e.message : e}\n     ${head.slice(0, 70)}`);
  }
});
console.log(`${fences.length - failed}/${fences.length} examples pass`);
process.exit(failed === 0 ? 0 : 1);

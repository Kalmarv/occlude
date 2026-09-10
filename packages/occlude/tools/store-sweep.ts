#!/usr/bin/env tsx
/**
 * Do the studio's STORED sketches still build against the current API?
 *
 *   pnpm --filter occlude store-sweep
 *
 * Compile only — the sketch body runs at compile, which is the step a removed
 * or renamed part of the API breaks, and the render is the expensive part. A
 * sketch that compiles may still draw differently; this answers "does it
 * load", not "is the ink the same".
 *
 * Reads the studio's local store (gitignored: your sketches, not the repo),
 * with the studio's own pen library, so a fresh clone has nothing to check.
 * `working/conversion-review.md` carries the per-sketch table of the result-
 * shape changes a text rewrite cannot do.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import * as occlude from '../src/index.js';
import { preloadAssetsFromDisk } from './asset-preload.js';
import { preloadFillsFromDisk } from './fill-preload.js';

// `--migrate` compiles the store as the STORE MIGRATION would rewrite it, in
// memory, which is the fast pre-check for tools/verify-sketch-migration.mjs
// (that one proves byte-identical ink; this one only says it still loads).
const migrate = process.argv.includes('--migrate');
const migrateSketchSource = migrate
  ? (await import('../../occlude-studio/tools/migrate-sketch-source.mjs')).migrateSketchSource
  : null;

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await occlude.initOcclude(readFileSync(wasmPath));
try {
  const pensPath = fileURLToPath(new URL('../../occlude-studio/sketches/pens.json', import.meta.url));
  occlude.setPenLibrary(JSON.parse(readFileSync(pensPath, 'utf8')));
} catch {
  occlude.setPenLibrary(structuredClone(occlude.DEFAULT_PENS));
}
occlude.setPaperHint(200, 100);

const store = fileURLToPath(new URL('../../occlude-studio/sketches/', import.meta.url));
let files: string[];
try {
  files = readdirSync(store).filter((f) => f.endsWith('.ts')).sort();
} catch {
  console.error(`no store at ${store} — this checks YOUR sketches, not the repo's`);
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  const source = readFileSync(store + file, 'utf8');
  const js = transformSync(migrateSketchSource ? migrateSketchSource(source) : source, { loader: 'ts', format: 'cjs' }).code;
  preloadAssetsFromDisk(js);
  preloadFillsFromDisk(js);
  const module = { exports: {} as Record<string, unknown> };
  try {
    new Function('require', 'exports', 'module', js)(
      (name: string) => (name === 'occlude' ? occlude : (() => { throw new Error(name); })()),
      module.exports,
      module,
    );
    const def = (module.exports.default ?? Object.values(module.exports).find(occlude.isSketch)) as
      | occlude.SketchDef
      | undefined;
    if (!def) throw new Error('no sketch export');
    (globalThis as Record<string, unknown>).location = { search: '?seed=42' };
    occlude.compileSketch(def, { marginPct: 5 });
    console.log(`ok    ${file}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${file}  ${(e as Error).message.split('\n')[0].slice(0, 96)}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} stored sketches compile`);
process.exit(failed ? 1 : 0);

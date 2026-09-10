#!/usr/bin/env tsx
/**
 * The docs ink oracle: every `ts live` fence on every topic page, rendered on
 * the sheet the site shows it on, at one fixed seed, hashed. Use it to prove
 * a refactor or a documentation migration changed no ink:
 *
 *   pnpm --filter occlude docs:hashes -- --save before.json
 *   ...edit...
 *   pnpm --filter occlude docs:hashes -- --check before.json
 *
 * `--check` exits non-zero on any changed or disappeared example and prints
 * the before/after hash, so a failing migration names itself. Examples are
 * keyed by page and position, so a fence that is edited in place keeps its
 * key; a fence added or removed shifts the ones after it, which `--check`
 * reports as a count change rather than pretending they matched.
 *
 * The seed is fixed here (examples that read the url seed would otherwise
 * differ every run); per-example settings — paper, orientation, margin —
 * are read from the fence the same way the docs site and `docs:check` read
 * them, so the hash is of the drawing the reader sees.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as occlude from '../src/index.js';
import {
  compileSketch, exportSvg, initOcclude, isSketch, paperSize, setPaperHint, setPenLibrary,
  DEFAULT_PENS, DOC_PAGES, parseLiveMeta, docsPaper, liveExampleToJs, type SketchDef,
} from '../src/index.js';
import { preloadAssetsFromDisk } from './asset-preload.js';
import { preloadFillsFromDisk } from './fill-preload.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
};
const savePath = opt('save');
const fixture = fileURLToPath(new URL('../test/fixtures/docs-ink.json', import.meta.url));
// `--check` alone checks the committed baseline: the gate for a change that
// should not move any ink.
const checkPath = args.includes('--check') ? opt('check') ?? fixture : undefined;
const seed = opt('seed') ?? '42';
const only = opt('page')?.split(',').filter(Boolean);
if (!savePath && !checkPath) throw new Error('usage: docs-hashes (--save <file> | --check [file]) [--seed 42] [--page slug,…]');

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await initOcclude(readFileSync(wasmPath));
setPenLibrary(structuredClone(DEFAULT_PENS));

const readme = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');
const fences: { src: string; paper: ReturnType<typeof parseLiveMeta>; page: string; key: string }[] = [];
for (const page of DOC_PAGES.filter((p) => p.live && (!only || only.includes(p.slug)))) {
  const md = readFileSync(fileURLToPath(new URL(`../../../docs/${page.file}`, import.meta.url)), 'utf8');
  let k = 0;
  for (const m of md.matchAll(/```ts live([^\n]*)\n([\s\S]*?)```/g)) {
    // Per-page position, so editing one page never renumbers another's keys.
    fences.push({ src: m[2], paper: parseLiveMeta(m[1]), page: page.slug, key: `${page.slug}#${k++}` });
  }
}
for (const m of only ? [] : readme.matchAll(/```ts\n([\s\S]*?)```/g)) {
  if (m[1].includes('export default sketch')) {
    fences.push({ src: m[1], paper: parseLiveMeta(''), page: 'readme', key: 'readme#0' });
  }
}

/** An example that reads the wall clock draws a different number every run,
 * so it has no stable ink to hash. Named rather than silently skipped: the
 * cure is an in-sketch cost readout, which the API does not have yet
 * (working/api-friction.md, friction 10). */
const UNSTABLE = /\bDate\.now\(/;
const UNSTABLE_HASH = 'UNSTABLE (draws Date.now())';

/** The ink of one example: the exact-curve SVG the export writes. */
function inkOf(src: string, meta: ReturnType<typeof parseLiveMeta>): string {
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
  return exportSvg({ paper: sheet });
}

const hashes: Record<string, string> = {};
const failed: string[] = [];
const unstable: string[] = [];
fences.forEach(({ src, paper, key }) => {
  try {
    if (UNSTABLE.test(src)) {
      hashes[key] = UNSTABLE_HASH;
      unstable.push(key);
      return;
    }
    // A sketch with no seed of its own reads the url seed at compile time.
    (globalThis as Record<string, unknown>).location = { search: `?seed=${seed}` };
    hashes[key] = createHash('sha256').update(inkOf(src, paper)).digest('hex');
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).replace(/\/[^\s:]+/g, '<path>').slice(0, 120);
    hashes[key] = `ERROR ${msg}`;
    failed.push(`${key}: ${msg}`);
  }
});

if (savePath) {
  writeFileSync(savePath, `${JSON.stringify(hashes, null, 2)}\n`);
  console.log(`${Object.keys(hashes).length} examples hashed → ${savePath}`);
  if (unstable.length) console.error(`  no stable ink (${unstable.length}): ${unstable.join(', ')}`);
  for (const f of failed) console.error(`  fail ${f}`);
  process.exit(failed.length ? 1 : 0);
}

const before = JSON.parse(readFileSync(checkPath as string, 'utf8')) as Record<string, string>;
const keys = Object.keys(before);
const skipped = keys.filter((k) => before[k] === UNSTABLE_HASH);
const comparable = keys.filter((k) => before[k] !== UNSTABLE_HASH);
const changed = comparable.filter((k) => hashes[k] !== before[k]);
const added = Object.keys(hashes).filter((k) => !(k in before));
const missing = comparable.filter((k) => !(k in hashes));
for (const k of changed) console.error(`changed  ${k}\n  before ${before[k]}\n  after  ${hashes[k]}`);
for (const k of added) console.error(`added    ${k}`);
for (const k of missing) console.error(`missing  ${k}`);
console.log(`${comparable.length - changed.length - missing.length}/${comparable.length} examples ink-identical (${skipped.length} no stable ink, ${added.length} added, ${missing.length} missing)`);
process.exit(changed.length || missing.length ? 1 : 0);

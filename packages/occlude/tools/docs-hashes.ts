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
 * the before/after hash, so a failing migration names itself.
 *
 * The fast mode, beside the gate and never instead of it (`check.mjs` runs
 * the full `--check`):
 *
 *   pnpm --filter occlude docs:hashes -- --check --affected
 *
 * hashes only the fences the working tree's diff against HEAD can reach,
 * read from a coverage map of which source lines each fence ran
 * (tools/docs-coverage.ts). With no map for HEAD it says so, runs the full
 * check and builds the map in the same pass; `--map` does that on purpose.
 * A map is written only from a tree whose ink-relevant paths match HEAD. Examples are
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
// The page list has no imports of its own: reading it here loads nothing
// the coverage session needs to see compiled.
import { DOC_PAGES } from '../src/docsExamples.js';
import type { AsyncSketchDef, SketchDef } from '../src/index.js';
import {
  CoverageRecorder, findMap, harnessFiles, harnessHash, headCommit, importedBySrc, inkDirty, inkTree, keyList, saveMap,
  selectAffected, withModuleLevel, withoutScriptEdits, workingChanges, type Selection } from './docs-coverage.js';

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
// should not move any ink. `--map` is a full check that records coverage.
const mapping = args.includes('--map');
const affected = args.includes('--affected');
const checkPath = args.includes('--check') || mapping ? opt('check') ?? fixture : undefined;
const seed = opt('seed') ?? '42';
const only = opt('page')?.split(',').filter(Boolean);
if (!savePath && !checkPath) throw new Error('usage: docs-hashes (--save <file> | --check [file] [--affected] | --map) [--seed 42] [--page slug,…]');
if ((affected || mapping) && (savePath || only)) throw new Error('--affected and --map check every page against a baseline: no --save, no --page');

// The map for HEAD decides whether this run records: that is known from git
// alone, before the library loads — and the coverage session has to start
// first, or the library's functions carry no block counters.
const t0 = performance.now();
const commit = affected || mapping ? headCommit() : '';
const tree = affected || mapping ? inkTree() : '';
const harness = affected || mapping ? harnessFiles() : new Set<string>();
const harnessId = affected || mapping ? harnessHash(harness) : '';
const found = affected && !mapping ? findMap(commit, tree, harnessId) : null;
// The harness is keyed, not diffed: a map is only ever found for the code
// that is running now.
const working = affected || mapping ? workingChanges() : { changes: [], symlinks: [] };
const changes = withoutScriptEdits(working.changes).filter((c) => !harness.has(c.path));
const livePages = DOC_PAGES.filter((p) => p.live);
// A map describes HEAD, so it is recorded only from a tree that is HEAD
// wherever ink can come from.
const dirty = inkDirty(changes, livePages);
if (affected && !found) console.log(`no coverage map for ${commit.slice(0, 7)} (ink tree ${tree}, harness ${harnessId}): full check${dirty.length ? '' : ', building the map'}`);
if ((mapping || (affected && !found)) && dirty.length) console.log(`no map recorded: the tree differs from ${commit.slice(0, 7)} at ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}`);
const recorder = (mapping || (affected && !found)) && !dirty.length ? await CoverageRecorder.start() : null;

const {
  exportSvg, compileSketchAsync, initOcclude, isSketch, isSketchAsync, paperSize,
  DEFAULT_PENS, parseLiveMeta, docsPaper, liveExampleToJs, DEFAULT_PAPERS } = await import('../src/index.js');
const { assetsFromDisk } = await import('./asset-preload.js');
const { fillsFromDisk } = await import('./fill-preload.js');
const { requireFor } = await import('./inputs.js');

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await initOcclude(readFileSync(wasmPath));

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

// What the working tree's change can reach, when the map allows asking.
let selection: Selection | null = null;
if (found) {
  const modules = new Set(found.map.modules);
  selection = selectAffected({
    map: found.map,
    changes: withModuleLevel(changes, modules),
    fences,
    pages: livePages,
    importedBySrc: importedBySrc(),
  });
  if (working.symlinks.length) console.log(`  untracked symlinks are the checkout's environment, not a change: ${working.symlinks.join(', ')}`);
  if (selection.ignored.length) console.log(`  outside the ink: ${selection.ignored.join(', ')}`);
  if (selection.full) console.log(`full check: ${selection.full}`);
}
const chosen = selection && !selection.full ? new Set(selection.keys) : null;

/** An example that reads the wall clock draws a different number every run,
 * so it has no stable ink to hash. Named rather than silently skipped: the
 * cure is an in-sketch cost readout, which the API does not have yet
 * (docs/notes.md, "Open API friction"). */
const UNSTABLE = /\bDate\.now\(/;
const UNSTABLE_HASH = 'UNSTABLE (draws Date.now())';

/** The ink of one example: the exact-curve SVG the export writes. */
async function inkOf(src: string, meta: ReturnType<typeof parseLiveMeta>): Promise<string> {
  const js = liveExampleToJs(src);
  const module = { exports: {} as Record<string, unknown> };
  new Function('require', 'exports', 'module', js)(
    requireFor(DEFAULT_PENS, DEFAULT_PAPERS),
    module.exports,
    module,
  );
  const isDefinition = (v: unknown) => isSketch(v) || isSketchAsync(v);
  const def = (isDefinition(module.exports.default)
    ? module.exports.default
    : Object.values(module.exports).find(isDefinition)) as SketchDef | AsyncSketchDef | undefined;
  if (!def) throw new Error('no sketch exported');
  const sheet = docsPaper(meta);
  void paperSize;
  // the docs' own pens, a fixed seed, and the example's assets and fills
  const options = { paper: sheet, marginPct: meta.margin ?? 5, seed, library: structuredClone(DEFAULT_PENS), assets: assetsFromDisk(js), fills: fillsFromDisk(js) };
  const run = await compileSketchAsync(def, { ...options, paper: paperSize(sheet) });
  return exportSvg(run, options);
}

const hashes: Record<string, string> = {};
const failed: string[] = [];
const unstable: string[] = [];
await recorder?.init();
for (const { src, paper, key } of fences) {
  if (chosen && !chosen.has(key)) continue;
  try {
    if (UNSTABLE.test(src)) {
      hashes[key] = UNSTABLE_HASH;
      unstable.push(key);
      continue;
    }
    hashes[key] = createHash('sha256').update(await inkOf(src, paper)).digest('hex');
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).replace(/\/[^\s:]+/g, '<path>').slice(0, 120);
    hashes[key] = `ERROR ${msg}`;
    failed.push(`${key}: ${msg}`);
  } finally {
    await recorder?.fence(key);
  }
}

if (recorder) {
  const recorded = await recorder.finish();
  const builtMs = Math.round(performance.now() - t0);
  const path = saveMap({ commit, tree, harness: harnessId, builtMs, ...recorded });
  console.log(`coverage map of ${fences.length} fences in ${(builtMs / 1000).toFixed(1)}s → ${path}${recorded.workerFences.length ? ` (${recorded.workerFences.length} used a worker: its files marked whole)` : ''}`);
}

if (savePath) {
  writeFileSync(savePath, `${JSON.stringify(hashes, null, 2)}\n`);
  console.log(`${Object.keys(hashes).length} examples hashed → ${savePath}`);
  if (unstable.length) console.error(`  no stable ink (${unstable.length}): ${unstable.join(', ')}`);
  for (const f of failed) console.error(`  fail ${f}`);
  process.exit(failed.length ? 1 : 0);
}

const baseline = JSON.parse(readFileSync(checkPath as string, 'utf8')) as Record<string, string>;
// The affected run compares its own fences, and every baseline key of a page
// it took whole (a fence removed from a changed page is still missing).
const before = chosen && selection
  ? Object.fromEntries(Object.entries(baseline).filter(([k]) => chosen.has(k) || selection.pages.includes(k.split('#')[0])))
  : baseline;
if (chosen && selection) {
  const why = selection.reasons.map((r) => `${r.label} → ${keyList(r.keys)}`).join('; ');
  console.log(`affected ${chosen.size} of ${fences.length}${why ? ` (${why})` : ''}`);
}
const keys = Object.keys(before);
const skipped = keys.filter((k) => before[k] === UNSTABLE_HASH);
const comparable = keys.filter((k) => before[k] !== UNSTABLE_HASH);
const changed = comparable.filter((k) => hashes[k] !== before[k]);
const added = Object.keys(hashes).filter((k) => !(k in before));
const missing = comparable.filter((k) => !(k in hashes));
for (const k of changed) console.error(`changed  ${k}\n  before ${before[k]}\n  after  ${hashes[k]}`);
// An example with no baseline entry is an example the oracle does not
// watch. It used to be reported and forgiven, and four pages quietly sat
// outside the fixture because of it. A new fence is a re-save, the same
// one a deliberate ink change asks for.
for (const k of added) console.error(`added    ${k} (no baseline entry — re-save the fixture)`);
for (const k of missing) console.error(`missing  ${k}`);
console.log(`${comparable.length - changed.length - missing.length}/${comparable.length} examples ink-identical (${skipped.length} no stable ink, ${added.length} added, ${missing.length} missing)${chosen ? ` in ${((performance.now() - t0) / 1000).toFixed(1)}s` : ''}`);
for (const f of failed) console.error(`  fail ${f}`);
process.exit(changed.length || added.length || missing.length || failed.length ? 1 : 0);

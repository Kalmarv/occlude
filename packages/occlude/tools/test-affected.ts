#!/usr/bin/env tsx
/**
 * The affected tests: only the test files the working tree's diff against
 * HEAD can reach, read from a map of which source lines each test file ran
 * (tools/test-coverage.ts). Beside the gate, never instead of it: `pnpm
 * check` runs every test.
 *
 *   pnpm test:affected   run the affected test files, fast and slow alike
 *   pnpm test:map        build the map for HEAD (after a landing, from a
 *                        clean worktree, with `pnpm maps`)
 *
 * The change set is the docs oracle's: `git diff -U0 HEAD` plus untracked
 * files, hunks on the HEAD side, `scripts`-only package.json edits and the
 * harness set aside. With no map for HEAD, or a change the map cannot
 * attribute (a global trigger), it says why and runs the fast set.
 *
 * A map is written only from a run that passed, and only when nothing it
 * loaded, read or spawned differs from HEAD — a test file renamed without
 * an edit is the same test.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import {
  git, harnessHash, headCommit, repoRoot, withModuleLevel, withoutScriptEdits, workingChanges, type Change,
} from './coverage-map.js';
import {
  blobHash, findTestMap, globalTrigger, isTestFile, saveTestMap, selectTests, testCacheDir, testHarnessFiles, testTree,
  type TestMap, type TestRecord,
} from './test-coverage.js';

/** The sets `test:map` records. The slow set adds about a minute to the
 * build (measured: 162 s for both, 104 s fast alone), under two, so a slow
 * test a change reaches is selected like any other. */
const MAP_SET = 'all';

const pkg = join(repoRoot, 'packages/occlude');
const vitest = createRequire(import.meta.url).resolve('vitest/vitest.mjs');
const mapping = process.argv.includes('--map');

const t0 = performance.now();
const commit = headCommit();
const tree = testTree();
const harness = testHarnessFiles();
const harnessId = harnessHash(harness);
const working = workingChanges();
const changes = withoutScriptEdits(working.changes).filter((c) => !harness.has(c.path));

/** Runs vitest in the package with this environment; its output is ours. */
function vitestRun(set: string, files: string[], env: Record<string, string> = {}): number {
  const r = spawnSync(process.execPath, [vitest, 'run', ...files], { cwd: pkg, stdio: 'inherit', env: { ...process.env, OCCLUDE_TESTS: set, ...env } });
  return r.status ?? 1;
}

/** Every test file in the checkout, tracked or not (the spikes are excluded
 * by git), with its blob hash. */
function testFiles(): { path: string; blob: string }[] {
  return git('ls-files', '-co', '--exclude-standard', '--', 'packages/occlude/test').split('\n').filter(isTestFile)
    .flatMap((path) => {
      try { return [{ path, blob: blobHash(readFileSync(join(repoRoot, path))) }]; } catch { return []; } // deleted, not yet staged
    });
}

/** A file added with exactly the content of one deleted is a rename, not a
 * change. */
function withoutRenames(list: readonly Change[]): Change[] {
  const gone = new Map<string, string>();
  for (const c of list) {
    if (!c.whole || c.added) continue;
    try { gone.set(git('rev-parse', `HEAD:${c.path}`).trim(), c.path); } catch { /* binary edit, not a deletion */ }
  }
  const renamed = new Set<string>();
  for (const c of list) {
    if (!c.added) continue;
    try {
      const from = gone.get(blobHash(readFileSync(join(repoRoot, c.path))));
      if (from) { renamed.add(c.path); renamed.add(from); }
    } catch { /* unreadable: a change */ }
  }
  return list.filter((c) => !renamed.has(c.path));
}

const rel = (path: string): string => relative('packages/occlude/test', path);

if (mapping) {
  mkdirSync(testCacheDir, { recursive: true });
  const out = mkdtempSync(join(testCacheDir, `partial-${commit.slice(0, 7)}-`));
  console.log(`test map for ${commit.slice(0, 7)} (tree ${tree}, harness ${harnessId}): recording the ${MAP_SET} set`);
  const status = vitestRun(MAP_SET, [], { OCCLUDE_TEST_MAP: '1', OCCLUDE_TEST_MAP_OUT: out });
  const files: Record<string, TestRecord> = {};
  for (const f of readdirSync(out)) {
    const { path, record } = JSON.parse(readFileSync(join(out, f), 'utf8')) as { path: string; record: TestRecord };
    files[path] = record;
  }
  rmSync(out, { recursive: true, force: true });
  const missing = testFiles().filter((t) => !(t.path in files) && (MAP_SET === 'all' || !t.path.endsWith('.slow.test.ts')));
  // Recorded only if nothing the run saw differs from HEAD.
  const seen = new Set<string>(Object.keys(files));
  const dirs: string[] = [];
  for (const r of Object.values(files)) {
    for (const m of r.modules) seen.add(m);
    for (const p of r.reads) if (p.endsWith('/')) dirs.push(p); else seen.add(p);
  }
  const dirty = withoutRenames(changes).map((c) => c.path)
    .filter((p) => globalTrigger(p) || seen.has(p) || dirs.some((d) => p.startsWith(d)));
  const builtMs = Math.round(performance.now() - t0);
  // A failed file stopped early: its record lacks what it never reached.
  if (status !== 0) {
    console.log(`no map recorded: the run failed (a failed test's record stops where it did)`);
  } else if (dirty.length) {
    console.log(`no map recorded: the tree differs from ${commit.slice(0, 7)} at ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}`);
  } else {
    const map: TestMap = { commit, tree, harness: harnessId, builtMs, set: MAP_SET, files };
    console.log(`test map of ${Object.keys(files).length} files in ${(builtMs / 1000).toFixed(1)}s → ${saveTestMap(map)}`);
  }
  if (missing.length) console.log(`  no record (the file failed to load, or ran nothing): ${missing.map((t) => rel(t.path)).join(', ')}`);
  process.exit(status || (dirty.length ? 1 : 0));
}

const found = findTestMap(commit, tree, harnessId);
if (!found) {
  console.log(`no test map for ${commit.slice(0, 7)} (tree ${tree}, harness ${harnessId}): the fast set (pnpm test:map builds one)`);
  process.exit(vitestRun('fast', []));
}
const tests = testFiles();
const modules = new Set(Object.values(found.map.files).flatMap((r) => r.modules));
const selection = selectTests({ map: found.map, changes: withModuleLevel(changes, modules), tests });
if (working.symlinks.length) console.log(`  untracked symlinks are the checkout's environment, not a change: ${working.symlinks.join(', ')}`);
if (selection.ignored.length) console.log(`  outside every test: ${selection.ignored.join(', ')}`);
if (selection.full) {
  console.log(`full fast set: ${selection.full}`);
  process.exit(vitestRun('fast', []));
}
const why = selection.reasons.map((r) => `${r.label} → ${r.files.map(rel).join(', ')}`).join('; ');
console.log(`affected ${selection.files.length} of ${tests.length} test files${why ? ` (${why})` : ''} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
process.exit(selection.files.length ? vitestRun('all', selection.files.map((p) => join(repoRoot, p))) : 0);

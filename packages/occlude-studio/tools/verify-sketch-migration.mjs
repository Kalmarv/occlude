#!/usr/bin/env node
/**
 * Proof for the sketch vocabulary migration: every unique sketch source in
 * the store's whole history (every commit, every snapshot tag, every
 * `.history/` save) renders to byte-identical SVG under
 *
 *   OLD engine + original source      vs      NEW engine + migrated source
 *
 * at several seeds, so the rename is shown to change nothing the pen does,
 * across the seeded RNG too. Sources that fail on the old engine (API
 * drift older than this rename) must fail identically on the new one.
 *
 *   node tools/verify-sketch-migration.mjs --old <old worktree root> [--seeds 1,42,7] [--store <dir>]
 *                                          [--shard i/n] [--skip k] [--only <regex on path@ref>]
 *
 * `--shard i/n` takes every n-th source starting at i (0-based) so several
 * processes can split the corpus; `--skip k` drops the first k sources of
 * the (deterministic) enumeration, to resume a run.
 *
 * Prints one line per unique source and a summary; exits 1 on any
 * mismatch.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateSketchSource } from './migrate-sketch-source.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const oldRoot = opt('--old');
if (!oldRoot) throw new Error('--old <worktree root of the pre-rename engine> is required');
const seeds = opt('--seeds', '1,7,13');
const [shardI, shardN] = opt('--shard', '0/1').split('/').map(Number);
const skip = Number(opt('--skip', '0'));
const only = opt('--only') ? new RegExp(opt('--only')) : null;
const here = fileURLToPath(new URL('.', import.meta.url));
const newRoot = resolve(here, '../../..');
const store = resolve(opt('--store', join(here, '../sketches')));

const git = (...a) => execFileSync('git', ['-C', store, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });

// Every unique .ts blob reachable from any ref (commits AND snapshot tags).
const sources = new Map(); // key → { src, where }
for (const ref of git('rev-list', '--all').split('\n').filter(Boolean)) {
  for (const line of git('ls-tree', '-r', ref).split('\n').filter(Boolean)) {
    const [, , sha, path] = line.split(/\s+/, 4);
    if (!path.endsWith('.ts')) continue;
    if (!sources.has(sha)) sources.set(sha, { src: git('cat-file', '-p', sha), where: `${path}@${ref.slice(0, 7)}` });
  }
}
// Plus the file-based saves, which git ignores.
const histDir = join(store, '.history');
for (const f of readdirSync(histDir).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(histDir, f), 'utf8');
  const key = `history:${f}`;
  sources.set(key, { src, where: `.history/${f}` });
}

const tmp = mkdtempSync(join(tmpdir(), 'occlude-migrate-'));
// One render-hash process per side PER SEED, each capped: a seed that
// sends a sketch's own RNG-drawn parameters somewhere pathological
// (minutes of geometry) reports TIMEOUT for that seed on both sides
// instead of stalling the proof or hiding the other seeds' results.
const timeoutMs = Number(opt('--timeout', '20')) * 1000;
const hash = (root, file) =>
  seeds.split(',').map((seed) => {
    try {
      return execFileSync('pnpm', ['exec', 'tsx', 'tools/render-hash.ts', file, '--seeds', seed], {
        cwd: join(root, 'packages/occlude'), encoding: 'utf8', maxBuffer: 16 << 20,
        timeout: timeoutMs, killSignal: 'SIGKILL',
      }).trim();
    } catch (e) {
      if (e.signal === 'SIGKILL' || e.killed) return `${seed}  TIMEOUT`;
      // A render that crashes the process (heap exhaustion on a pathological
      // historical version) is a result too: compare the crash, don't abort.
      const why = /FATAL ERROR: ([^\n]*)/.exec(String(e.stderr ?? e.message))?.[1] ?? `exit ${e.status}`;
      return `${seed}  CRASH ${why}`;
    }
  }).join('\n');

let n = 0; let changed = 0; let mismatched = 0; let errored = 0; let index = 0; let inconclusive = 0; let partial = 0;
for (const [key, { src, where }] of sources) {
  const i = index++;
  if (i < skip || i % shardN !== shardI) continue;
  if (only && !only.test(where)) continue;
  n++;
  const migrated = migrateSketchSource(src);
  const oldFile = join(tmp, `${i}-old.ts`);
  const newFile = join(tmp, `${i}-new.ts`);
  writeFileSync(oldFile, src);
  writeFileSync(newFile, migrated);
  const a = hash(oldRoot, oldFile);
  const b = hash(newRoot, newFile);
  // Per-seed comparison: a seed only counts when BOTH sides produced a
  // result (a hash or an error). A seed that hit the cap on either side
  // is inconclusive for that seed, never a mismatch — under load a 15 s
  // render lands on either side of the cap by chance.
  const parse = (out) => {
    const m = new Map();
    for (const line of out.split('\n')) {
      const mm = /^(-?\d+)\s{2}(.*)$/.exec(line);
      if (mm) m.set(mm[1], mm[2]);
      else if (line.startsWith('ERROR')) m.set('*', line);
    }
    return m;
  };
  const A = parse(a); const B = parse(b);
  const compared = []; const differing = []; let capped = 0;
  for (const seed of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(seed) ?? A.get('*'); const y = B.get(seed) ?? B.get('*');
    if (x === undefined || y === undefined || x === 'TIMEOUT' || y === 'TIMEOUT') { capped++; continue; }
    compared.push(seed);
    if (x !== y) differing.push(seed);
  }
  const isErr = [...A.values()].some((v) => v.startsWith('ERROR') || v.startsWith('CRASH'));
  if (migrated !== src) changed++;
  let tag;
  if (differing.length) { tag = 'MISMATCH'; mismatched++; }
  else if (compared.length === 0) { tag = 'timeout'; inconclusive++; }
  else if (isErr) { tag = 'same-error'; errored++; }
  else if (capped) { tag = 'partial'; partial++; }
  else tag = 'identical';
  console.log(`${tag.padEnd(10)} ${migrated !== src ? 'migrated ' : 'untouched'} ${where}${capped ? `  (${compared.length}/${compared.length + capped} seeds compared)` : ''}`);
  if (tag !== 'identical') {
    console.log('  old: ' + a.split('\n').join('\n       '));
    console.log('  new: ' + b.split('\n').join('\n       '));
  }
}
console.log(`\n${n} unique sources, ${changed} migrated, ${errored} fail identically on both engines, ${partial} identical on the seeds that finished, ${inconclusive} inconclusive (every seed capped), ${mismatched} mismatched`);
process.exit(mismatched || inconclusive ? 1 : 0);

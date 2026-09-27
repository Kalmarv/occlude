#!/usr/bin/env tsx
/**
 * The memo's proof: warm equals cold, fence by fence.
 *
 * For every `ts live` fence (`DOCS_PAGE=slug,…` for a subset), on the sheet
 * the docs show it on and at the seed the ink oracle uses:
 *
 *   off    rendered with no memo at all;
 *   cold   rendered with an empty memo;
 *   then, with ONE memo shared by the three:
 *   first  the fence;
 *   edited the fence with one numeric literal changed (the rule below);
 *   undo   the fence again —
 *
 * and each hashed as `docs:hashes` hashes it (the exact-curve SVG, sha256).
 * The proof is `undo == cold` (and `first == cold`, `cold == off`: the memo
 * itself changes nothing). The line reports the undo run's hits and misses,
 * the calls it could not key (a closure in the arguments) or refused (the
 * call drew), the compute its hits did not spend, and the body's own time
 * (compile, before encode) without a memo and warm — the no-memo body is
 * rendered again after the undo, so both are as hot as the JIT makes them.
 *
 * THE EDIT: the LAST literal with a decimal point in the fence's source,
 * outside strings and comments — almost always inside the sketch body, and
 * a size, a weight or a rate — is multiplied by 1.1; a fence with none has
 * its last whole number of 2 or more raised by one; a fence with neither is
 * not edited. (Whole numbers below 2 are flags, indices and switches: the
 * first rule tried, the last literal of any kind, turned a growth fence's
 * `set('active', 0, …)` into 1 and grew it without end.) An edit that makes
 * the fence fail is reported and the proof goes on: the undo must still
 * equal cold. Each fence's key goes to stderr before it runs, so a fence
 * that hangs names itself.
 *
 *   pnpm exec tsx tools/memo-proof.ts
 *   DOCS_PAGE=materials,points pnpm exec tsx tools/memo-proof.ts
 *   ... --verify   every hit is also recomputed and checked, id for id
 *
 * A proof, not a gate: run it `nice -n 19`, serially.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOC_PAGES, parseLiveMeta, docsPaper, liveExampleToJs } from '../src/docsExamples.js';
import { sketch, type SketchDef } from '../src/api.js';
import {
  initOcclude, isSketch, compileSketchAsync, exportSvg, Execution, paperSize, DEFAULT_PENS, DEFAULT_PAPERS,
} from '../src/host.js';
import { MemoStore, memoised, type MemoStats } from '../src/memo.js';
import { assetsFromDisk } from './asset-preload.js';
import { fillsFromDisk } from './fill-preload.js';
import { requireFor } from './inputs.js';

const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
await initOcclude(readFileSync(wasmPath));

const verify = process.argv.includes('--verify');
const seed = 42;
const only = process.env.DOCS_PAGE?.split(',').filter(Boolean);
const fences: { src: string; meta: ReturnType<typeof parseLiveMeta>; key: string }[] = [];
for (const page of DOC_PAGES.filter((p) => p.live && (!only || only.includes(p.slug)))) {
  const md = readFileSync(fileURLToPath(new URL(`../../../docs/${page.file}`, import.meta.url)), 'utf8');
  let k = 0;
  for (const m of md.matchAll(/```ts live([^\n]*)\n([\s\S]*?)```/g)) fences.push({ src: m[2], meta: parseLiveMeta(m[1]), key: `${page.slug}#${k++}` });
}
if (!only) {
  const readme = readFileSync(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');
  for (const m of readme.matchAll(/```ts\n([\s\S]*?)```/g)) {
    if (m[1].includes('export default sketch')) fences.push({ src: m[1], meta: parseLiveMeta(''), key: 'readme#0' });
  }
}
if (fences.length === 0) {
  console.error('no `ts live` fences found — wrong DOCS_PAGE?');
  process.exit(1);
}

/** The numeric literals of `src`, in order, outside strings, template
 * literals and comments. */
function numbers(src: string): { at: number; text: string }[] {
  const found: { at: number; text: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) { while (i < src.length && /[\w$]/.test(src[i])) i++; continue; }
    const m = /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 40));
    if (m && src[i - 1] !== '.') {
      found.push({ at: i, text: m[0] });
      i += m[0].length;
      continue;
    }
    i++;
  }
  return found;
}

/** The fence with its last numeric literal changed, and what changed. */
function edited(src: string): { src: string; what: string } | null {
  const all = numbers(src);
  const decimal = all.filter((n) => n.text.includes('.')).at(-1);
  const n = decimal ?? all.filter((n) => Number(n.text) >= 2).at(-1);
  if (!n) return null;
  const v = Number(n.text);
  const next = decimal ? String(Number((v * 1.1).toPrecision(6))) : String(v + 1);
  const line = src.slice(0, n.at).split('\n').length;
  return { src: src.slice(0, n.at) + next + src.slice(n.at + n.text.length), what: `${n.text}→${next} (line ${line})` };
}

function definition(src: string): { def: SketchDef; js: string } {
  const js = liveExampleToJs(src);
  const module = { exports: {} as Record<string, unknown> };
  new Function('require', 'exports', 'module', js)(requireFor(DEFAULT_PENS, DEFAULT_PAPERS), module.exports, module);
  const def = (isSketch(module.exports.default) ? module.exports.default : Object.values(module.exports).find(isSketch)) as SketchDef | undefined;
  if (!def) throw new Error('no sketch exported');
  return { def, js };
}

/** One render: the ink's hash and the body's time (compile, before any
 * encode). The toolkit is read through the memo here, as the api.ts hook
 * reads it; once the hook is in, this wrap is a no-op. */
async function inkOf(src: string, meta: ReturnType<typeof parseLiveMeta>, store: MemoStore | undefined): Promise<{ hash: string; bodyMs: number }> {
  const { def, js } = definition(src);
  const sheet = docsPaper(meta);
  const options = { paper: sheet, marginPct: meta.margin ?? 5, seed, library: structuredClone(DEFAULT_PENS), assets: assetsFromDisk(js), fills: fillsFromDisk(js) };
  const exec = new Execution({ ...options, paper: paperSize(sheet) }, { memo: store });
  const t0 = performance.now();
  await compileSketchAsync(sketch(def.config, (t) => def.fn(memoised(t, exec))), exec);
  const bodyMs = performance.now() - t0;
  return { hash: createHash('sha256').update(exportSvg(exec, options)).digest('hex'), bodyMs };
}

const delta = (a: MemoStats, b: MemoStats): MemoStats => ({
  hits: b.hits - a.hits, misses: b.misses - a.misses, unkeyed: b.unkeyed - a.unkeyed, refused: b.refused - a.refused,
  evicted: b.evicted - a.evicted, savedMs: b.savedMs - a.savedMs, computedMs: b.computedMs - a.computedMs,
});

const UNSTABLE = /\bDate\.now\(/;
const total = { fences: 0, proved: 0, failed: 0, skipped: 0, editFailed: 0, hits: 0, misses: 0, unkeyed: 0, refused: 0, savedMs: 0, coldMs: 0, warmMs: 0 };
const refusedOps = new Set<string>();
for (const [i, { src, meta, key }] of fences.entries()) {
  const head = (src.split('\n').find((l) => l.trim() && !l.startsWith('import')) ?? '').trim().slice(0, 48);
  if (UNSTABLE.test(src)) {
    total.skipped++;
    console.log(`skip #${i + 1} ${key}: draws Date.now(), no stable ink`);
    continue;
  }
  total.fences++;
  process.stderr.write(`… #${i + 1} ${key}\n`);
  try {
    const off = await inkOf(src, meta, undefined);
    const cold = await inkOf(src, meta, new MemoStore({ verify }));
    const store = new MemoStore({ verify });
    const first = await inkOf(src, meta, store);
    const edit = edited(src);
    let editNote = 'no literal';
    if (edit) {
      try {
        const e = await inkOf(edit.src, meta, store);
        editNote = `${edit.what}${e.hash === cold.hash ? ', same ink' : ''}`;
      } catch (err) {
        total.editFailed++;
        editNote = `${edit.what} FAILED: ${(err instanceof Error ? err.message : String(err)).slice(0, 50)}`;
      }
    }
    const before = store.snapshot();
    const undo = await inkOf(src, meta, store);
    const d = delta(before, store.stats);
    // The same body with no memo, as hot as the undo run: what the memo saved
    // of the body, JIT warm-up taken out.
    const hot = await inkOf(src, meta, undefined);
    for (const op of store.drew) refusedOps.add(op);
    const ok = undo.hash === cold.hash && first.hash === cold.hash && cold.hash === off.hash;
    if (ok) total.proved++;
    else total.failed++;
    total.hits += d.hits; total.misses += d.misses; total.unkeyed += d.unkeyed; total.refused += d.refused;
    total.savedMs += d.savedMs; total.coldMs += hot.bodyMs; total.warmMs += undo.bodyMs;
    const why = ok ? '' : ` MISMATCH${off.hash !== cold.hash ? ' off≠cold' : ''}${first.hash !== cold.hash ? ' first≠cold' : ''}${undo.hash !== cold.hash ? ' undo≠cold' : ''}`;
    console.log(`${ok ? 'ok  ' : 'FAIL'} #${i + 1} ${key}: ${d.hits} hits, ${d.misses} misses, ${d.unkeyed} unkeyed, ${d.refused} refused; body ${hot.bodyMs.toFixed(1)} → ${undo.bodyMs.toFixed(1)} ms, saved ${d.savedMs.toFixed(1)} ms; edit ${editNote}${why}  ${head}`);
  } catch (err) {
    total.failed++;
    console.log(`FAIL #${i + 1} ${key}: ${err instanceof Error ? err.message : String(err)}  ${head}`);
  }
}
console.log(
  `memo-proof${verify ? ' (verify)' : ''}: warm == cold on ${total.proved}/${total.fences} fences` +
  `${total.skipped ? ` (${total.skipped} skipped: no stable ink)` : ''}${total.editFailed ? `, ${total.editFailed} edits failed to render` : ''}; ` +
  `undo runs: ${total.hits} hits, ${total.misses} misses, ${total.unkeyed} unkeyed, ${total.refused} refused; ` +
  `saved ${total.savedMs.toFixed(0)} ms of compute; body ${total.coldMs.toFixed(0)} ms without the memo → ${total.warmMs.toFixed(0)} ms warm` +
  `${refusedOps.size ? `; drew and refused: ${[...refusedOps].join(', ')}` : ''}`,
);
process.exit(total.failed === 0 ? 0 : 1);

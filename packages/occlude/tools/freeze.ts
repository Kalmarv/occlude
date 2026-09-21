#!/usr/bin/env tsx
/**
 * Freeze: render a sketch in NODE and hand the studio a plottable result.
 *
 * A heavy 3D sketch can outgrow the browser's render worker — the tab dies
 * and the drawing never reaches the machine. This renders the same sketch
 * in node, plans it once with the library's one planner, and POSTs the
 * selected plan bytes, the frozen SVG and the meta to the studio's
 * saved-result store — the same record the studio's own "Save result"
 * button writes (packages/occlude-studio/src/panels.ts, result-store.mjs).
 * Opening that result in the studio shows, exports and plots it without
 * executing the source again.
 *
 *   pnpm --filter occlude freeze <sketch.ts> [--seed 42] [--paper A4]
 *        [--margin 5] [--studio http://127.0.0.1:5273] [--name globe]
 *
 * The sketch is ordinary annotated TypeScript, as the studio's editor
 * holds it. `--paper` is a name in the studio's paper library, then a
 * preset, or `210x297` mm. The pen and paper libraries, and the machine profile that
 * prices the drawing, come from that studio, so `@user/pens` resolves the
 * pens the studio would and the ETA is the studio's clock (law 4).
 * `OCCLUDE_WORKERS` and `nice` are the caller's to set.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PAPERS, DEFAULT_PENS, PAPERS,
  encodePlanBuffer, hashPlan, initOcclude, isSketch, isSketchAsync, liveExampleToJs,
  makePlan, planBuffer, planSvg, planToolpath, renderAsync, resolveDraw, selectAll,
  type AsyncSketchDef, type EstimateOpts, type LiftMap, type PaperDef, type PenDef,
  type PenTiming, type PlanSelection, type PlanSettings, type SettlePoint, type SketchDef,
} from '../src/index.js';
import { assetsFromDisk } from './asset-preload.js';
import { fillsFromDisk } from './fill-preload.js';
import { requireFor, seedArg } from './inputs.js';

// ---- arguments ---------------------------------------------------------

const FLAGS = new Set(['seed', 'paper', 'margin', 'studio', 'name']);
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
let file: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    if (FLAGS.has(a.slice(2))) i++;
    continue;
  }
  file ??= a;
}
if (!file) {
  console.error('usage: pnpm --filter occlude freeze <sketch.ts> [--seed 42] [--paper A4] [--margin 5] [--studio http://127.0.0.1:5273] [--name globe]');
  process.exit(1);
}
const sketchPath = resolve(file);
const studio = (opt('studio') ?? 'http://127.0.0.1:5273').replace(/\/$/, '');
const marginPct = Number(opt('margin') ?? 5);
const paperName = opt('paper') ?? 'A4';
const seed = seedArg(opt('seed')) ?? 0;
const name = opt('name') ?? basename(sketchPath).replace(/\.[tj]sx?$/, '');

// ---- the studio's libraries -------------------------------------------

/** A machine profile as the studio stores it (occlude-studio/src/store.ts).
 * Only the fields the timing model reads are named here. */
interface StudioProfile {
  name: string;
  machine: { travelFeed: number; resolution: number };
  ebb: {
    acceleration: number;
    travelAcceleration: number;
    junctionDeviation: number;
    minimumCruiseRatio: number;
    penUpPulse: number;
    liftMap?: LiftMap;
    liftMarginPulses?: number;
    settleCurve?: SettlePoint[];
  };
}

/** The profile a studio with none saved would still be timed by: the
 * package defaults, which are the iDraw numbers the oracle uses. */
const FALLBACK_PROFILE: StudioProfile = {
  name: 'defaults (no studio profile)',
  machine: { travelFeed: 6000, resolution: 0.025 },
  ebb: {
    acceleration: 1000, travelAcceleration: 2000, junctionDeviation: 0.02,
    minimumCruiseRatio: 0.5, penUpPulse: 8600, liftMarginPulses: 800,
  },
};

const notes: string[] = [];
async function fetchJson<T>(path: string, what: string): Promise<T | null> {
  try {
    const res = await fetch(`${studio}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      notes.push(`${what}: ${studio}${path} answered ${res.status} — using the package defaults`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    notes.push(`${what}: ${studio} unreachable (${e instanceof Error ? e.message : String(e)}) — using the package defaults`);
    return null;
  }
}

/** THE timing inputs of a machine profile — the same fields the studio's
 * `machineTiming` reads (occlude-studio/src/drawing.ts). */
const timingOf = (p: StudioProfile): EstimateOpts => ({
  travelFeed: p.machine.travelFeed,
  acceleration: p.ebb.acceleration,
  travelAcceleration: p.ebb.travelAcceleration,
  junctionDeviation: p.ebb.junctionDeviation,
  minimumCruiseRatio: p.ebb.minimumCruiseRatio,
  lift: {
    penUpPulse: p.ebb.penUpPulse,
    map: p.ebb.liftMap,
    marginPulses: p.ebb.liftMarginPulses ?? 800,
    settleCurve: p.ebb.settleCurve,
  },
});

/** The sheet a `--paper` names: the studio's library first (so the name
 * means what the studio means), then a preset, then `WxH` in mm. */
function sheetOf(choice: string, papers: readonly PaperDef[]): { w: number; h: number; color?: string } {
  const size = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(choice);
  if (size) return { w: Number(size[1]), h: Number(size[2]) };
  const saved = papers.find((p) => p.name === choice);
  if (saved) return { w: saved.w, h: saved.h, color: saved.color };
  const preset = PAPERS[choice];
  if (preset) return { w: preset.w, h: preset.h };
  throw new Error(
    `unknown paper '${choice}': the studio's library has ${papers.map((p) => p.name).join(', ')}; `
    + `the presets are ${Object.keys(PAPERS).join(', ')}; a size like 210x297 also works`,
  );
}

/** djb2 of the source — provenance only, never an identity for a plan.
 * The same hash the studio's Save result writes (panels.ts). */
const hashSource = (src: string): string => {
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

/** The record the store publishes; the shape is
 * packages/occlude-studio/src/resultsApi.ts `ResultMeta` (a browser module
 * the library cannot import). `three` is left out: node captures no
 * construction view. */
interface ResultMeta {
  schemaVersion: number;
  planHash: string;
  sourcePlanHash: string;
  selection: { from: number; to: number; count: number; selectionHash: string };
  request: unknown;
  settings: PlanSettings;
  pens: { name: string; width: number; color: string; feed: number; penDown: number; penUp: number; penDelay: number }[];
  paper: { w: number; h: number; color?: string };
  profile: { name: string; timing: unknown; tolerance: number };
  eta: { standaloneMs: number; fullMs: number };
  build: string;
  provenance: { sketch: string | null; sourceHash: string | null; seed: string | null };
  fullPlanSaved: false;
}

// ---- the run -----------------------------------------------------------

const mark = performance.now();
const stages: [string, number][] = [];
let last = mark;
const stage = (label: string): void => {
  const now = performance.now();
  stages.push([label, now - last]);
  last = now;
};

const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
await initOcclude(readFileSync(wasmPath));

const [libPens, libPapers, profiles] = await Promise.all([
  fetchJson<PenDef[]>('/api/pens', 'pen library'),
  fetchJson<PaperDef[]>('/api/papers', 'paper library'),
  fetchJson<StudioProfile[]>('/api/profiles', 'machine profiles'),
]);
const pens = libPens?.length ? libPens : structuredClone(DEFAULT_PENS);
const papers = libPapers?.length ? libPapers : structuredClone(DEFAULT_PAPERS);
const profile = profiles?.length ? profiles[0] : FALLBACK_PROFILE;
if (!profiles?.length) notes.push(`machine profile: none saved on the studio — timing with ${FALLBACK_PROFILE.name}`);
stage('studio libraries');

const source = readFileSync(sketchPath, 'utf8');
// A sketch in the studio is annotated TypeScript, so it takes the studio's
// own two steps: node's type stripping (the server's /api/transpile, which
// is `stripFillTypes`), then the library's ESM→CJS rewrite.
const js = liveExampleToJs(stripTypeScriptTypes(source, { mode: 'strip' }));
const module = { exports: {} as Record<string, unknown> };
new Function('require', 'exports', 'module', js)(requireFor(pens, papers), module.exports, module);
const isDefinition = (v: unknown): v is SketchDef | AsyncSketchDef => isSketch(v) || isSketchAsync(v);
const def = (isDefinition(module.exports.default) ? module.exports.default : Object.values(module.exports).find(isDefinition)) as SketchDef | AsyncSketchDef | undefined;
if (!def) throw new Error(`${sketchPath}: no sketch exported`);

const sheet = sheetOf(paperName, papers);
console.error(`freeze ${name}: ${sheet.w}×${sheet.h} mm (${paperName}), margin ${marginPct}%, seed ${seed}, ${pens.length} library pens, profile '${profile.name}'`);

const result = await renderAsync(def, {
  paper: sheet,
  coarsen: 1,
  marginPct,
  seed,
  library: pens,
  assets: assetsFromDisk(js),
  fills: fillsFromDisk(js),
});
stage('render');

// ---- the plan, exactly as the studio's worker makes it ------------------

const gitHash = ((): string => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();
const build = `${gitHash}-node`;

// The engine stamp is part of a plan's identity, so it says what planned
// it: this tool, at this build. The studio's worker stamps its own build.
const planned = planBuffer(result, result.plan ?? {}, build);
const plan = await makePlan(planned.buffer, planned.settings);
stage('plan');

// The machine's tolerance and clock, as the studio resolves them.
const tolerance = Math.max(0.0001, Math.min(profile.machine.resolution, result.pens.reduce((t, p) => Math.min(t, p.width / 4), Infinity)));
const timing = timingOf(profile);
const penOf = (i: number): PenTiming | undefined => {
  const pen = result.pens[i];
  return pen ? { feed: pen.feed, penDelay: pen.penDelay } : undefined;
};
const flat = planToolpath(plan, selectAll(plan), tolerance);
const resolved = resolveDraw(plan, result.draw, { flat, penOf, opts: timing });
const final: PlanSelection = resolved.final;
stage('toolpath & selection');

const chains = plan.chains.slice(final.fromChain, final.toChain);
const bytes = encodePlanBuffer(chains);
const savedHash = await hashPlan(bytes, plan.settings);
const paperColor = result.paper.color ?? sheet.color;
// The saved SVG is the plan's own ink — the same chains, order and curves
// the machine draws, which is what the studio's Save result writes. A
// second `exportSvg` would re-render the sketch, and this tool exists
// because that render is the expensive part.
const svg = planSvg(plan, final, result.pens, { background: paperColor });
stage('encode & svg');

const meta: ResultMeta = {
  schemaVersion: plan.schemaVersion,
  planHash: savedHash,
  sourcePlanHash: plan.planHash,
  selection: { from: final.fromChain, to: final.toChain, count: final.count, selectionHash: final.selectionHash },
  request: resolved.request,
  settings: plan.settings,
  pens: result.pens.map((p) => ({ name: p.name, width: p.width, color: p.color, feed: p.feed, penDown: p.penDown, penUp: p.penUp, penDelay: p.penDelay })),
  paper: paperColor !== undefined ? { w: result.paper.w, h: result.paper.h, color: paperColor } : { w: result.paper.w, h: result.paper.h },
  profile: { name: profile.name, timing, tolerance },
  eta: { standaloneMs: resolved.estimate?.totalMs ?? 0, fullMs: resolved.fullMs ?? 0 },
  build,
  provenance: { sketch: name, sourceHash: hashSource(source), seed: String(seed) },
  fullPlanSaved: false,
};

const planBytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const post = await fetch(`${studio}/api/results`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ meta, svg, plan: Buffer.from(planBytes).toString('base64') }),
});
if (!post.ok) {
  const why = (await post.json().catch(() => ({ error: post.statusText }))) as { error?: string };
  throw new Error(`${studio}/api/results refused the result: ${why.error ?? post.statusText}`);
}
const { id } = (await post.json()) as { id: string };
stage('post');

// ---- what happened -----------------------------------------------------

const fmtMs = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
for (const note of notes) console.error(`note: ${note}`);
console.log(`result ${id}`);
console.log(`${studio}/results.html#${id}`);
console.log(`${final.count} chains of ${plan.chains.length}, ${result.frags.length} fragments, ${result.pens.length} pens, ETA ${fmtMs(meta.eta.standaloneMs)} (full plan ${fmtMs(meta.eta.fullMs)})`);
console.log(`plan ${savedHash.slice(0, 12)}… from ${plan.planHash.slice(0, 12)}…, ${planBytes.byteLength} plan bytes, ${svg.length} svg bytes, build ${build}`);
console.log(`stages: ${stages.map(([label, ms]) => `${label} ${fmtMs(ms)}`).join(', ')}, total ${fmtMs(performance.now() - mark)}`);
console.log(`peak rss ${(process.resourceUsage().maxRSS / 1024 / 1024).toFixed(2)} GB, workers ${process.env.OCCLUDE_WORKERS ?? 'default'}`);

/**
 * Execute a sketch module and encode the scene. A sketch exports a
 * `sketch(config, fn)` definition (default export preferred, else the first
 * exported definition found). The CommonJS emit turns `import … from
 * 'occlude'` into `require('occlude')`, satisfied from the studio's own
 * module instance, and `import … from '@user/pens'` / `'@user/papers'`
 * from the captured libraries the run was given.
 *
 * Runs INSIDE the render worker (spec: the worker owns the entire sketch
 * runtime; the main thread owns the editor only). A runaway sketch loop
 * wedges the worker — killed by the client watchdog — never the tab.
 *
 * One `Execution` per run: created before the module evaluates (its draw
 * and inspect hooks are handed to the tagged code), compiled, encoded, and
 * returned whole. Nothing of a run outlives it except through the object.
 */

import * as occlude from 'occlude';
import { Execution, inspectHook, moduleName, userModules } from 'occlude';
import type { AssetTable, EncodedScene, FillTable, PaperDef, PenDef, SketchDef, AsyncSketchDef, SceneCompute3 } from 'occlude';
import { INSPECT_HOOK, instrumentDeclarations } from './instrument.js';

export interface RunOutcome {
  scene: EncodedScene | null;
  error: unknown | null;
  /** The run, for what the host reads back: seed, overrides, draws,
   * probes, inspections. Null when the module failed to evaluate. */
  run: Execution | null;
}

export interface RunConfig {
  /** The captured pen library: `@user/pens` models and the pool undeclared
   * pen names resolve from. */
  pens: PenDef[];
  /** The captured paper library, for `@user/papers` (optional). */
  papers?: PaperDef[];
  paper: string | { w: number; h: number };
  landscape: boolean;
  defaultMarginPct: number;
  /** Preview coarsening (1 = exact). */
  coarsen: number;
  /** Compute the debug ghost (post-modified pre-occlusion geometry). */
  debugGhost?: boolean;
  /** Material inspection on: every variable holding a Material is
   * registered under its name (the emitted JS is instrumented), and
   * `t.inspect()` registrations are kept. Off: neither costs anything. */
  inspect?: boolean;
  /** Seed for 'url'/default-seed sketches. The worker's own URL carries no
   * `?seed=`, so the host passes it explicitly; null/undefined lets the
   * host's session seed stand in. */
  seed?: number | string | null;
  /** A fill being drafted in the editor (unsaved): its emitted JS stands in
   * for the library copy under this name for the render. */
  draftFill?: { name: string; js: string };
  /** Return the run's addressed draws (the evolution grid's material). */
  draws?: boolean;
}

export { moduleName };

function prepareSketch(js: string, cfg: RunConfig, seed: number | string, assets: AssetTable, fills: FillTable): { def?: SketchDef | AsyncSketchDef; error?: unknown; run: Execution } {
  // Let bounds() see the real paper for aspect-'paper' sketches.
  const { w, h } = occlude.paperSize({ paper: cfg.paper as never, landscape: cfg.landscape });
  const run = new Execution({
    paper: { w, h },
    library: cfg.pens,
    seed,
    marginPct: cfg.defaultMarginPct,
    assets,
    fills,
    inspect: cfg.inspect === true,
  });
  const modules = userModules(cfg.pens, cfg.papers ?? []);
  const require = (name: string): unknown => {
    if (name === 'occlude') return occlude;
    const mod = modules[name as keyof typeof modules];
    if (mod) return mod;
    throw new Error(`sketches can import from 'occlude', '@user/pens' and '@user/papers' (tried '${name}')`);
  };
  const module = { exports: {} as Record<string, unknown> };
  try {
    // Draw sites are always tagged (cheap, and what makes a seed's
    // overrides land); declarations only when the material layer is on.
    const tagged = occlude.tagDraws(js).js;
    const code = cfg.inspect === true ? instrumentDeclarations(tagged) : tagged;
    const fn = new Function('require', 'exports', 'module', INSPECT_HOOK, occlude.DRAW_HOOK, code);
    fn(require, module.exports, module, inspectHook(run), run.drawAt);
    const exp = module.exports;
    const isDefinition = (value: unknown): value is SketchDef | AsyncSketchDef => occlude.isSketch(value) || occlude.isSketchAsync(value);
    const def = isDefinition(exp.default) ? exp.default : Object.values(exp).find(isDefinition);
    if (!def) {
      throw new Error(
        "no sketch exported — write `export default sketch({ … }, (toolkit) => tree)`",
      );
    }
    return { def, run };
  } catch (error) {
    return { error, run };
  }
}

function encodeRun(run: Execution, cfg: RunConfig): RunOutcome {
  return { scene: occlude.encodeScene(run, { coarsen: cfg.coarsen, debugGhost: cfg.debugGhost }), error: null, run };
}

export function runSketch(js: string, cfg: RunConfig, seed: number | string, assets: AssetTable, fills: FillTable): RunOutcome {
  const { def, error, run } = prepareSketch(js, cfg, seed, assets, fills);
  if (!def) return { scene: null, error, run };
  try {
    if (occlude.isSketchAsync(def)) throw new Error('async rendering required; use runSketchAsync');
    occlude.compileSketch(def, run);
    return encodeRun(run, cfg);
  } catch (error) {
    return { scene: null, error, run };
  }
}

/** The worker awaits the entire sketch before encoding or adopting its run. */
export async function runSketchAsync(js: string, cfg: RunConfig, seed: number | string, assets: AssetTable, fills: FillTable, signal?: AbortSignal, compute3?: SceneCompute3): Promise<RunOutcome> {
  const { def, error, run } = prepareSketch(js, cfg, seed, assets, fills);
  if (!def) return { scene: null, error, run };
  try {
    await occlude.compileSketchAsync(def, run, { signal, compute3 });
    return encodeRun(run, cfg);
  } catch (error) {
    return { scene: null, error, run };
  }
}

/** The seed as the run used it: the base plus the overrides that landed,
 * as one string. Overrides naming addresses this source no longer has are
 * left out, so a stale tail sheds itself on the next run. */
export function currentSeed(run: Execution): string {
  const r = run.getOverrideReport();
  const hit: Record<string, number> = {};
  for (const k of r.hit) hit[k] = r.overrides[k];
  return occlude.formatSeed(String(run.seedUsed), hit);
}

/** Which overrides the run used and which it dropped. */
export function currentOverrides(run: Execution): { hit: string[]; dropped: string[] } {
  const r = run.getOverrideReport();
  return { hit: r.hit, dropped: r.dropped };
}

/** The run's addressed draws as flat arrays, for transfer: address, unit
 * float, and what the call made of it (a number, an index, a boolean). */
export function currentDraws(run: Execution): { addrs: string[]; f: Float64Array; values: (number | boolean | null)[] } {
  const log = run.getDrawLog();
  return { addrs: log.map((d) => d.addr), f: Float64Array.from(log.map((d) => d.f)), values: log.map((d) => d.value ?? null) };
}

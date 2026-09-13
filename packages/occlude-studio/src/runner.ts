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
import { Execution, inspectHook, paperModel, penModel } from 'occlude';
import type { AssetTable, EncodedScene, FillTable, PaperSpec, PenDef, SketchDef } from 'occlude';
import { INSPECT_HOOK, instrumentDeclarations } from './instrument.js';

export interface RunOutcome {
  scene: EncodedScene | null;
  error: unknown | null;
  /** The run, for what the host reads back: seed, overrides, draws,
   * probes, inspections. Null when the module failed to evaluate. */
  run: Execution | null;
}

/** A sheet the studio's paper library offers to `@user/papers`. */
export interface PaperModelDef extends PaperSpec {
  name: string;
}

export interface RunConfig {
  /** The captured pen library: `@user/pens` models and the pool undeclared
   * pen names resolve from. */
  pens: PenDef[];
  /** The captured paper library, for `@user/papers` (optional). */
  papers?: PaperModelDef[];
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

/** The library modules a sketch may import: every entry a factory of fresh
 * instances over the captured definition. */
function userModules(cfg: RunConfig): Record<string, Record<string, unknown>> {
  const pens: Record<string, unknown> = {};
  for (const p of cfg.pens) pens[moduleName(p.name)] = penModel(p);
  const papers: Record<string, unknown> = {};
  for (const p of cfg.papers ?? []) papers[moduleName(p.name)] = paperModel({ w: p.w, h: p.h, color: p.color });
  return { '@user/pens': pens, '@user/papers': papers };
}

/** A library entry's export name: `micron-03` → `micron_03` (a valid
 * identifier; the original name still works as the pen name). */
export function moduleName(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
}

export function runSketch(js: string, cfg: RunConfig, seed: number | string, assets: AssetTable, fills: FillTable): RunOutcome {
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
  const modules = userModules(cfg);
  const require = (name: string): unknown => {
    if (name === 'occlude') return occlude;
    const mod = modules[name];
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
    const def: SketchDef | undefined = occlude.isSketch(exp.default)
      ? exp.default
      : (Object.values(exp).find(occlude.isSketch) as SketchDef | undefined);
    if (!def) {
      throw new Error(
        "no sketch exported — write `export default sketch({ … }, (toolkit) => tree)`",
      );
    }
    occlude.compileSketch(def, run);
    const scene = occlude.encodeScene(run, {
      coarsen: cfg.coarsen,
      debugGhost: cfg.debugGhost,
    });
    return { scene, error: null, run };
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

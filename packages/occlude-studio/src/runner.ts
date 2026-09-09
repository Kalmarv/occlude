/**
 * Execute a sketch module and encode the scene. A sketch exports a
 * `sketch(config, fn)` definition (default export preferred, else the first
 * exported definition found). The CommonJS emit turns `import … from
 * 'occlude'` into `require('occlude')`, satisfied from the studio's own
 * module instance.
 *
 * Runs INSIDE the render worker (spec: the worker owns the entire sketch
 * runtime; the main thread owns the editor only). A runaway sketch loop
 * wedges the worker — killed by the client watchdog — never the tab.
 */

import { carryModuleInspections } from '../../occlude/src/state.js';
import * as occlude from 'occlude';
import type { EncodedScene, PenDef, SketchDef } from 'occlude';
import { INSPECT_HOOK, instrumentDeclarations } from './instrument.js';

export interface RunOutcome {
  scene: EncodedScene | null;
  error: unknown | null;
}

export interface RunConfig {
  pens: PenDef[];
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
  /** Source-mapped emit already includes draw tagging and capture hooks. */
  inspectionCompiled?: boolean;
  /** Seed for 'url'/default-seed sketches. The worker's own URL carries no
   * `?seed=`, so the host passes it explicitly; null/undefined lets the
   * session seed roll. */
  seed?: number | string | null;
  /** A fill being drafted in the editor (unsaved): its emitted JS stands in
   * for the library copy under this name for the render. */
  draftFill?: { name: string; js: string };
  /** Return the run's addressed draws (the evolution grid's material). */
  draws?: boolean;
}

export function runSketch(js: string, cfg: RunConfig): RunOutcome {
  occlude.setSeedHint(cfg.seed ?? null);
  occlude.setInspectHint(cfg.inspect === true);
  occlude.setPenLibrary(cfg.pens);
  // Let bounds() see the real paper for aspect-'paper' sketches.
  const { w, h } = occlude.paperSize({ paper: cfg.paper as never, landscape: cfg.landscape });
  occlude.setPaperHint(w, h);
  const require = (name: string): unknown => {
    if (name === 'occlude') return occlude;
    throw new Error(`sketches can only import from 'occlude' (tried '${name}')`);
  };
  const module = { exports: {} as Record<string, unknown> };
  try {
    // Draw sites are always tagged (cheap, and what makes a seed's
    // overrides land); declarations only when the material layer is on.
    const tagged = cfg.inspectionCompiled ? js : occlude.tagDraws(js).js;
    const code = cfg.inspect === true && !cfg.inspectionCompiled ? instrumentDeclarations(tagged) : tagged;
    const fn = new Function('require', 'exports', 'module', INSPECT_HOOK, occlude.DRAW_HOOK, code);
    fn(require, module.exports, module, (name: string, value: unknown, source?: occlude.InspectionSource) => {
      if (cfg.inspect) occlude.inspectIfMaterial(name, value, source);
      return value;
    }, occlude.drawAt);
    const exp = module.exports;
    const def: SketchDef | undefined = occlude.isSketch(exp.default)
      ? exp.default
      : (Object.values(exp).find(occlude.isSketch) as SketchDef | undefined);
    if (!def) {
      throw new Error(
        "no sketch exported — write `export default sketch({ … }, (toolkit) => tree)`",
      );
    }
    const carry = cfg.inspect ? carryModuleInspections() : null;
    occlude.compileSketch(carry ? { ...def, fn: t => { carry(); return def.fn(t); } } : def, { marginPct: cfg.defaultMarginPct });
    const scene = occlude.encodeScene({
      paper: { paper: cfg.paper as never, landscape: cfg.landscape },
      coarsen: cfg.coarsen,
      debugGhost: cfg.debugGhost,
    });
    return { scene, error: null };
  } catch (error) {
    return { scene: null, error };
  }
}

/** The seed as the run used it: the base plus the overrides that landed,
 * as one string. Overrides naming addresses this source no longer has are
 * left out, so a stale tail sheds itself on the next run. */
export function currentSeed(): string {
  const r = occlude.getOverrideReport();
  const hit: Record<string, number> = {};
  for (const k of r.hit) hit[k] = r.overrides[k];
  return occlude.formatSeed(String(occlude.getState().seedUsed), hit);
}

/** Which overrides the run used and which it dropped. */
export function currentOverrides(): { hit: string[]; dropped: string[] } {
  const r = occlude.getOverrideReport();
  return { hit: r.hit, dropped: r.dropped };
}

/** The run's addressed draws as flat arrays, for transfer: address, unit
 * float, and what the call made of it (a number, an index, a boolean). */
export function currentDraws(): { addrs: string[]; f: Float64Array; values: (number | boolean | null)[] } {
  const log = occlude.getDrawLog();
  return { addrs: log.map((d) => d.addr), f: Float64Array.from(log.map((d) => d.f)), values: log.map((d) => d.value ?? null) };
}

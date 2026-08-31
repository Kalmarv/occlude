/**
 * Execute a sketch module and encode the scene. A sketch exports a
 * `sketch(config, fn)` definition (default export preferred, else the first
 * exported definition found). The CommonJS emit turns `import … from
 * 'occlude'` into `require('occlude')`, satisfied from the studio's own
 * module instance.
 *
 * Execution + encoding are cheap and synchronous; the wasm geometry call
 * happens in the render worker so the editor never blocks.
 */

import * as occlude from 'occlude';
import type { EncodedScene, PenDef, SketchDef } from 'occlude';

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
}

export function runSketch(js: string, cfg: RunConfig): RunOutcome {
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
    const fn = new Function('require', 'exports', 'module', js);
    fn(require, module.exports, module);
    const exp = module.exports;
    const def: SketchDef | undefined = occlude.isSketch(exp.default)
      ? exp.default
      : (Object.values(exp).find(occlude.isSketch) as SketchDef | undefined);
    if (!def) {
      throw new Error(
        "no sketch exported — write `export default sketch({ … }, (toolkit) => tree)`",
      );
    }
    occlude.compileSketch(def, { marginPct: cfg.defaultMarginPct });
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

export function currentSeed(): string {
  return String(occlude.getState().seedUsed);
}

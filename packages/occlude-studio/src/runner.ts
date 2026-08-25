/**
 * Execute a transpiled sketch and encode the scene. The sketch imports from
 * 'occlude'; the CommonJS emit turns that into `require('occlude')`, which we
 * satisfy from the studio's own module instance (shared state).
 *
 * Execution + encoding are cheap and synchronous; the wasm geometry call
 * happens in the render worker so the editor never blocks.
 */

import * as occlude from 'occlude';
import type { EncodedScene, PenDef } from 'occlude';

export interface RunOutcome {
  scene: EncodedScene | null;
  error: unknown | null;
}

export interface RunConfig {
  pens: PenDef[];
  paper: string;
  landscape: boolean;
  defaultMarginPct: number;
  /** Preview coarsening (1 = exact). */
  coarsen: number;
}

export function runSketch(js: string, cfg: RunConfig): RunOutcome {
  occlude.setPenLibrary(cfg.pens);
  // Let bounds() see the real paper for aspect-'paper' sketches.
  const { w, h } = occlude.paperSize({ paper: cfg.paper as never, landscape: cfg.landscape });
  occlude.setPaperHint(w, h);
  // Reset state so sketches that forget `sketch()` still start clean.
  occlude.sketch({ seed: 'url' });
  const require = (name: string): unknown => {
    if (name === 'occlude') return occlude;
    throw new Error(`sketches can only import from 'occlude' (tried '${name}')`);
  };
  const module = { exports: {} };
  try {
    const fn = new Function('require', 'exports', 'module', js);
    fn(require, module.exports, module);
    if (occlude.getState().marginPct === 0 && cfg.defaultMarginPct > 0) {
      occlude.margin(cfg.defaultMarginPct);
    }
    const scene = occlude.encodeScene({
      paper: { paper: cfg.paper as never, landscape: cfg.landscape },
      coarsen: cfg.coarsen,
    });
    return { scene, error: null };
  } catch (error) {
    return { scene: null, error };
  }
}

export function currentSeed(): string {
  return String(occlude.getState().seedUsed);
}

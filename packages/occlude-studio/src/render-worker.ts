/**
 * Render worker: owns the ENTIRE sketch runtime — sketch execution, asset
 * registry, scene encoding, the wasm module, and export state. The main
 * thread owns the editor/UI only and never executes sketch code (spec:
 * fills-fields-spec.md, project 1). A render is atomic from this worker's
 * perspective: requests coalesce on the main thread; the watchdog is the
 * only hard interruption. Keeps the last render's raw buffers so
 * G-code/SVG exports reuse them instead of re-rendering.
 */

import initCore, * as core from 'occlude-core';
import { renderEncoded, type WasmModule } from 'occlude';
import { currentSeed, runSketch, type RunConfig } from './runner.js';
import { preloadAssets } from './assetLoader.js';

interface RenderMsg {
  type: 'render';
  id: number;
  js: string;
  cfg: RunConfig;
}

interface GcodeMsg {
  type: 'gcode';
  id: number;
  profileJson: string;
  budget: number;
}

interface SvgMsg {
  type: 'svg';
  id: number;
  width: number;
  height: number;
  background: string | undefined;
  onlyPen: number;
}

interface ToolpathMsg {
  type: 'toolpath';
  id: number;
  budget: number;
  tolerance: number;
}

interface PngMsg {
  type: 'png';
  id: number;
  width: number;
  height: number;
  scale: number;
  background: string | undefined;
}

type Msg = RenderMsg | GcodeMsg | SvgMsg | PngMsg | ToolpathMsg;

const ready = initCore();
const mod = core as unknown as WasmModule;

let last: { prims: Float64Array; frags: Float64Array; pensJson: string } | null = null;

self.onmessage = async (e: MessageEvent<Msg>) => {
  await ready;
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'render': {
        // Assets referenced by literal name are fetched/decoded here in the
        // worker (fetch + OffscreenCanvas are worker-native) before the
        // synchronous sketch executes.
        await preloadAssets(msg.js);
        const outcome = runSketch(msg.js, msg.cfg);
        if (outcome.error || !outcome.scene) {
          const err = outcome.error;
          self.postMessage({
            type: 'error',
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            sketch: true, // execution failed — the editor sets a runtime marker
          });
          break;
        }
        const scene = outcome.scene;
        const raw = renderEncoded(mod, scene);
        last = { prims: raw.prims, frags: raw.frags, pensJson: scene.pensJson };
        // The preview needs the buffers too, so copy rather than transfer the
        // cached ones. Decode metadata (pens/frame/paper) rides along so the
        // main thread can decode without ever having held the scene.
        self.postMessage(
          {
            type: 'render',
            id: msg.id,
            prims: raw.prims.slice(),
            frags: raw.frags.slice(),
            ghost: raw.ghost?.slice(),
            stats: raw.stats,
            renderMs: raw.renderMs,
            pens: scene.pens,
            frame: scene.frame,
            paper: scene.paper,
            seedUsed: currentSeed(),
          },
          { transfer: [] },
        );
        break;
      }
      case 'gcode': {
        if (!last) throw new Error('nothing rendered yet');
        const json = mod.wasm_export_gcode(
          last.prims,
          last.frags,
          last.pensJson,
          msg.profileJson,
          msg.budget,
        );
        self.postMessage({ type: 'gcode', id: msg.id, json });
        break;
      }
      case 'toolpath': {
        if (!last) throw new Error('nothing rendered yet');
        const plan = (core as unknown as {
          wasm_export_toolpath(
            p: Float64Array, f: Float64Array, pens: string, budget: number, tol: number,
          ): Float64Array;
        }).wasm_export_toolpath(last.prims, last.frags, last.pensJson, msg.budget, msg.tolerance);
        self.postMessage({ type: 'toolpath', id: msg.id, plan }, { transfer: [plan.buffer] });
        break;
      }
      case 'png': {
        if (!last) throw new Error('nothing rendered yet');
        const png = (core as unknown as WasmModule).wasm_export_png(
          last.prims,
          last.frags,
          last.pensJson,
          msg.width,
          msg.height,
          msg.scale,
          msg.background,
        );
        self.postMessage({ type: 'png', id: msg.id, png }, { transfer: [png.buffer] });
        break;
      }
      case 'svg': {
        if (!last) throw new Error('nothing rendered yet');
        const svg = mod.wasm_export_svg(
          last.prims,
          last.frags,
          last.pensJson,
          msg.width,
          msg.height,
          msg.background,
          msg.onlyPen,
        );
        self.postMessage({ type: 'svg', id: msg.id, svg });
        break;
      }
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
};

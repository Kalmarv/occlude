/**
 * Render worker: owns the ENTIRE sketch runtime — sketch execution, asset
 * registry, scene encoding, the wasm module, and export state. The main
 * thread owns the editor/UI only and never executes sketch code (spec:
 * fills-fields-spec.md, project 1). A render is atomic from this worker's
 * perspective: requests coalesce on the main thread; the watchdog is the
 * only hard interruption. Keeps the last render's PLAN (merge → tour →
 * bridge, planned once, native primitives) so every export encodes a
 * range of that plan instead of planning again; each export request
 * names the plan hash it means, and a stale hash is refused.
 */

import initCore, * as core from 'occlude-core';
import { bridgeGapFor, getProbeStats, hashPlan, renderEncoded, tourBudget, type PlanOptions, type PlanSettings, type WasmModule } from 'occlude';

import { currentSeed, runSketch, type RunConfig } from './runner.js';
import { preloadAssets } from './assetLoader.js';
import { preloadFills } from './fillLoader.js';

declare const __BUILD_STAMP__: string;

interface RenderMsg {
  type: 'render';
  id: number;
  js: string;
  cfg: RunConfig;
}

/** Every plan export names the plan it means; a stale hash is an error. */
interface PlanRange {
  planHash: string;
  from: number;
  to: number;
}

interface PlanGcodeMsg extends PlanRange {
  type: 'plan-gcode';
  id: number;
  profileJson: string;
}

interface PlanSvgMsg extends PlanRange {
  type: 'plan-svg';
  id: number;
  width: number;
  height: number;
  background: string | undefined;
  /** Execution filter: one pen index, or -1 for all. */
  onlyPen: number;
}

interface PlanToolpathMsg extends PlanRange {
  type: 'plan-toolpath';
  id: number;
  tolerance: number;
}

/** Adopt a saved plan (its exact bytes) as the current one — exports work
 * without any render, after the hash is verified. */
interface PlanLoadMsg {
  type: 'plan-load';
  id: number;
  buffer: Float64Array;
  settings: PlanSettings;
  planHash: string;
}

interface PngMsg {
  type: 'png';
  id: number;
  width: number;
  height: number;
  scale: number;
  background: string | undefined;
}

type Msg = RenderMsg | PlanGcodeMsg | PlanSvgMsg | PngMsg | PlanToolpathMsg | PlanLoadMsg;

const ready = initCore();

/** Pens JSON for a loaded (saved) plan: the settings' name/width with the
 * default colour — the SVG's stroke colour is the only cosmetic left. */
function pensFrom(settings: PlanSettings): string {
  return JSON.stringify(settings.pens.map((p) => ({ name: p.name, width: p.width, color: '#111111', feed: 3000, penDown: 0, penUp: 5, penDelay: 100 })));
}
const mod = core as unknown as WasmModule;

let last: { prims: Float64Array; frags: Float64Array; pensJson: string; pens: { name: string; width: number; color: string; feed: number; penDown: number; penUp: number; penDelay: number }[]; paper: { w: number; h: number } } | null = null;
let lastPlan: { buffer: Float64Array; settings: PlanSettings; planHash: string; pensJson: string } | null = null;

/** THE plan of the last render under the given options. */
async function planLast(opts: PlanOptions): Promise<{ buffer: Float64Array; settings: PlanSettings; planHash: string }> {
  if (!last) throw new Error('nothing rendered yet');
  const budget = tourBudget(opts.optimize);
  const gap = opts.bridge === false ? 0 : typeof opts.bridge === 'number' ? Math.max(0, opts.bridge) : -1;
  const buffer = mod.wasm_plan(last.prims, last.frags, last.pensJson, budget, gap);
  const settings: PlanSettings = {
    tourBudget: budget,
    pens: last.pens.map((p) => ({ name: p.name, width: p.width })),
    paper: { w: last.paper.w, h: last.paper.h },
    bridgeGapMm: last.pens.map((p) => bridgeGapFor(p, opts.bridge)),
    engine: typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev',
  };
  const planHash = await hashPlan(buffer, settings);
  lastPlan = { buffer, settings, planHash, pensJson: last.pensJson };
  return { buffer, settings, planHash };
}

const currentPlan = (msg: PlanRange) => {
  if (!lastPlan) throw new Error('nothing planned yet');
  if (lastPlan.planHash !== msg.planHash) throw new Error('stale plan: the drawing changed — this request was for an earlier render');
  return lastPlan;
};

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
        // Custom fills too: fetched from the fill library (or the editor's
        // draft) and registered before encode resolves fill('name').
        await preloadFills(msg.js, msg.cfg.draftFill);
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
        last = { prims: raw.prims, frags: raw.frags, pensJson: scene.pensJson, pens: scene.pens, paper: scene.paper };
        // THE plan, once per render, under the sketch's own t.plan({...}):
        // everything downstream selects from it, as the sketch's t.draw says.
        const { buffer: planBuf, settings, planHash } = await planLast(scene.plan ?? {});
        // Exports reuse the cached originals, so the preview gets COPIES —
        // and the copies are transferred, not structured-cloned a second
        // time. Decode metadata (pens/frame/paper) rides along so the main
        // thread can decode without ever having held the scene.
        const prims = raw.prims.slice();
        const frags = raw.frags.slice();
        const ghost = raw.ghost?.slice();
        const plan = planBuf.slice();
        const transfer: ArrayBuffer[] = [prims.buffer, frags.buffer, plan.buffer];
        if (ghost) transfer.push(ghost.buffer);
        self.postMessage(
          {
            type: 'render',
            id: msg.id,
            prims,
            frags,
            ghost,
            stats: raw.stats,
            renderMs: raw.renderMs,
            pens: scene.pens,
            frame: scene.frame,
            paper: scene.paper,
            seedUsed: currentSeed(),
            probes: getProbeStats(),
            plan,
            planSettings: settings,
            planHash,
            draw: scene.draw,
          },
          { transfer },
        );
        break;
      }
      case 'plan-load': {
        const planHash = await hashPlan(msg.buffer, msg.settings);
        if (planHash !== msg.planHash) throw new Error(`saved plan does not match its hash (${msg.planHash.slice(0, 12)}… vs ${planHash.slice(0, 12)}…)`);
        // Pens for the exporters: the saved settings carry name + width; the
        // rest of a pen (colour, feed…) is what the caller sends per export.
        lastPlan = { buffer: msg.buffer, settings: msg.settings, planHash, pensJson: '' };
        self.postMessage({ type: 'plan-load', id: msg.id, ok: true });
        break;
      }
      case 'plan-gcode': {
        const p = currentPlan(msg);
        const json = mod.wasm_plan_gcode(p.buffer, p.pensJson || pensFrom(p.settings), msg.profileJson, msg.from, msg.to);
        self.postMessage({ type: 'plan-gcode', id: msg.id, json });
        break;
      }
      case 'plan-toolpath': {
        const p = currentPlan(msg);
        const plan = mod.wasm_plan_toolpath(p.buffer, msg.tolerance, msg.from, msg.to);
        self.postMessage({ type: 'plan-toolpath', id: msg.id, plan, from: msg.from }, { transfer: [plan.buffer] });
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
      case 'plan-svg': {
        const p = currentPlan(msg);
        const svg = mod.wasm_plan_svg(p.buffer, p.pensJson || pensFrom(p.settings), msg.width, msg.height, msg.background, msg.onlyPen, msg.from, msg.to);
        self.postMessage({ type: 'plan-svg', id: msg.id, svg });
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

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

import { captureThree3, type CapturedThree3 } from './three/capture.js';
import type { LineArtScene3 } from 'occlude/src/three/scene.js';
import { ConstructionScene3, constructionInfo3 } from './three/construction.js';
import { cameraFrame3, type Camera3 } from 'occlude/src/three/camera.js';
import initCore, * as core from 'occlude-core';
import { GpuSceneCompute3, commitCamera3, encodeScene, bridgeGapFor, hashPlan, renderEncoded, tourBudget, type Execution, type PlanOptions, type PlanSettings, type WasmModule } from 'occlude';

import { currentDraws, currentOverrides, currentSeed, runSketchAsync, type RunConfig } from './runner.js';
import { preloadAssets } from './assetLoader.js';
import { preloadFills } from './fillLoader.js';
import type { GeometrySnapshot } from './optimization.js';

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

/** Adopt a saved plan (its exact bytes AND its resolved pens) as the
 * current one — exports work without any render, after the hash is
 * verified, with the pens the result was saved with, never invented ones. */
interface PlanLoadMsg {
  type: 'plan-load';
  id: number;
  buffer: Float64Array;
  settings: PlanSettings;
  planHash: string;
  /** The saved record's pens, as `pensToJson` spells them. */
  pensJson: string;
  expectedPlanHash?: string;
  three?: CapturedThree3;
}

interface PngMsg {
  type: 'png';
  id: number;
  width: number;
  height: number;
  scale: number;
  background: string | undefined;
}

/** One registered material of a named execution (the render's id), as
 * plain copies. A superseded execution is refused: its registry is gone
 * with the state that held it. */
interface InspectMsg {
  type: 'inspect';
  id: number;
  executionId: number;
  name: string;
}

type ConstructionMsg = { type: 'construction'; id: number; executionId: number; scene: number; camera: Camera3; width: number; height: number; revision: number; pick?: { x: number; y: number } };

type CameraCommitMsg = { type: 'render-camera'; id: number; executionId: number; planHash: string; scene: number; camera: Camera3 };

type Msg = { type: 'cancel-camera'; id: number } | CameraCommitMsg | { type: 'plan-three'; id: number; planHash: string } | ConstructionMsg | RenderMsg | PlanGcodeMsg | PlanSvgMsg | PngMsg | PlanToolpathMsg | PlanLoadMsg | InspectMsg
  | { type: 'optimization-context'; id: number; planHash: string }
  | (PlanRange & { type: 'plan-png'; id: number; width: number; height: number; scale: number; background?: string });

const ready = initCore();
const compute3 = new GpuSceneCompute3(navigator.gpu);

const mod = core as unknown as WasmModule;

let last: { prims: Float64Array; frags: Float64Array; pensJson: string; pens: { name: string; width: number; color: string; feed: number; penDown: number; penUp: number; penDelay: number }[]; paper: { w: number; h: number } } | null = null;
let lastPlan: { buffer: Float64Array; settings: PlanSettings; planHash: string; pensJson: string } | null = null;
/** The render whose run (and inspection registry) is current. */
let lastExecutionId = -1;
/** The run of the last successful render: the only place its state lives. */
let lastRun: Execution | null = null;
let lastSource: { js: string; cfg: RunConfig } | null = null;
let constructionScenes: { source: LineArtScene3; prepared?: ConstructionScene3 }[] = [];
/** URL-less 'url' seed: rolled ONCE per worker and reused, so re-renders
 * (debug toggles, keystrokes, settings) never reshuffle the drawing — only
 * an explicit reroll (the host's seed) changes it. Application state, not
 * the run's: every run is given its seed explicitly. */
const sessionSeed = Math.floor(Math.random() * 2 ** 31);
let geometrySnapshot: GeometrySnapshot | null = null;
let renderedPlanHash: string | null = null;
let capturedThree: CapturedThree3 | undefined;
let captureSource: { run: Execution; context: Parameters<typeof captureThree3>[1] } | undefined;
const cameraJobs = new Map<number, AbortController>();
const currentThree = () => {
  if (captureSource) { capturedThree = captureThree3(captureSource.run,captureSource.context); captureSource = undefined; }
  return capturedThree;
};

/** THE plan of the last render under the given options. */
async function planDrawing(drawing: NonNullable<typeof last>, opts: PlanOptions): Promise<{ buffer: Float64Array; settings: PlanSettings; planHash: string }> {
  const budget = tourBudget(opts.optimize);
  const gap = opts.bridge === false ? 0 : typeof opts.bridge === 'number' ? Math.max(0, opts.bridge) : -1;
  const buffer = mod.wasm_plan(drawing.prims, drawing.frags, drawing.pensJson, budget, gap);
  const settings: PlanSettings = {
    tourBudget: budget,
    pens: drawing.pens.map((p) => ({ name: p.name, width: p.width })),
    paper: { w: drawing.paper.w, h: drawing.paper.h },
    bridgeGapMm: drawing.pens.map((p) => bridgeGapFor(p, opts.bridge)),
    engine: typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev',
  };
  const planHash = await hashPlan(buffer, settings);
  return { buffer, settings, planHash };
}

const currentPlan = (msg: PlanRange) => {
  if (!lastPlan) throw new Error('nothing planned yet');
  if (lastPlan.planHash !== msg.planHash) throw new Error('stale plan: the drawing changed — this request was for an earlier render');
  return lastPlan;
};

async function handleMessage(msg: Msg): Promise<void> {
  try {
    await ready;
    switch (msg.type) {
      case 'render-camera':
      case 'render': {
        const source = msg.type === 'render' ? { js: msg.js, cfg: msg.cfg } : lastSource;
        if (!source) throw new Error('render the sketch before committing a camera');
        const signal = msg.type === 'render-camera' ? cameraJobs.get(msg.id)?.signal : undefined;
        signal?.throwIfAborted();
        let run: Execution;
        let scene: ReturnType<typeof encodeScene>;
        if (msg.type === 'render-camera') {
          if (!lastRun || msg.executionId !== lastExecutionId || msg.planHash !== lastPlan?.planHash) throw new Error('stale camera commit: the drawing changed');
          const entry = constructionScenes[msg.scene];
          if (!entry) throw new Error('camera commit scene not found');
          run = await commitCamera3(lastRun, entry.source, msg.camera, { compute3, signal });
          scene = encodeScene(run, { coarsen: source.cfg.coarsen, debugGhost: source.cfg.debugGhost });
        } else {
          const assets = await preloadAssets(source.js);
          const fills = await preloadFills(source.js, source.cfg.draftFill);
          const outcome = await runSketchAsync(source.js, source.cfg, source.cfg.seed ?? sessionSeed, assets, fills, undefined, compute3);
          if (outcome.error || !outcome.scene) {
            const err = outcome.error;
            self.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined, sketch: true });
            break;
          }
          run = outcome.run!; scene = outcome.scene;
        }
        signal?.throwIfAborted();
        const raw = renderEncoded(mod, scene);
        const drawing = { prims: raw.prims, frags: raw.frags, pensJson: scene.pensJson, pens: scene.pens, paper: scene.paper };
        // THE plan, once per render, under the sketch's own t.plan({...}):
        // everything downstream selects from it, as the sketch's t.draw says.
        const { buffer: planBuf, settings, planHash } = await planDrawing(drawing, scene.plan ?? {});
        signal?.throwIfAborted();
        // Adopt only after encoding, rendering and plan hashing all succeed.
        last = drawing; lastPlan = { buffer: planBuf, settings, planHash, pensJson: scene.pensJson };
        lastRun = run; lastSource = source; lastExecutionId = msg.id;
        constructionScenes = [...run.scenes3.keys()].map(source => ({ source, prepared: constructionScenes.find(entry => entry.source.objects === source.objects && entry.source.wires === source.wires)?.prepared }));
        const { prims: inputPrims, contours, shapesU32, shapesF64, mods, fieldData, fieldUses, domainList, clipList, clipsU32, pensJson, paperArr, seed, coarsen } = scene;
        geometrySnapshot = { prims: inputPrims, contours, shapesU32, shapesF64, mods, fieldData, fieldUses, domainList, clipList, clipsU32, pensJson, paperArr, seed, coarsen };
        renderedPlanHash = planHash;
        capturedThree = undefined;
        captureSource = { run, context: { engine: settings.engine ?? 'dev', scriptJs: source.js, seed: currentSeed(run), adapter: compute3.adapterInfo } };
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
            construction: constructionScenes.map(scene => ({ ...constructionInfo3(scene.source), camera: run.scenes3.get(scene.source)!.frame.camera })),
            cameras3: { ...run.cameras3, ...Object.fromEntries([...run.scenes3].map(([scene, view]) => [run.cameraKey3(scene), view.frame.camera])) },
            three: run.scenes3.size || run.modeling3.length ? { modeling: run.modeling3, adapter: compute3.adapterInfo, scenes: [...run.scenes3.values()].map(s => s.stats) } : undefined,
            prims,
            frags,
            ghost,
            stats: raw.stats,
            renderMs: raw.renderMs,
            pens: scene.pens,
            frame: scene.frame,
            paper: scene.paper,
            seedUsed: currentSeed(run),
            overrides: currentOverrides(run),
            draws: source.cfg.draws ? currentDraws(run) : undefined,
            probes: run.getProbeStats(),
            executionId: msg.id,
            inspections: source.cfg.inspect ? run.getInspectionIndex() : [],
            plan,
            planSettings: settings,
            planHash,
            draw: scene.draw,
          },
          { transfer },
        );
        break;
      }
      case 'plan-three': {
        if (!lastPlan || msg.planHash !== lastPlan.planHash) throw new Error('stale 3D capture: the drawing changed');
        self.postMessage({ type: msg.type, id: msg.id, three: currentThree() });
        break;
      }
      case 'construction': {
        if (msg.executionId !== lastExecutionId || !lastRun) throw new Error('stale construction view: render the current sketch first');
        const entry = constructionScenes[msg.scene];
        if (!entry) throw new Error('construction scene not found');
        const scene = entry.prepared ??= new ConstructionScene3(entry.source);
        const frame = cameraFrame3(msg.camera, { x: 0, y: 0, width: msg.width, height: msg.height });
        if (msg.pick) {
          self.postMessage({ type: 'construction', id: msg.id, revision: msg.revision, pick: scene.pick(msg.camera,msg.width,msg.height,msg.pick.x,msg.pick.y) });
        } else {
          const bitmap = await compute3.preview3(frame,scene.triangles,scene.wires,msg.width,msg.height);
          self.postMessage({ type: 'construction', id: msg.id, revision: msg.revision, bitmap }, { transfer: [bitmap] });
        }
        break;
      }
      case 'inspect': {
        if (msg.executionId !== lastExecutionId || !lastRun) throw new Error('stale inspection: the drawing changed — this request was for an earlier render');
        const payload = lastRun.inspectionPayload(msg.name);
        if (!payload) throw new Error(`no material registered as '${msg.name}' in this render`);
        const transfer = [payload.x.buffer, payload.y.buffer, payload.edges.buffer] as ArrayBuffer[];
        for (const a of Object.values(payload.attrs)) transfer.push(a.buffer as ArrayBuffer);
        for (const a of Object.values(payload.edgeAttrs)) transfer.push(a.buffer as ArrayBuffer);
        self.postMessage({ type: 'inspect', id: msg.id, executionId: msg.executionId, payload }, { transfer });
        break;
      }
      case 'plan-load': {
        if (msg.expectedPlanHash && lastPlan?.planHash !== msg.expectedPlanHash) throw new Error('The drawing changed. Run optimization again.');
        const planHash = await hashPlan(msg.buffer, msg.settings);
        if (msg.expectedPlanHash && lastPlan?.planHash !== msg.expectedPlanHash) throw new Error('The drawing changed. Run optimization again.');
        if (planHash !== msg.planHash) throw new Error(`saved plan does not match its hash (${msg.planHash.slice(0, 12)}… vs ${planHash.slice(0, 12)}…)`);
        const pens = JSON.parse(msg.pensJson) as { name: string; width: number }[];
        const same = pens.length === msg.settings.pens.length && pens.every((p, i) => p.name === msg.settings.pens[i].name && p.width === msg.settings.pens[i].width);
        if (!same) throw new Error('saved plan: the pens given do not match the plan settings');
        lastPlan = { buffer: msg.buffer, settings: msg.settings, planHash, pensJson: msg.pensJson };
        if (!msg.expectedPlanHash) { capturedThree = msg.three; captureSource = undefined; lastRun = null; lastSource = null; lastExecutionId = -1; constructionScenes = []; }
        self.postMessage({ type: 'plan-load', id: msg.id, ok: true });
        break;
      }
      case 'optimization-context': {
        if (!last || !geometrySnapshot || msg.planHash !== renderedPlanHash) throw new Error('Joining needs the original render context. Render the sketch again.');
        self.postMessage({ type: msg.type, id: msg.id, context: { scene: geometrySnapshot, prims: last.prims, frags: last.frags } });
        break;
      }
      case 'plan-png': {
        const p = currentPlan(msg);
        const png = mod.wasm_plan_png(p.buffer, p.pensJson, msg.width, msg.height, msg.scale, msg.background, msg.from, msg.to);
        self.postMessage({ type: msg.type, id: msg.id, png }, { transfer: [png.buffer] });
        break;
      }
      case 'plan-gcode': {
        const p = currentPlan(msg);
        const json = mod.wasm_plan_gcode(p.buffer, p.pensJson, msg.profileJson, msg.from, msg.to);
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
        const svg = mod.wasm_plan_svg(p.buffer, p.pensJson, msg.width, msg.height, msg.background, msg.onlyPen, msg.from, msg.to);
        self.postMessage({ type: 'plan-svg', id: msg.id, svg });
        break;
      }
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      cancelled: cameraJobs.get(msg.id)?.signal.aborted === true,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } finally {
    if (msg.type === 'render-camera') cameraJobs.delete(msg.id);
  }
};

// Rendering can await GPU work. Serialize all access to retained render/plan
// state, including exports; the client coalesces renders and owns the watchdog.
let requests = Promise.resolve();
self.onmessage = (event: MessageEvent<Msg>) => {
  const msg = event.data;
  if (msg.type === 'cancel-camera') { cameraJobs.get(msg.id)?.abort(); return; }
  if (msg.type === 'render-camera') cameraJobs.set(msg.id, new AbortController());
  requests = requests.then(() => handleMessage(msg));
};

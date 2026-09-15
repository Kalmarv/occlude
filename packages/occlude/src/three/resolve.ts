import {PhaseClock3} from './timing.js';
import {isProjectedStrokes} from './api/projected.js';
import type {ClassifiedScene3} from './visibility/scene.js';
import { sourceStrokeShapes3 } from './strokes/paper.js';
import type { ModifierValue } from '../shapes.js';
import { stroke, type Tree, type GroupValue, type ClipValue } from '../api.js';
import type { Execution } from '../execution.js';
import { paperToUser } from '../record.js';
import { cameraFrame3, toPaper3 } from './camera.js';
import type { Feature3 } from './features/snapshot.js';
import { featureSnapshot3 } from './features/snapshot.js';
import { classifySceneCpuJob3 } from './visibility/scene.js';
import { runGeometryJobAsync3 } from './geometry/job.js';
import { constructStrokes3, type Stroke3 } from './strokes/construct.js';
import { isLineArt3, type LineArtScene3, type SceneCompute3 } from './scene.js';
import { isDrawing3 } from './drawing.js';

/** A provisional picture at a stage boundary of one 3D scene: projected
 * source lines after capture (hidden portions included), then the 3D-visible
 * lines after classification. Paper millimetres, `[x0, y0, x1, y1, ...]`,
 * bounded by uniform subsampling above `maxSegments`. Drafts never enter the
 * recorded drawing; hosts replace them with the final result. */
export interface StageEvent3 { readonly stage: 'source' | 'classified'; readonly scene: string; readonly paper: { readonly w: number; readonly h: number }; readonly segments: Float64Array; readonly total: number }
export type StageListener3 = (event: StageEvent3) => void;
const DRAFT_SEGMENTS = 200_000;
function draftSegments(frame: Parameters<typeof toPaper3>[0], rows: readonly { feature: Feature3; ranges: readonly (readonly [number, number])[] }[]): { segments: Float64Array; total: number } {
  const total = rows.reduce((n, row) => n + row.ranges.length, 0), stride = Math.max(1, Math.ceil(total / DRAFT_SEGMENTS)), out: number[] = [];
  let k = 0;
  for (const { feature, ranges } of rows) for (const [t0, t1] of ranges) {
    if (k++ % stride) continue;
    const a = toPaper3(frame, [feature.a[0] + (feature.b[0] - feature.a[0]) * t0, feature.a[1] + (feature.b[1] - feature.a[1]) * t0, feature.a[2] + (feature.b[2] - feature.a[2]) * t0]);
    const b = toPaper3(frame, [feature.a[0] + (feature.b[0] - feature.a[0]) * t1, feature.a[1] + (feature.b[1] - feature.a[1]) * t1, feature.a[2] + (feature.b[2] - feature.a[2]) * t1]);
    out.push(a[0], a[1], b[0], b[1]);
  }
  return { segments: Float64Array.from(out), total };
}
/** Resolve before recording, preserving ordinary composition order. The CPU
 * reference is the documented headless default; hosts pass GPU resources. */
export async function resolveTree3(exec: Execution, tree: Tree, options: { signal?: AbortSignal; compute3?: SceneCompute3; retainedSource?:ClassifiedScene3; onStage?: StageListener3 }): Promise<Tree> {
  options.signal?.throwIfAborted();
  if (!tree) return tree;
  if(isProjectedStrokes(tree)){if(tree.curves.source!==options.retainedSource)exec.fixedStrokes3.add(tree.curves.source);return tree;}
  if (isDrawing3(tree)) {
    const view = await classifyForRun3(exec, tree.scene, options);
    return resolveTree3(exec, tree.draw(view, { strokes3: (runs, settings) => strokesForRun3(exec, runs, settings) }), {...options,retainedSource:view});
  }
  if (Array.isArray(tree)) {
    const children: Tree[] = [];
    for (const child of tree) children.push(await resolveTree3(exec, child, options));
    return children;
  }
  if (isLineArt3(tree)) {
    const classified = await classifyForRun3(exec, tree, options);
    return strokesForRun3(exec, constructStrokes3(classified, tree.lineSets, tree.strokes));
  }
  if ((tree as GroupValue).__occludeGroup || (tree as ClipValue).__occludeClip) {
    const container = tree as GroupValue | ClipValue;
    const children = await resolveTree3(exec, container.children, options) as Tree[];
    return { ...container, children };
  }
  return tree;
}


export async function classifyForRun3(exec: Execution, scene: LineArtScene3, options: { signal?: AbortSignal; compute3?: SceneCompute3; isOpen?: () => boolean; onStage?: StageListener3 }) {
  if (!isLineArt3(scene)) throw new Error('classify3 expects a captured lineArt3 scene');
  options.signal?.throwIfAborted();
  const existing = exec.scenes3.get(scene);
  if (existing) return existing;
  const pending = exec.pendingScenes3.get(scene);
  if (pending) return pending;
  const job = (async () => {
    const timing=new PhaseClock3();
    const f = exec.frame;
    const viewport = scene.viewport ?? { x: f.offsetX, y: f.offsetY, width: f.inner.innerW, height: f.inner.innerH };
    const key = exec.cameraKey3(scene);
    const camera = Object.hasOwn(exec.cameras3, key) ? exec.cameras3[key] : scene.camera;
    const snapshot = timing.measure('captureMs',()=>featureSnapshot3(scene.objects, scene.wires, cameraFrame3(camera, viewport),f.inner,scene.curves));
    if (options.onStage && !options.signal?.aborted) options.onStage({ stage: 'source', scene: key, paper: { w: exec.paper.w, h: exec.paper.h }, ...draftSegments(snapshot.frame, snapshot.features.map(feature => ({ feature, ranges: [[0, 1]] as const }))) });
    // Visibility is classified on the CPU everywhere: the exact classifier
    // beats the GPU interval classifier 1.4-3.8x on every measured workload
    // (development/3d/OPTIMIZATION-PROPOSALS.md), because the GPU path hands
    // most pairs back for exact refinement anyway. `compute3` keeps the GPU
    // for modeling (surface evaluation, tone) and the construction viewport.
    const job = await runGeometryJobAsync3(classifySceneCpuJob3(snapshot), options.signal);
    timing.merge(job.timings);
    const result = job.value;
    if (options.onStage && !options.signal?.aborted) options.onStage({ stage: 'classified', scene: key, paper: { w: exec.paper.w, h: exec.paper.h }, ...draftSegments(result.frame, result.features.map(row => ({ feature: row.feature, ranges: row.visible }))) });
    timing.merge(result.stats.timings);
    const classified=Object.freeze({...result,stats:Object.freeze({...result.stats,timings:timing.finish()})});
    options.signal?.throwIfAborted();
    if (options.isOpen && !options.isOpen()) throw new Error('3D classification execution has finished');
    exec.scenes3.set(scene, classified);
    return classified;
  })().finally(() => { exec.pendingScenes3.delete(scene); });
  exec.pendingScenes3.set(scene, job);
  return job;
}
/** Explicit interpretation of already projected data. Paper points stay in mm;
 * the current execution's inverse frame avoids applying its margin twice. */
export function strokesForRun3(exec: Execution, runs: readonly Stroke3[], options: { modifiers?: readonly ModifierValue[]; pass?: string } = {}) {
  const toUser = paperToUser(exec.frame);
  return sourceStrokeShapes3(runs,(p)=>toUser(p[0],p[1]),options);
}

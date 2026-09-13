import { sourceStrokeShapes3 } from './strokes/paper.js';
import type { ModifierValue } from '../shapes.js';
import { stroke, type Tree, type GroupValue, type ClipValue } from '../api.js';
import type { Execution } from '../execution.js';
import { paperToUser } from '../record.js';
import { cameraFrame3 } from './camera.js';
import { featureSnapshot3 } from './features/snapshot.js';
import { classifySceneCpu3 } from './visibility/scene.js';
import { constructStrokes3, type Stroke3 } from './strokes/construct.js';
import { isLineArt3, type LineArtScene3, type SceneCompute3 } from './scene.js';

/** Resolve before recording, preserving ordinary composition order. The CPU
 * reference is the documented headless default; hosts pass GPU resources. */
export async function resolveTree3(exec: Execution, tree: Tree, options: { signal?: AbortSignal; compute3?: SceneCompute3 }): Promise<Tree> {
  options.signal?.throwIfAborted();
  if (!tree) return tree;
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


export async function classifyForRun3(exec: Execution, scene: LineArtScene3, options: { signal?: AbortSignal; compute3?: SceneCompute3; isOpen?: () => boolean }) {
  if (!isLineArt3(scene)) throw new Error('classify3 expects a captured lineArt3 scene');
  options.signal?.throwIfAborted();
  const existing = exec.scenes3.get(scene);
  if (existing) return existing;
  const pending = exec.pendingScenes3.get(scene);
  if (pending) return pending;
  const job = (async () => {
    const f = exec.frame;
    const viewport = scene.viewport ?? { x: f.offsetX, y: f.offsetY, width: f.inner.innerW, height: f.inner.innerH };
    const snapshot = featureSnapshot3(scene.objects, scene.wires, cameraFrame3(scene.camera, viewport));
    const classified = options.compute3 ? await options.compute3.classify(snapshot, options) : classifySceneCpu3(snapshot);
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
export function strokesForRun3(exec: Execution, runs: readonly Stroke3[], options: { modifiers?: readonly ModifierValue[] } = {}) {
  const toUser = paperToUser(exec.frame);
  return sourceStrokeShapes3(runs,(p)=>toUser(p[0],p[1]),options);
}

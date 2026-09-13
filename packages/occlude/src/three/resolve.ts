import { stroke, type Tree, type GroupValue, type ClipValue } from '../api.js';
import type { Execution } from '../execution.js';
import { paperToUser } from '../record.js';
import { cameraFrame3 } from './camera.js';
import { featureSnapshot3 } from './features/snapshot.js';
import { classifySceneCpu3 } from './visibility/scene.js';
import { constructStrokes3 } from './strokes/construct.js';
import { isLineArt3, type SceneCompute3 } from './scene.js';

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
    let classified = exec.scenes3.get(tree);
    if (!classified) {
      const f = exec.frame;
      const viewport = tree.viewport ?? { x: f.offsetX, y: f.offsetY, width: f.inner.innerW, height: f.inner.innerH };
      const snapshot = featureSnapshot3(tree.objects, tree.wires, cameraFrame3(tree.camera, viewport));
      classified = options.compute3 ? await options.compute3.classify(snapshot, options) : classifySceneCpu3(snapshot);
      options.signal?.throwIfAborted();
      exec.scenes3.set(tree, classified);
    }
    const toUser = paperToUser(exec.frame);
    return constructStrokes3(classified, tree.lineSets, tree.strokes).map(run => stroke(run.points.map(p => toUser(p[0], p[1])), { stroke: run.stroke, preserveStroke: true }));
  }
  if ((tree as GroupValue).__occludeGroup || (tree as ClipValue).__occludeClip) {
    const container = tree as GroupValue | ClipValue;
    const children = await resolveTree3(exec, container.children, options) as Tree[];
    return { ...container, children };
  }
  return tree;
}

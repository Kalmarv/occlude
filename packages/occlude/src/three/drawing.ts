import type { Tree, GroupValue, ClipValue, Toolkit } from '../api.js';
import type { Execution, CompileConfig } from '../execution.js';
import { cameraFrame3, type Camera3 } from './camera.js';
import { isLineArt3, type LineArtScene3 } from './scene.js';
import type { ClassifiedScene3 } from './visibility/scene.js';

/** A pure paper interpretation, evaluated against an explicit classified view.
 * The supplied stroke interpreter uses the current paper frame. Capture modeling results in
 * scene; this callback must not perform modeling or consume mutable RNG state. */
export interface Drawing3 {
  readonly __occludeDrawing3: true;
  readonly scene: LineArtScene3;
  readonly draw: (view: ClassifiedScene3, paper: Pick<Toolkit, 'strokes3'>) => Tree;
}
export function drawing3(scene: LineArtScene3, draw: Drawing3['draw']): Drawing3 {
  if (!isLineArt3(scene) || typeof draw !== 'function') throw new Error('drawing3 requires a captured scene and a paper interpretation');
  return Object.freeze({ __occludeDrawing3: true, scene, draw });
}
export function isDrawing3(value: unknown): value is Drawing3 {
  return !!value && typeof value === 'object' && (value as Drawing3).__occludeDrawing3 === true;
}

/** Keep value prototypes (notably physical Len values) and pure functions.
 * Scene captures already own their geometry, so preserve scene identity. */
function copy<T>(value: T, seen = new Map<object, unknown>()): T {
  if (!value || typeof value !== 'object' || isLineArt3(value)) return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return structuredClone(value);
  if (value instanceof Map) {
    const out = new Map(); seen.set(value, out);
    for (const [key, child] of value) out.set(copy(key, seen), copy(child, seen));
    return out as T;
  }
  if (value instanceof Set) {
    const out = new Set(); seen.set(value, out);
    for (const child of value) out.add(copy(child, seen));
    return out as T;
  }
  const out = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, out);
  for (const key of Object.keys(value)) out[key] = copy((value as Record<string, unknown>)[key], seen);
  return out;
}

export interface RetainedDrawing3 {
  readonly tree: Tree;
  readonly config: CompileConfig;
}
export function retainDrawing3(exec: Execution, tree: Tree): RetainedDrawing3 {
  // Resolve library references now, including the actual default pen order.
  const pens = [[exec.currentPen, exec.pens.get(exec.currentPen)!] as const,
    ...[...exec.pens].filter(([name]) => name !== exec.currentPen)];
  return {
    tree: copy(tree),
    config: copy({ paper: exec.paper, pens: Object.fromEntries(pens), seed: exec.seedUsed,
      aspect: exec.aspect, origin: exec.origin, yUp: exec.yUp, rectMode: exec.rectMode, margin: exec.marginPct }),
  };
}

/** Replace a retained scene by identity. Fixed, already projected stroke edits
 * are snapshot-bound and cannot silently become a different camera's drawing. */
export function cameraDrawing3(exec: Execution, scene: LineArtScene3, camera: Camera3): RetainedDrawing3 {
  const retained = exec.drawing3;
  if (!retained || !exec.scenes3.has(scene)) throw new Error('camera commit requires a scene in this retained drawing');
  if (exec.fixedStrokes3.has(exec.scenes3.get(scene)!)) throw new Error('camera commit cannot reproject fixed strokes; use drawing3(scene, view => ...) to retain their interpretation');
  const next = Object.freeze({ ...scene, camera: cameraFrame3(camera, scene.viewport ?? { x: 0, y: 0, width: 1, height: 1 }).camera });
  let found = false;
  function replace(tree: Tree): Tree {
    if (!tree) return tree;
    if (tree === scene) { found = true; return next; }
    if (isDrawing3(tree)) {
      if (tree.scene !== scene) return tree;
      found = true; return drawing3(next, tree.draw);
    }
    if (Array.isArray(tree)) return tree.map(replace);
    if ((tree as GroupValue).__occludeGroup || (tree as ClipValue).__occludeClip) {
      const container = tree as GroupValue | ClipValue;
      return { ...container, children: container.children.map(replace) };
    }
    return tree;
  }
  const tree = replace(copy(retained.tree));
  if (!found) throw new Error('camera commit requires a retained lineArt3 or drawing3 node');
  return { tree, config: copy(retained.config) };
}

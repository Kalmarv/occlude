import {objectSurfaceBinding3,validateSurfaceCurveNetwork3,type SurfaceCurveObject3} from './curves/network.js';
import { validateHatch3 } from './curves/hatch.js';
import { stageGeometry3, validateSurfaceCurves3 } from './curves/surface.js';
import type { ModelingCompute3 } from './modeling.js';
import type { SurfaceEvaluationTarget3, SurfaceEvaluationBatch3, SurfaceEvaluationResult3 } from './surface/evaluate.js';
import type { ToneRecipe3 } from './surface/tone.js';
import { cameraFrame3, type Camera3, type PaperFrame3 } from './camera.js';
import { mesh3 } from './geometry/mesh3.js';
import type { SurfaceObject3, WireObject3, FeatureSnapshot3 } from './features/snapshot.js';
import type { ClassifiedScene3 } from './visibility/scene.js';
import type { LineSet3, constructStrokes3 } from './strokes/construct.js';

export interface SceneCompute3 extends Partial<ModelingCompute3> {
  classify(snapshot: FeatureSnapshot3, options: { signal?: AbortSignal; paperToleranceMm?: number }): Promise<ClassifiedScene3>;
  /** Batched surface location/attribute/tone evaluation; CPU reference is
   * `evaluateSurfaceCpu3`. Agreement is within the shared tone quantum. */
  evaluateSurface?(target: SurfaceEvaluationTarget3, batch: SurfaceEvaluationBatch3, recipe: ToneRecipe3 | undefined, options: { signal?: AbortSignal }): Promise<SurfaceEvaluationResult3>;
}
export interface LineArtOptions3 {
  /** Stable key for a camera override in sketch configuration. */
  readonly id?: string;
  /** Each object's `surface` is a geometry from `occlude/3d`. */
  readonly objects?: readonly SurfaceObject3[];
  readonly wires?: readonly WireObject3[];
  readonly curves?: readonly SurfaceCurveObject3[];
  readonly camera: Camera3;
  /** Physical paper rectangle. By default use the execution's drawable frame. */
  readonly viewport?: PaperFrame3;
  readonly lineSets: readonly LineSet3[];
  readonly strokes?: Parameters<typeof constructStrokes3>[2];
}
export interface LineArtScene3 extends Omit<LineArtOptions3, 'objects'> {
  readonly __occludeLineArt3: true;
  readonly objects: readonly SurfaceObject3[];
  readonly wires: readonly WireObject3[];
}
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
/** Capture the scene now; projection waits for the execution's paper. A
 * geometry is a value and never changes, so the scene holds the value it was
 * given; what the sketch could still edit (records, lists) is copied.
 * Selection callbacks must be pure functions of their captured feature rows. */
export function lineArt3(options: LineArtOptions3): LineArtScene3 {
  if (options.id !== undefined && (typeof options.id !== 'string' || !options.id || options.id.startsWith('@'))) throw new Error('scene id must be nonempty and must not start with @');
  const camera = cameraFrame3(options.camera, options.viewport ?? { x: 0, y: 0, width: 1, height: 1 }).camera;
  const objects = options.objects ?? [];
  for(const object of objects) {
    const mesh=mesh3(stageGeometry3(object.surface,`lineArt3: object '${object.id}' surface`));
    if(object.curves)validateSurfaceCurves3(object.curves,mesh);
    if(object.hatch)validateHatch3(object.hatch,object.surface);
    if(object.binding)objectSurfaceBinding3({...object,mesh});
  }
  for(const entry of options.curves??[])if(entry.network)validateSurfaceCurveNetwork3(entry.network);
  return Object.freeze({
    __occludeLineArt3: true,
    id: options.id,
    camera,
    viewport: options.viewport && Object.freeze({ ...options.viewport }),
    objects: Object.freeze(objects.map(object => Object.freeze({ ...object, binding:object.binding??objectSurfaceBinding3({...object,mesh:mesh3(object.surface)}), ...(object.instance?{instance:freeze(structuredClone(object.instance))}:{}), curves: object.curves && Object.freeze({surface:object.surface,segments:freeze(structuredClone(object.curves.segments))}), hatch: object.hatch && Object.freeze({...object.hatch,surface:object.surface,families:freeze(structuredClone(object.hatch.families))}), transform: freeze(structuredClone(object.transform)), attributes: freeze(structuredClone(object.attributes)), ...(object.radialCentre?{ radialCentre: freeze([...object.radialCentre]) as typeof object.radialCentre }:{}) }))),
    wires: freeze(structuredClone(options.wires ?? [])),
    curves:Object.freeze((options.curves??[]).map(entry=>Object.freeze({...entry,attributes:freeze(structuredClone(entry.attributes))}))),
    lineSets: Object.freeze(options.lineSets.map(set => Object.freeze({ ...set }))),
    strokes: options.strokes && Object.freeze({ ...options.strokes }),
  });
}
export function isLineArt3(value: unknown): value is LineArtScene3 {
  return !!value && typeof value === 'object' && (value as LineArtScene3).__occludeLineArt3 === true;
}

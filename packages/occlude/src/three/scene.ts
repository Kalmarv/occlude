import { validateHatch3 } from './curves/hatch.js';
import { validateSurfaceCurves3 } from './curves/surface.js';
import type { ModelingCompute3 } from './modeling.js';
import { cameraFrame3, type Camera3, type PaperFrame3 } from './camera.js';
import { snapshotSurface3 } from './geometry/model.js';
import type { SurfaceObject3, WireObject3, FeatureSnapshot3 } from './features/snapshot.js';
import type { ClassifiedScene3 } from './visibility/scene.js';
import type { LineSet3, constructStrokes3 } from './strokes/construct.js';

export interface SceneCompute3 extends Partial<ModelingCompute3> {
  classify(snapshot: FeatureSnapshot3, options: { signal?: AbortSignal }): Promise<ClassifiedScene3>;
}
export interface LineArtOptions3 {
  /** Stable key for a camera override in sketch configuration. */
  readonly id?: string;
  readonly objects?: readonly SurfaceObject3[];
  readonly wires?: readonly WireObject3[];
  readonly camera: Camera3;
  /** Physical paper rectangle. By default use the execution's drawable frame. */
  readonly viewport?: PaperFrame3;
  readonly lineSets: readonly LineSet3[];
  readonly strokes?: Parameters<typeof constructStrokes3>[2];
}
export interface LineArtScene3 extends LineArtOptions3 {
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
/** Capture editable geometry now; projection waits for the execution's paper.
 * Selection callbacks must be pure functions of their captured feature rows. */
export function lineArt3(options: LineArtOptions3): LineArtScene3 {
  if (options.id !== undefined && (typeof options.id !== 'string' || !options.id || options.id.startsWith('@'))) throw new Error('scene id must be nonempty and must not start with @');
  const camera = cameraFrame3(options.camera, options.viewport ?? { x: 0, y: 0, width: 1, height: 1 }).camera;
  const surfaces = new Map<import('./geometry/surface.js').Surface3, import('./geometry/surface.js').Surface3>();
  const captureSurface = (surface: import('./geometry/surface.js').Surface3) => {
    let owned = surfaces.get(surface);
    if (!owned) { owned = snapshotSurface3(surface); surfaces.set(surface, owned); }
    return owned;
  };
  for(const object of options.objects??[]) {
    if(object.curves)validateSurfaceCurves3(object.curves,object.surface);
    if(object.hatch)validateHatch3(object.hatch,object.surface);
  }
  return Object.freeze({
    __occludeLineArt3: true,
    id: options.id,
    camera,
    viewport: options.viewport && Object.freeze({ ...options.viewport }),
    objects: Object.freeze((options.objects ?? []).map(object => Object.freeze({ ...object, surface: captureSurface(object.surface), curves: object.curves && freeze({surface:captureSurface(object.surface),segments:structuredClone(object.curves.segments)}), hatch: object.hatch && freeze({...object.hatch,surface:captureSurface(object.surface),families:structuredClone(object.hatch.families)}), transform: freeze(structuredClone(object.transform)), attributes: freeze(structuredClone(object.attributes)) }))),
    wires: freeze(structuredClone(options.wires ?? [])),
    lineSets: Object.freeze(options.lineSets.map(set => Object.freeze({ ...set }))),
    strokes: options.strokes && Object.freeze({ ...options.strokes }),
  });
}
export function isLineArt3(value: unknown): value is LineArtScene3 {
  return !!value && typeof value === 'object' && (value as LineArtScene3).__occludeLineArt3 === true;
}

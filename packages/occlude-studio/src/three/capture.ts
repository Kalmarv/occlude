import type { Execution } from 'occlude';
import type { CameraFrame3 } from 'occlude/src/three/camera.js';
import type { SurfaceObject3, WireObject3 } from 'occlude/src/three/features/snapshot.js';
import type { SurfaceCurveSegment3 } from 'occlude/src/three/curves/surface.js';
import type { ModelingStats3 } from 'occlude/src/three/modeling.js';

/** Persist realized data, never callbacks or GPU objects. The saved plan remains
 * the export authority; this record explains and preserves its 3D inputs. */
export interface CapturedThree3 {
  schemaVersion: 1;
  engine: string;
  scriptJs: string;
  seed: string;
  precision: 'f64 source / normalized f32 GPU / f64 refinement';
  adapter?: { vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean };
  modeling: readonly ModelingStats3[];
  scenes: {
    frame: CameraFrame3;
    objects: readonly Omit<SurfaceObject3, 'hatch'>[];
    wires: readonly WireObject3[];
    generated: readonly { objectId: string; curve: SurfaceCurveSegment3 }[];
  }[];
}
export function captureThree3(run: Execution, context: Pick<CapturedThree3,'engine'|'scriptJs'|'seed'|'adapter'>): CapturedThree3 | undefined {
  if (!run.scenes3.size && !run.modeling3.length) return;
  return structuredClone({
    schemaVersion: 1 as const, ...context, precision: 'f64 source / normalized f32 GPU / f64 refinement' as const,
    modeling: run.modeling3,
    scenes: [...run.scenes3].map(([scene,classified]) => ({
      frame: classified.frame,
      objects: scene.objects.map(({hatch, ...object}) => object),
      wires: scene.wires,
      generated: classified.features.flatMap(({feature}) => feature.curve ? [{objectId:feature.objectId,curve:feature.curve}] : []),
    })),
  });
}

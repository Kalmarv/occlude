import type { Execution } from '../execution.js';
import { captureDeform3, deformSurfaceCpu3, type DeformOptions3 } from './geometry/deform.js';
import type { Surface3 } from './geometry/surface.js';
import { prepareSurfaceQueries3, type RayQuery3, type NearestQuery3, type SurfaceHit3 } from './queries/surface.js';
import type { Vec3 } from './math.js';
import type { SceneCompute3 } from './scene.js';

export interface SurfaceQueryInput3 {
  readonly rays?: readonly RayQuery3[];
  readonly segments?: readonly (readonly [Vec3, Vec3])[];
  readonly nearest?: readonly NearestQuery3[];
}
export interface SurfaceQueryResult3 {
  readonly rays: readonly (SurfaceHit3 | null)[];
  readonly segments: readonly (SurfaceHit3 | null)[];
  readonly nearest: readonly (SurfaceHit3 | null)[];
}
export interface ModelingStats3 { readonly operation: 'deform' | 'query'; readonly backend: 'cpu' | 'gpu'; readonly dispatches: number; readonly transferBytes: number; readonly targetCacheHit?:boolean;readonly targetUploadBytes?:number }
export interface ModelingCompute3 {
  deform(surface: Surface3, options: DeformOptions3): Promise<{ surface: Surface3; stats: { dispatches: number; transferBytes: number } }>;
  query(surface: Surface3, queries: SurfaceQueryInput3, options: { signal?: AbortSignal }): Promise<{ result: SurfaceQueryResult3; stats: { dispatches: number; transferBytes: number } }>;
}
/** One binder for the normal toolkit. Host and cancellation scope are explicit;
 * CPU is the headless reference, never a fallback for a failed GPU operation. */
export function bindModeling3(exec: Execution, scope?: { signal?: AbortSignal; compute3?: SceneCompute3; isOpen?: () => boolean }) {
  const check = () => {
    if (!scope) throw new Error('3D modeling batches require sketchAsync and compileSketchAsync/renderAsync');
    if (scope.isOpen && !scope.isOpen()) throw new Error('3D modeling execution has finished');
    scope.signal?.throwIfAborted();
  };
  return {
    deform3(surface: Surface3, options: Omit<DeformOptions3, 'signal'>): Promise<Surface3> {
      check();
      const captured = captureDeform3(surface, options);
      const capturedOptions = { iterations: captured.iterations, relaxation: captured.relaxation, displacements: captured.displacements, pinned: [...captured.pinned], signal: scope!.signal };
      return (async () => {
        const compute = scope!.compute3;
        if (compute && !compute.deform) throw new Error('host does not provide GPU deformation');
        const out = compute
          ? await compute.deform!(captured.surface, capturedOptions)
          : { surface: deformSurfaceCpu3(captured.surface, capturedOptions), stats: { dispatches: 0, transferBytes: 0 } };
        check();
        exec.modeling3.push({ operation: 'deform', backend: compute ? 'gpu' : 'cpu', ...out.stats });
        return out.surface;
      })();
    },
    querySurface3(surface: Surface3, queries: SurfaceQueryInput3): Promise<SurfaceQueryResult3> {
      check();
      const source = prepareSurfaceQueries3(surface), captured = structuredClone(queries);
      return (async () => {
        const compute = scope!.compute3;
        if (compute && !compute.query) throw new Error('host does not provide GPU surface queries');
        const out = compute ? await compute.query!(source.surface, captured, { signal: scope!.signal }) : {
          result: { rays: source.rays(captured.rays ?? [], scope!.signal), segments: source.segments(captured.segments ?? [], scope!.signal), nearest: source.nearest(captured.nearest ?? [], scope!.signal) },
          stats: { dispatches: 0, transferBytes: 0 },
        };
        check();
        exec.modeling3.push({ operation: 'query', backend: compute ? 'gpu' : 'cpu', ...out.stats });
        return out.result;
      })();
    },
  };
}

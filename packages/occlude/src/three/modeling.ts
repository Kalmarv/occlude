import {PhaseClock3,type PhaseTimings3} from './timing.js';
import type { Execution } from '../execution.js';
import { captureDeform3, deformSurfaceCpu3, type DeformOptions3 } from './geometry/deform.js';
import type { Surface3 } from './geometry/surface.js';
import { prepareSurfaceQueries3, type RayQuery3, type NearestQuery3, type SurfaceHit3 } from './queries/surface.js';
import type { Vec3 } from './math.js';
import type { SceneCompute3 } from './scene.js';
import {captureIntersections,intersectionConstructionJob,type IntersectionArguments,type IntersectionAttributes} from './api/intersections.js';
import {SurfaceCurves} from './api/supported.js';
import {runGeometryJobAsync3} from './geometry/job.js';
import {captureSurfaceMapping,surfaceMappingJob,type SurfaceMappingOptions,type SurfaceMappingStats} from './api/mapping.js';
import type {Material} from '../material.js';
import type {Mesh} from './api/mesh.js';
import {captureHatch,hatchTraceJob,evaluateHatchTone,hatchAssembleJob,type HatchInput,type HatchOptions,type HatchStats} from './api/hatch.js';
import {bindToPaper3} from './api/paper.js';
import {streamlines3 as streamlines3Curves,type Streamlines3Options} from './api/flow.js';
import type {VectorField3} from './api/vec.js';

/** Coarse progress of one modeling operation inside a sketch, for hosts that
 * show what a long `await` is doing. Counts are work units, not time. */
export interface ModelingProgress3 { readonly operation: 'hatch' | 'mapSurface' | 'intersections'; readonly done: number; readonly total?: number; readonly detail?: string }
export type ProgressListener3 = (event: ModelingProgress3) => void;
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
export interface ModelingStats3 { readonly operation: 'deform' | 'query' | 'intersections' | 'mapSurface' | 'hatch'; readonly backend: 'cpu' | 'gpu'; readonly dispatches: number; readonly transferBytes: number; readonly timings?:PhaseTimings3;readonly refinements?:number;readonly targetCacheHit?:boolean;readonly targetUploadBytes?:number;readonly intersections?:Awaited<ReturnType<typeof runIntersectionConstruction>>['value']['stats'];readonly mapping?:SurfaceMappingStats;readonly hatch?:HatchStats }
const runIntersectionConstruction=(captured:ReturnType<typeof captureIntersections>,signal?:AbortSignal,onProgress?:ProgressListener3)=>runGeometryJobAsync3(intersectionConstructionJob(captured,onProgress),signal);
export interface ModelingCompute3 {
  deform(surface: Surface3, options: DeformOptions3): Promise<{ surface: Surface3; stats: { dispatches: number; transferBytes: number; timings?:PhaseTimings3 } }>;
  query(surface: Surface3, queries: SurfaceQueryInput3, options: { signal?: AbortSignal }): Promise<{ result: SurfaceQueryResult3; stats: { dispatches: number; transferBytes: number; timings?:PhaseTimings3 } }>;
}
/** One binder for the normal toolkit. Host and cancellation scope are explicit;
 * CPU is the headless reference, never a fallback for a failed GPU operation. */
export function bindModeling3(exec: Execution, scope?: { signal?: AbortSignal; compute3?: SceneCompute3; isOpen?: () => boolean; onProgress?: ProgressListener3 }) {
  const check = () => {
    if (!scope) throw new Error('3D modeling batches require sketchAsync and compileSketchAsync/renderAsync');
    if (scope.isOpen && !scope.isOpen()) throw new Error('3D modeling execution has finished');
    scope.signal?.throwIfAborted();
  };
  return {
    /** Where a view puts a world point on the paper: a point in, a drawable
     * `[x, y]` pair out; points in, a material of the projected points, for
     * labels and leader lines. Reads the view's own resolved camera. */
    toPaper:bindToPaper3(exec),
    /** Evenly spaced streamlines of a 3D vector field, as curves a view
     * occludes. Seeds given as a count are thrown into their mesh with the
     * sketch's seeded stream, keyed by the options' `key`. */
    streamlines3(field:VectorField3,options:Streamlines3Options){
      return streamlines3Curves(field,options,{rnd:exec.stream('__streamlines3:'+(options?.key??'default')).rnd});
    },
    intersections(...args:IntersectionArguments) {
      check();const timing=new PhaseClock3(),captured=timing.measure('captureMs',()=>captureIntersections(...args));
      return (async()=>{
        const result=await runIntersectionConstruction(captured,scope!.signal,scope!.onProgress);check();timing.merge(result.timings);
        exec.modeling3.push({operation:'intersections',backend:'cpu',dispatches:0,transferBytes:0,timings:timing.finish(),intersections:result.value.stats});
        return new SurfaceCurves<IntersectionAttributes>(result.value.network,{key:captured.settings.key,pen:captured.settings.pen});
      })();
    },
    mapSurface(mesh:Mesh<any,any,any,any>,pattern:Material|readonly Material[],options:SurfaceMappingOptions={}) {
      check();const timing=new PhaseClock3(),captured=timing.measure('captureMs',()=>captureSurfaceMapping(mesh,pattern,options));
      return (async()=>{
        const result=await runGeometryJobAsync3(surfaceMappingJob(captured,scope!.onProgress),scope!.signal);check();timing.merge(result.timings);
        exec.modeling3.push({operation:'mapSurface',backend:'cpu',dispatches:0,transferBytes:0,timings:timing.finish(),mapping:result.value.stats});
        return result.value.curves;
      })();
    },
    /** Seeded surface hatch: traced lanes, then tone selection, then exact
     * graph adoption. Seeds read the execution stream keyed by the hatch key,
     * so the same sketch and seed give the same lines under any camera. */
    hatch(input:HatchInput,options:HatchOptions) {
      check();const timing=new PhaseClock3(),captured=timing.measure('captureMs',()=>captureHatch(input,options));
      const rnd=exec.stream('__surface-hatch:'+(options.key??(input as {key?:string}).key??'default')).rnd;
      return (async()=>{
        const traced=await runGeometryJobAsync3(hatchTraceJob(captured,rnd,scope!.onProgress),scope!.signal);check();timing.merge(traced.timings);
        const tone=await evaluateHatchTone(traced.value,scope!.compute3,scope!.signal);check();
        const result=await runGeometryJobAsync3(hatchAssembleJob(traced.value,tone),scope!.signal);check();timing.merge(result.timings);
        const stats=result.value.stats;
        exec.modeling3.push({operation:'hatch',backend:stats.tone.backend==='gpu'||stats.tone.backend==='mixed'?'gpu':'cpu',dispatches:stats.tone.dispatches,transferBytes:stats.tone.transferBytes,refinements:stats.tone.refinements+stats.tone.ambiguous,timings:timing.finish(),hatch:stats});
        return result.value.curves;
      })();
    },
    deform3(surface: Surface3, options: Omit<DeformOptions3, 'signal'>): Promise<Surface3> {
      check();
      const timing=new PhaseClock3(),captured = timing.measure('captureMs',()=>captureDeform3(surface, options));
      const capturedOptions = { iterations: captured.iterations, relaxation: captured.relaxation, displacements: captured.displacements, pinned: [...captured.pinned], signal: scope!.signal };
      return (async () => {
        const compute = scope!.compute3;
        if (compute && !compute.deform) throw new Error('host does not provide GPU deformation');
        const out = compute
          ? await compute.deform!(captured.surface, capturedOptions)
          : { surface: timing.measure('cpuMs',()=>deformSurfaceCpu3(captured.surface, capturedOptions)), stats: { dispatches: 0, transferBytes: 0, timings:undefined } };
        check();
        timing.merge(out.stats.timings);
        exec.modeling3.push({ operation: 'deform', backend: compute ? 'gpu' : 'cpu', ...out.stats, timings:timing.finish() });
        return out.surface;
      })();
    },
    querySurface3(surface: Surface3, queries: SurfaceQueryInput3): Promise<SurfaceQueryResult3> {
      check();
      const timing=new PhaseClock3(),{source,captured}=timing.measure('captureMs',()=>({source:prepareSurfaceQueries3(surface),captured:structuredClone(queries)}));
      return (async () => {
        const compute = scope!.compute3;
        if (compute && !compute.query) throw new Error('host does not provide GPU surface queries');
        const out = compute ? await compute.query!(source.surface, captured, { signal: scope!.signal }) : {
          result: timing.measure('cpuMs',()=>({ rays: source.rays(captured.rays ?? [], scope!.signal), segments: source.segments(captured.segments ?? [], scope!.signal), nearest: source.nearest(captured.nearest ?? [], scope!.signal) })),
          stats: { dispatches: 0, transferBytes: 0, timings:undefined },
        };
        check();
        timing.merge(out.stats.timings);
        exec.modeling3.push({ operation: 'query', backend: compute ? 'gpu' : 'cpu', ...out.stats, timings:timing.finish() });
        return out.result;
      })();
    },
  };
}

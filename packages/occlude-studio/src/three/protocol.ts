import type {RayQuery3,NearestQuery3} from 'occlude/src/three/queries/surface.js';
import type {QueryBatch3} from 'occlude/src/compute/webgpu/queries.js';
import type {Surface3} from 'occlude/src/three/geometry/surface.js';
import type {DeformOptions3} from 'occlude/src/three/geometry/deform.js';
import type {GpuDeform3} from 'occlude/src/compute/webgpu/deform.js';
import type { SurfaceObject3, WireObject3 } from 'occlude/src/three/features/snapshot.js';
import type { ClassifiedScene3 } from 'occlude/src/three/visibility/scene.js';
import type { CameraFrame3 } from 'occlude/src/three/camera.js';
import type { Triangle3, Vec3 } from 'occlude/src/three/math.js';
import type { GpuIntervalResult3, VisibilityPair3 } from 'occlude/src/compute/webgpu/interval.js';

/** Structured-cloned CPU snapshots only. No device/buffer crosses a worker. */
export interface ThreeRenderInput {
  readonly frame: CameraFrame3;
  readonly triangles: readonly Triangle3[];
  readonly wires: readonly (readonly [Vec3, Vec3])[];
  readonly pairs: readonly VisibilityPair3[];
  readonly geometryRevision: number;
  readonly cameraRevision: number;
  readonly parameterTolerance?: number;
}
export interface ThreeRenderResult {
  readonly gpu: GpuIntervalResult3;
  readonly adapter: { vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean };
  readonly geometryRevision: number;
  readonly cameraRevision: number;
  readonly deviceGeneration: number;
  readonly deviceReadyMs: number;
  readonly cold: boolean;
  readonly worker: true;
}
export interface ThreeSceneInput {
  readonly frame: CameraFrame3;
  readonly objects: readonly SurfaceObject3[];
  readonly wires: readonly WireObject3[];
  readonly geometryRevision: number;
  readonly cameraRevision: number;
}
export type ThreeSceneResult = Omit<ThreeRenderResult, 'gpu'> & { readonly drawing: ClassifiedScene3 };
export interface ThreeDeformInput { readonly surface:Surface3; readonly deformation:Omit<DeformOptions3,'signal'>;readonly geometryRevision:number;readonly cameraRevision:number }
export type ThreeDeformResult = Omit<ThreeRenderResult,'gpu'> & {readonly deformation:Awaited<ReturnType<GpuDeform3['deform']>>};
export interface ThreeQueryInput {readonly querySurface:Surface3;readonly rayQueries:readonly RayQuery3[];readonly nearestQueries:readonly NearestQuery3[];readonly geometryRevision:number;readonly cameraRevision:number}
export type ThreeQueryResult=Omit<ThreeRenderResult,'gpu'> & {readonly queries:{rays:QueryBatch3;nearest:QueryBatch3}};
export type ThreeJobInput = ThreeRenderInput | ThreeSceneInput | ThreeDeformInput | ThreeQueryInput;
export type ThreeJobResult = ThreeRenderResult | ThreeSceneResult | ThreeDeformResult | ThreeQueryResult;
export type ThreeWorkerRequest =
  | { type: 'init'; canvas: OffscreenCanvas; requireHardware: boolean }
  | { type: 'render'; id: number; input: ThreeJobInput }
  | { type: 'cancel'; id: number }
  | { type: 'dispose' };
export type ThreeWorkerResponse =
  | { type: 'result'; id: number; result: ThreeJobResult }
  | { type: 'error'; id: number; name: string; message: string }
  | { type: 'disposed' };
export const abandonedThreeJob = () => new DOMException('3D render superseded or cancelled', 'AbortError');

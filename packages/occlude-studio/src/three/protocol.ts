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
export type ThreeWorkerRequest =
  | { type: 'init'; canvas: OffscreenCanvas; requireHardware: boolean }
  | { type: 'render'; id: number; input: ThreeRenderInput }
  | { type: 'cancel'; id: number }
  | { type: 'dispose' };
export type ThreeWorkerResponse =
  | { type: 'result'; id: number; result: ThreeRenderResult }
  | { type: 'error'; id: number; name: string; message: string }
  | { type: 'disposed' };
export const abandonedThreeJob = () => new DOMException('3D render superseded or cancelled', 'AbortError');

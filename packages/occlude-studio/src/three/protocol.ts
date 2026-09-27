import type {RayQuery3,NearestQuery3} from 'occlude/src/three/queries/surface.js';
import type {QueryBatch3} from 'occlude/src/compute/webgpu/queries.js';
import {kinds,kindOf,type AnyColumn} from 'occlude/src/column.js';
import type {Material} from 'occlude/src/material.js';
import {DOMAINS3,kernelColumn,made3,mesh3,type Domain3} from 'occlude/src/three/geometry/mesh3.js';
import type {DeformInput3,DeformOptions3} from 'occlude/src/three/geometry/deform.js';
import type {GpuDeform3} from 'occlude/src/compute/webgpu/deform.js';
import type { SurfaceObject3, WireObject3 } from 'occlude/src/three/features/snapshot.js';
import type { ClassifiedScene3 } from 'occlude/src/three/visibility/scene.js';
import type { CameraFrame3 } from 'occlude/src/three/camera.js';
import type { Triangle3, Vec3 } from 'occlude/src/three/math.js';
import type { GpuIntervalResult3, VisibilityPair3 } from 'occlude/src/compute/webgpu/interval.js';

/** A value in space as plain data, the way it crosses to the worker and into
 * a saved result: a value holds readers and caches that do not clone. Every
 * row keeps its kernel name, every face its fixed triangles (positions round
 * its loop) and every numeric, boolean, string or vector column its values,
 * so the value read back draws what the value written would. */
export interface MeshRecord3 {
  readonly positions: readonly Vec3[];
  readonly faces: readonly (readonly number[])[];
  readonly triangles: readonly (readonly number[])[];
  readonly edges: readonly (readonly [number, number])[];
  readonly names: Readonly<Record<Domain3, readonly string[]>>;
  readonly columns: Readonly<Record<Domain3, Readonly<Record<string, ColumnRecord3>>>>;
}
/** One column: its kind (a vector's width) and one value a row. */
export interface ColumnRecord3 { readonly kind: 'number' | 'boolean' | 'string' | 'vector'; readonly width?: number; readonly values: readonly unknown[] }
/** `m` as plain data (see `MeshRecord3`). */
export function meshRecord3(m: Material): MeshRecord3 {
  const read = mesh3(m);
  const columns = {} as Record<Domain3, Record<string, ColumnRecord3>>;
  for (const d of DOMAINS3) {
    const own: Record<string, ColumnRecord3> = {}, cols = read.cols[d];
    const count = d === 'points' ? read.n : d === 'edges' ? read.edgeCount : d === 'faces' ? read.faceCount : read.cornerCount;
    for (const name in cols) {
      const column = cols[name];
      if (!kernelColumn(column)) continue;
      const kind = kindOf(column) as { name: ColumnRecord3['kind']; width: number };
      own[name] = { kind: kind.name, ...(kind.name === 'vector' ? { width: kind.width } : {}), values: Array.from({ length: count }, (_, i) => (column as { get(i: number): unknown }).get(i)) };
    }
    columns[d] = own;
  }
  return {
    positions: read.positions.map(p => [p[0], p[1], p[2]] as Vec3),
    faces: read.loops.map(loop => [...loop]),
    triangles: read.loops.map((_, f) => [...read.localTriangles(f)]),
    edges: Array.from({ length: read.edgeCount }, (_, e) => [read.edges[2 * e], read.edges[2 * e + 1]] as const),
    names: { points: [...read.names.points], edges: [...read.names.edges], faces: [...read.names.faces], corners: [...read.names.corners] },
    columns,
  };
}
/** The value a record was written from (see `MeshRecord3`). */
export function meshOfRecord3(record: MeshRecord3): Material {
  const cols = {} as Record<Domain3, Record<string, AnyColumn>>;
  for (const d of DOMAINS3) {
    const own: Record<string, AnyColumn> = {};
    for (const [name, column] of Object.entries(record.columns[d])) {
      const kind = column.kind === 'vector' ? kinds.vector(column.width!) : kinds[column.kind];
      own[name] = (kind as { from(values: readonly unknown[]): AnyColumn }).from(column.values);
    }
    cols[d] = own;
  }
  return made3({
    x: record.positions.map(p => p[0]), y: record.positions.map(p => p[1]), z: record.positions.map(p => p[2]),
    names: record.names, loops: record.faces, triangles: record.triangles, edges: record.edges.flat(), cols,
  });
}

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
/** A scene object as it crosses to the worker: its value as a record. */
export type ThreeSceneObject = Omit<SurfaceObject3, 'surface' | 'curves' | 'hatch' | 'binding'> & { readonly surface: MeshRecord3 };
export interface ThreeSceneInput {
  readonly frame: CameraFrame3;
  readonly objects: readonly ThreeSceneObject[];
  readonly wires: readonly WireObject3[];
  readonly geometryRevision: number;
  readonly cameraRevision: number;
}
export type ThreeSceneResult = Omit<ThreeRenderResult, 'gpu'> & { readonly drawing: ClassifiedScene3 };
export interface ThreeDeformInput { readonly mesh:DeformInput3; readonly deformation:Omit<DeformOptions3,'signal'>;readonly geometryRevision:number;readonly cameraRevision:number }
export type ThreeDeformResult = Omit<ThreeRenderResult,'gpu'> & {readonly deformation:Awaited<ReturnType<GpuDeform3['deform']>>};
export interface ThreeQueryInput {readonly querySurface:MeshRecord3;readonly rayQueries:readonly RayQuery3[];readonly nearestQueries:readonly NearestQuery3[];readonly geometryRevision:number;readonly cameraRevision:number}
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

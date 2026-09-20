import { cameraFrame3, cameraShift3, toCamera3, type Camera3, type CameraFrame3 } from 'occlude/src/three/camera.js';
import { transformSurface3 } from 'occlude/src/three/geometry/model.js';
import { SurfaceQueries3 } from 'occlude/src/three/queries/surface.js';
import type { LineArtScene3 } from 'occlude/src/three/scene.js';
import { add3, mul3, type Triangle3, type Vec3 } from 'occlude/src/three/math.js';

export interface ConstructionInfo3 { camera: Camera3; objects: number; triangles: number; wires: number; bounds?: { min: Vec3; max: Vec3 }; viewport?: { x: number; y: number; width: number; height: number } }
/** World bounds over placed vertices and wires, for framing (Blender Home). */
export function constructionBounds3(scene: LineArtScene3): { min: Vec3; max: Vec3 } | undefined {
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  const take = (p: Vec3) => { for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; } };
  for (const object of scene.objects) { const surface = object.transform ? transformSurface3(object.surface, object.transform) : object.surface; for (const point of surface.points) take(point.position); }
  for (const wire of scene.wires) for (const p of wire.points) take(p);
  return Number.isFinite(min[0]) ? { min: min as unknown as Vec3, max: max as unknown as Vec3 } : undefined;
}
export const constructionInfo3 = (scene: LineArtScene3): ConstructionInfo3 => ({
  camera: scene.camera, objects: scene.objects.length,
  triangles: scene.objects.reduce((n,o)=>n+o.surface.triangles.length,0),
  wires: scene.objects.reduce((n,o)=>n+o.surface.edges.length,0)+scene.wires.reduce((n,w)=>n+Math.max(0,w.points.length-1),0),
  bounds: constructionBounds3(scene),
});
export interface ConstructionPick3 { objectId: string; faceId: string; triangle: number; point: Vec3; barycentric: Vec3; attributes: Record<string, unknown> }
/** World geometry is captured once per scene, independent of the preview camera.
 * It stays in the construction worker; only metadata and picks cross to the UI. */
export class ConstructionScene3 {
  readonly triangles: Triangle3[] = [];
  readonly wires: (readonly [Vec3, Vec3])[] = [];
  private readonly objects: { id: string; query: SurfaceQueries3 }[] = [];
  readonly info: ConstructionInfo3;
  constructor(scene: LineArtScene3) {
    for (const object of scene.objects) {
      const surface = object.transform ? transformSurface3(object.surface, object.transform) : object.surface;
      const query = new SurfaceQueries3(surface);
      this.objects.push({ id: object.id, query });
      for (const tri of query.triangles) this.triangles.push(tri);
      for (const edge of surface.edges) this.wires.push(edge.vertices.map(i => surface.points[i].position) as unknown as readonly [Vec3, Vec3]);
    }
    for (const wire of scene.wires) for (let i = 1; i < wire.points.length; i++) this.wires.push([wire.points[i-1], wire.points[i]]);
    this.info = { camera: scene.camera, objects: scene.objects.length, triangles: this.triangles.length, wires: this.wires.length };
  }
  project(frame: CameraFrame3) {
    return { triangles: this.triangles.map(t => t.map(p => toCamera3(frame, p)) as unknown as Triangle3), wires: this.wires.map(w => w.map(p => toCamera3(frame, p)) as unknown as readonly [Vec3, Vec3]) };
  }
  pick(camera: Camera3, width: number, height: number, x: number, y: number): ConstructionPick3 | null {
    if (![x,y].every(Number.isFinite)) throw new Error('invalid construction pick');
    const frame = cameraFrame3(camera, { x: 0, y: 0, width, height });
    const scale = camera.kind === 'orthographic' ? camera.span/2 : Math.tan(camera.fovDegrees*Math.PI/360);
    // An oblique frame sits off the optical axis, so the pixel's own ray does too.
    const s = cameraShift3(camera);
    const offset = add3(mul3(frame.right,(2*x-1-s[0])*width/height*scale),mul3(frame.up,(1-2*y-s[1])*scale));
    const ray = { origin: camera.kind === 'orthographic' ? add3(camera.eye,offset) : camera.eye, direction: camera.kind === 'orthographic' ? mul3(frame.back,-1) : add3(mul3(frame.back,-1),offset), near: camera.near, far: camera.far };
    let best: (ConstructionPick3 & { distance: number }) | null = null;
    for (const object of this.objects) {
      const hit = object.query.rays([ray])[0];
      if (hit && (!best || hit.distance < best.distance)) {
        const face = object.query.surface.faces[object.query.surface.triangles[hit.triangle].face];
        best = { objectId: object.id, faceId: hit.faceId, triangle: hit.triangle, point: hit.point, barycentric: hit.barycentric, attributes: structuredClone(face.attributes), distance: hit.distance };
      }
    }
    if (!best) return null;
    const { distance, ...pick } = best;
    return pick;
  }
}

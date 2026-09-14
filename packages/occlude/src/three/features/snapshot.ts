import { realizeHatch3, validateHatch3, type HatchSource3 } from '../curves/hatch.js';
import type { UnitCtx } from '../../units.js';
import { validateSurfaceCurves3, type SurfaceCurves3, type SurfaceCurvePoint3, type SurfaceCurveSegment3 } from '../curves/surface.js';
import { orient3d } from 'robust-predicates';
import { clipSegment3, clipTriangle3, toCamera3, toPaper3, type CameraFrame3 } from '../camera.js';
import { cross3, dot3, lerp3, mul3, sub3, unit3, type Triangle3, type Vec3 } from '../math.js';
import { transformSurface3 } from '../geometry/model.js';
import type { Attributes3, Surface3 } from '../geometry/surface.js';
import { occlusionVolume3, type Interval3, type SegmentBasis3, type OcclusionVolume3 } from '../visibility/interval.js';
import { ProjectedIndex3, projectedBounds3, type Bounds3 } from '../visibility/index.js';

export const FeatureKind3 = { boundary: 1, silhouette: 2, crease: 4, marked: 8, wire: 16, section: 32, hatch: 64 } as const;
export interface InstanceSource3 {readonly id:string;readonly pointId:string;readonly pointIndex:number;readonly prototypeKey?:string}
export interface SurfaceObject3 { readonly instance?:InstanceSource3; readonly id: string; readonly surface: Surface3; readonly curves?: SurfaceCurves3; readonly hatch?: HatchSource3; readonly transform?: Parameters<typeof transformSurface3>[1]; readonly lineSource?: boolean; readonly occluder?: boolean; readonly attributes?: Attributes3 }
export interface WireObject3 { readonly id: string; readonly points: readonly Vec3[]; readonly attributes?: Attributes3 }
export interface Feature3 {
  /** Source placement identity, independent of per-view object naming. */
  readonly instance?:InstanceSource3;
  /** Captured model-space curve data before camera clipping, when generated. */
  readonly curve?: SurfaceCurveSegment3;
  /** Camera/world affine source terms, retained through near/far clipping. */
  readonly basis?: SegmentBasis3;
  readonly id: string;
  readonly objectId: string;
  readonly sourceId: string;
  readonly flags: number;
  readonly creaseAngle: number;
  readonly a: Vec3;
  readonly b: Vec3;
  /** Original source parameter range, before near/far clipping. */
  readonly range: Interval3;
  readonly endpoints: readonly [string, string];
  readonly support: readonly string[];
  readonly attributes: Readonly<Attributes3>;
  readonly faceAttributes: readonly Readonly<Attributes3>[];
}
export interface Occluder3 { readonly id: string; readonly triangle: Triangle3; readonly bounds: Bounds3; readonly volume: OcclusionVolume3 }
export interface FeatureSnapshot3 {
  readonly frame: CameraFrame3;
  readonly features: readonly Feature3[];
  readonly triangles: readonly Triangle3[];
  readonly occluders: readonly Occluder3[];
  readonly index: ProjectedIndex3;
}
const key = (...parts: (string | number)[]) => JSON.stringify(parts);
const attributes = (a: Attributes3 = {}): Readonly<Attributes3> => Object.freeze(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Array.isArray(v) ? Object.freeze([...v]) : v])));
const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

/** Extract once from owned geometry snapshots. All original edges and angles
 * are retained so downstream thresholds/marks can select without re-dispatch.
 * Planar triangulation diagonals are not candidates. A folded face's actual
 * triangle-facing transition is a silhouette and retains face parentage. */
export function featureSnapshot3(objects: readonly SurfaceObject3[], wires: readonly WireObject3[], frame: CameraFrame3, units:UnitCtx={innerW:frame.paper.width,innerH:frame.paper.height}): FeatureSnapshot3 {
  const features: Feature3[] = [], triangles: Triangle3[] = [], occluders: Occluder3[] = [];
  const worldView=Object.freeze({perspective:frame.camera.kind==='perspective',eye:frame.camera.eye,target:frame.camera.target,back:frame.back,near:frame.camera.near,far:frame.camera.far});
  const ids = [...objects, ...wires].map(v => v.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !id)) throw new Error('scene object IDs must be nonempty and unique');
  const add = (feature: Omit<Feature3, 'range'>) => {
    const range = clipSegment3(feature.a, feature.b, frame.camera.near, frame.camera.far);
    if (!range || Math.hypot(...sub3(feature.a, feature.b)) === 0) return;
    const basisAt = (t: number) => {
      const basis = feature.basis!;
      if (t === 0) return basis[0];
      if (t === 1) return basis[1];
      return Object.freeze([
        ...basis[0].map(v => Object.freeze({ ...v, weight: v.weight * (1-t) })),
        ...basis[1].map(v => Object.freeze({ ...v, weight: v.weight * t })),
      ]);
    };
    features.push(Object.freeze({
      ...feature,
      a: Object.freeze([...lerp3(feature.a, feature.b, range[0])]) as Vec3,
      b: Object.freeze([...lerp3(feature.a, feature.b, range[1])]) as Vec3,
      range: Object.freeze(range),
      basis: feature.basis && Object.freeze([basisAt(range[0]), basisAt(range[1])]) as SegmentBasis3,
      support: Object.freeze([...feature.support]),
      endpoints: Object.freeze([...feature.endpoints]) as readonly [string, string],
      faceAttributes: Object.freeze([...feature.faceAttributes]),
    }));
  };
  for (const object of objects) {
    if(object.curves)validateSurfaceCurves3(object.curves,object.surface);
    if(object.hatch)validateHatch3(object.hatch,object.surface);
    const surface = object.transform ? transformSurface3(object.surface, object.transform) : object.surface;
    const worldPositions=surface.points.map(p=>Object.freeze([...p.position]) as Vec3);
    const positions=worldPositions.map(p=>Object.freeze(toCamera3(frame,p)));
    const edgeBasis=(vertices:readonly [number,number]):SegmentBasis3=>Object.freeze(vertices.map(v=>Object.freeze([Object.freeze({point:positions[v],world:worldPositions[v],weight:1})]))) as SegmentBasis3;
    const faceAttrs = surface.faces.map(f => attributes(f.attributes));
    const faceTriangles: number[][] = surface.faces.map(() => []);
    surface.triangles.forEach((t,i)=>faceTriangles[t.face].push(i));
    const planar = surface.faces.map((face, i) => {
      const t=surface.triangles[faceTriangles[i][0]];
      const [a,b,c]=t.vertices.map(v=>surface.points[v].position);
      return face.vertices.every(v=>orient3d(...a,...b,...c,...surface.points[v].position)===0);
    });
    const originals = new Map(surface.edges.map(e => [edgeKey(...e.vertices), e]));
    const triangleEdges = new Map<string, { vertices: readonly [number, number]; triangles: number[] }>();
    const worldNormals: Vec3[] = [], facing: number[] = [], triangleIds: string[] = [];
    surface.triangles.forEach((t, i) => {
      const triangle = t.vertices.map(v => positions[v]) as unknown as Triangle3;
      const n = unit3(cross3(sub3(triangle[1], triangle[0]), sub3(triangle[2], triangle[0])));
      const world = Object.freeze(t.vertices.map(v => worldPositions[v])) as unknown as Triangle3;
      const worldVolume=Object.freeze({triangle:world,view:worldView});
      worldNormals.push(unit3(cross3(sub3(world[1], world[0]), sub3(world[2], world[0]))));
      facing.push(frame.camera.kind === 'perspective' ? dot3(n, mul3(triangle[0], -1)) : n[2]);
      const id = key(object.id, surface.faces[t.face].id, ...t.vertices.map(v => surface.points[v].id)); triangleIds.push(id);
      for (let j = 0; j < 3; j++) {
        const a = t.vertices[j], b = t.vertices[(j + 1) % 3], k = edgeKey(a, b), edge = triangleEdges.get(k);
        if (edge) edge.triangles.push(i); else triangleEdges.set(k, { vertices: [a, b], triangles: [i] });
      }
      for (const clipped of clipTriangle3(triangle, frame.camera.near, frame.camera.far)) {
        const owned = Object.freeze(clipped.map(p => Object.freeze([...p]))) as unknown as Triangle3;
        triangles.push(owned);
        if (object.occluder === false) continue;
        const volume = occlusionVolume3(clipped, frame.camera.kind === 'perspective');
        if (volume) occluders.push(Object.freeze({ id, triangle: owned, volume:Object.freeze({...volume,world:worldVolume}), bounds: Object.freeze(projectedBounds3(owned.map(p => toPaper3(frame, p)))) }));
      }
    });
    if (object.lineSource === false) continue;
    for (const [k, edge] of triangleEdges) {
      const original = originals.get(k), incident = edge.triangles;
      if (incident.length > 2) throw new Error('non-manifold render triangulation');
      const silhouette = incident.length === 2 && (facing[incident[0]] > 0) !== (facing[incident[1]] > 0);
      if (!original && !silhouette) continue;
      let angle = 0;
      if (incident.length === 2) {
        // Creases belong to the model, independent of camera-space roundoff.
        // Exact coplanarity avoids inventing folds; atan2 retains real shallow folds.
        const [left, right] = incident.map(i => worldNormals[i]);
        const [a, b, c] = surface.triangles[incident[0]].vertices.map(v => surface.points[v].position);
        const coplanar = surface.triangles[incident[1]].vertices.every(v => orient3d(...a, ...b, ...c, ...surface.points[v].position) === 0);
        const cosine = dot3(left, right);
        angle = coplanar && cosine > 0 ? 0 : Math.atan2(Math.hypot(...cross3(left, right)), cosine) * 180 / Math.PI;
      }
      const sourceId = original?.id ?? key('diagonal', surface.faces[surface.triangles[incident[0]].face].id, ...edge.vertices.map(v => surface.points[v].id));
      const flags = (original?.faces.length === 1 ? FeatureKind3.boundary : 0) | (silhouette ? FeatureKind3.silhouette : 0) | (original && angle > 0 ? FeatureKind3.crease : 0) | (original?.attributes.marked === true ? FeatureKind3.marked : 0);
      const support = [...new Set(incident.flatMap(i => { const f=surface.triangles[i].face; return planar[f] ? faceTriangles[f] : [i]; }))].map(i=>triangleIds[i]);
      add({ ...(object.instance?{instance:Object.freeze({...object.instance})}:{}), id: key(object.id, sourceId), objectId: object.id, sourceId, flags, creaseAngle: angle, a: positions[edge.vertices[0]], b: positions[edge.vertices[1]], basis:edgeBasis(edge.vertices), endpoints: edge.vertices.map(v => key(object.id, surface.points[v].id)) as [string, string], support, attributes: attributes({ ...object.attributes, ...original?.attributes }), faceAttributes: [...new Set(incident.map(i => surface.triangles[i].face))].map(i => faceAttrs[i]) });
    }
    for(const edge of surface.edges){
      if(edge.faces.length)continue;
      add({...(object.instance?{instance:Object.freeze({...object.instance})}:{}),id:key(object.id,edge.id),objectId:object.id,sourceId:edge.id,flags:FeatureKind3.wire,creaseAngle:0,a:positions[edge.vertices[0]],b:positions[edge.vertices[1]],basis:edgeBasis(edge.vertices),endpoints:edge.vertices.map(v=>key(object.id,surface.points[v].id)) as [string,string],support:[],attributes:attributes({...object.attributes,...edge.attributes}),faceAttributes:[]});
    }
    const hatch=object.hatch?realizeHatch3(object.hatch,surface,frame,units):undefined;
    if(hatch)validateSurfaceCurves3(hatch,object.surface);
    for(const curve of [...object.curves?.segments??[],...hatch?.segments??[]]) {
      const position=(p:SurfaceCurvePoint3):Vec3=>p.vertices.reduce((sum,v,i)=>sum.map((x,k)=>x+positions[v][k]*p.weights[i]) as unknown as Vec3,[0,0,0] as Vec3);
      const basis = Object.freeze([curve.a, curve.b].map(p => Object.freeze(p.vertices.flatMap((v,i) => p.weights[i] === 0 ? [] : [Object.freeze({ point: positions[v], world:worldPositions[v], weight: p.weights[i] })])))) as SegmentBasis3;
      const faces=[...new Set(curve.triangles.map(i=>surface.triangles[i].face))];
      const support=[...new Set(curve.triangles.flatMap(i=>{const face=surface.triangles[i].face;return planar[face]?faceTriangles[face]:[i];}))].map(i=>triangleIds[i]);
      add({...(object.instance?{instance:Object.freeze({...object.instance})}:{}),id:key(object.id,curve.id),objectId:object.id,sourceId:curve.id,flags:curve.kind==='hatch'?FeatureKind3.hatch:FeatureKind3.section,curve,basis,creaseAngle:0,a:position(curve.a),b:position(curve.b),endpoints:[key(object.id,'curve',curve.a.id),key(object.id,'curve',curve.b.id)],support,attributes:attributes({...object.attributes,...curve.attributes}),faceAttributes:faces.map(i=>faceAttrs[i])});
    }
  }
  for (const wire of wires) for (let i = 0; i + 1 < wire.points.length; i++) {
    const world=[wire.points[i],wire.points[i+1]].map(p=>Object.freeze([...p]) as Vec3);
    const positions=world.map(p=>Object.freeze(toCamera3(frame,p)));
    const basis=Object.freeze(positions.map((point,i)=>Object.freeze([Object.freeze({point,world:world[i],weight:1})]))) as SegmentBasis3;
    add({ id: key(wire.id, i), objectId: wire.id, sourceId: `segment:${i}`, flags: FeatureKind3.wire, creaseAngle: 0, a: positions[0], b: positions[1], basis, endpoints: [key(wire.id, i), key(wire.id, i + 1)], support: [], attributes: attributes(wire.attributes), faceAttributes: [] });
  }
  return Object.freeze({ frame, features: Object.freeze(features), triangles: Object.freeze(triangles), occluders: Object.freeze(occluders), index: new ProjectedIndex3(occluders.map(t => t.bounds)) });
}

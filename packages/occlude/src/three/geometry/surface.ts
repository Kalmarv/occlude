import {inheritTopology3} from './topology.js';
import { orient2d } from 'robust-predicates';
import { add3, cross3, dot3, finite3, mul3, sub3, type Vec3 } from '../math.js';

export type Attribute3 = number | string | boolean | readonly number[];
export type Attributes3 = Record<string, Attribute3>;
export interface Provenance3 { readonly operation: string; readonly parents: readonly string[] }
export interface SurfacePoint3 { readonly provenance?: Provenance3; readonly id: string; position: Vec3; attributes: Attributes3 }
/** One corner per polygon vertex, in the polygon's winding order. */
export interface SurfaceCorner3 { readonly id:string; readonly provenance?:Provenance3; attributes:Attributes3 }
export interface SurfaceFace3 { readonly provenance?: Provenance3; readonly id: string; readonly vertices: readonly number[]; readonly corners?:readonly SurfaceCorner3[]; attributes: Attributes3 }
export interface SurfaceEdge3 { readonly provenance?: Provenance3; readonly id: string; readonly vertices: readonly [number, number]; readonly faces: readonly number[]; attributes: Attributes3 }
export interface SurfaceTriangle3 { readonly vertices: readonly [number, number, number]; readonly face: number }
/** Polygon topology and its fixed triangulation are separate. Positions and
 * attributes are editable; topology operations create a new surface value. */
export interface Surface3 {
  readonly points: readonly SurfacePoint3[];
  readonly faces: readonly SurfaceFace3[];
  readonly edges: readonly SurfaceEdge3[];
  readonly triangles: readonly SurfaceTriangle3[];
}
const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
/** Attribute values are primitives or numeric arrays, and provenance is a
 * string plus a string list: a shallow copy with fresh arrays is the same
 * independent value structuredClone produces, without its serialization. */
function copyAttributes(attributes:Attributes3):Attributes3 {
  const out:Attributes3={};
  for(const name in attributes){const value=attributes[name];out[name]=Array.isArray(value)?[...value]:value;}
  return out;
}
const copyProvenance=(provenance:Provenance3):Provenance3=>({operation:provenance.operation,parents:[...provenance.parents]});

/** Deterministic ear clipping of a simple planar polygon. No fan triangulation
 * of concave faces; robust orientation guards crossings and ear containment. */
function triangulate(positions: readonly Vec3[], vertices: readonly number[]): [number, number, number][] {
  const origin = positions[vertices[0]];
  const local = vertices.map(i => sub3(positions[i], origin));
  const extent = Math.max(...local.map(p => Math.hypot(...p)));
  if (!(extent > 0) || !Number.isFinite(extent)) throw new Error('surface face has zero or unrepresentable extent');
  const normalized = local.map(p => mul3(p, 1 / extent));
  let normal: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < normalized.length; i++) normal = add3(normal, cross3(normalized[i], normalized[i + 1]));
  const norm = Math.hypot(...normal);
  if (!(norm > 1e-14)) throw new Error('surface face is degenerate or has cancelling winding');
  normal = mul3(normal, 1 / norm);
  if (normalized.some(p => Math.abs(dot3(normal, p)) > 1e-10)) throw new Error('new surface faces must be planar; deform a triangulated surface for piecewise nonplanar geometry');
  const drop = Math.abs(normal[0]) > Math.abs(normal[1]) ? (Math.abs(normal[0]) > Math.abs(normal[2]) ? 0 : 2) : (Math.abs(normal[1]) > Math.abs(normal[2]) ? 1 : 2);
  const projected = normalized.map(p => drop === 0 ? [p[1], p[2]] : drop === 1 ? [p[0], p[2]] : [p[0], p[1]]);
  const turn = (a: number, b: number, c: number) => -orient2d(...projected[a] as [number, number], ...projected[b] as [number, number], ...projected[c] as [number, number]);
  const between = (a: number, b: number, p: number) => projected[p].every((v, k) => v >= Math.min(projected[a][k], projected[b][k]) && v <= Math.max(projected[a][k], projected[b][k]));
  for (let i = 0; i < vertices.length; i++) for (let j = i + 1; j < vertices.length; j++) {
    const b = (i + 1) % vertices.length, d = (j + 1) % vertices.length;
    if (i === j || b === j || d === i) continue;
    const x = turn(i, b, j), y = turn(i, b, d), z = turn(j, d, i), w = turn(j, d, b);
    if ((x * y < 0 && z * w < 0) || (x === 0 && between(i, b, j)) || (y === 0 && between(i, b, d)) || (z === 0 && between(j, d, i)) || (w === 0 && between(j, d, b))) throw new Error('surface face must be simple without crossings or touching edges');
  }
  const area = projected.reduce((sum, p, i) => { const q = projected[(i + 1) % projected.length]; return sum + p[0] * q[1] - p[1] * q[0]; }, 0);
  const sign = Math.sign(area), remaining = vertices.map((_, i) => i), triangles: [number, number, number][] = [];
  while (remaining.length > 3) {
    let found = false;
    for (let j = 0; j < remaining.length; j++) {
      const a = remaining[(j + remaining.length - 1) % remaining.length], b = remaining[j], c = remaining[(j + 1) % remaining.length];
      if (turn(a, b, c) * sign <= 0) continue;
      if (remaining.some(p => p !== a && p !== b && p !== c && turn(a, b, p) * sign >= 0 && turn(b, c, p) * sign >= 0 && turn(c, a, p) * sign >= 0)) continue;
      triangles.push([vertices[a], vertices[b], vertices[c]]); remaining.splice(j, 1); found = true; break;
    }
    if (!found) throw new Error('surface face cannot be triangulated without degeneracy');
  }
  if (turn(remaining[0], remaining[1], remaining[2]) * sign <= 0) throw new Error('surface face has a degenerate final triangle');
  triangles.push(remaining.map(i => vertices[i]) as [number, number, number]);
  return triangles;
}

/** Internal topology assembly keeps fixed triangles after deformation. */
export function assembleSurface3(points: readonly SurfacePoint3[], faces: readonly SurfaceFace3[], triangles: readonly SurfaceTriangle3[], previous?: Surface3): Surface3 {
  points.forEach(p=>finite3(p.position));
  for (const rows of [points,faces]) if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error('surface IDs must be unique within their domain');
  const edges = new Map<string, { vertices: [number, number]; faces: number[]; forward: number }>();
  faces.forEach(({vertices},face)=>{
    if (vertices.length < 3 || new Set(vertices).size !== vertices.length || vertices.some(v => !Number.isInteger(v) || v < 0 || v >= points.length)) throw new Error('surface face requires at least three distinct valid point indices');
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i], b = vertices[(i + 1) % vertices.length], key = edgeKey(a, b);
      const existing = edges.get(key);
      if (existing) {
        if (existing.faces.length === 2) throw new Error('non-manifold edge: more than two incident faces');
        if (existing.forward === a) throw new Error('adjacent face winding must oppose along the shared edge');
        existing.faces.push(face);
      } else edges.set(key, { vertices: a < b ? [a, b] : [b, a], faces: [face], forward: a });
    }
  });
  // Loose edges are authoring topology too. Preserve them through point edits,
  // snapshots and transforms, remapping by point identity after extraction.
  if(previous){
    const indices=new Map(points.map((p,i)=>[p.id,i]));
    for(const edge of previous.edges){
      if(edge.faces.length)continue;
      const [a,b]=edge.vertices.map(v=>indices.get(previous.points[v]?.id));
      if(a===undefined||b===undefined)continue;
      if(a===b)throw new Error('loose edge requires distinct point indices');
      const key=edgeKey(a,b);
      if(!edges.has(key))edges.set(key,{vertices:[a,b],faces:[],forward:a});
    }
  }
  const previousFaces=new Map(previous?.faces.map(f=>[f.id,f]));
  const cornerIds=new Set<string>();
  const cornerRows=faces.map(face=>{
    if(face.corners&&face.corners.length!==face.vertices.length)throw new Error('face corners must correspond to every polygon vertex');
    const old=previousFaces.get(face.id),byPoint=new Map(old?.vertices.map((v,i)=>[previous!.points[v].id,old.corners?.[i]]));
    return Object.freeze(face.vertices.map((v,i)=>{
      if(face.corners&&!face.corners[i])throw new Error('explicit face corners must contain a record at every vertex');
      const inherited=face.corners?.[i]??byPoint.get(points[v].id);
      const corner:SurfaceCorner3=inherited??{id:JSON.stringify(['corner',face.id,points[v].id]),attributes:{}};
      if(typeof corner.id!=='string'||!corner.id||cornerIds.has(corner.id))throw new Error('surface corner IDs must be nonempty and unique');
      if(!corner.attributes||typeof corner.attributes!=='object'||Array.isArray(corner.attributes))throw new Error('corner attributes require a record');
      cornerIds.add(corner.id);
      return {...corner,attributes:copyAttributes(corner.attributes),...(corner.provenance?{provenance:copyProvenance(corner.provenance)}:{})};
    }));
  });
  const prior=new Map(previous?.edges.map(e=>[JSON.stringify(e.vertices.map(v=>previous.points[v].id).sort()),e]));
  const result:Surface3={ points: Object.freeze(points.map(p=>({...p,...(p.provenance?{provenance:copyProvenance(p.provenance)}:{}),position:[...p.position] as Vec3,attributes:copyAttributes(p.attributes)}))), faces: Object.freeze(faces.map((f,i)=>({...f,corners:cornerRows[i],...(f.provenance?{provenance:copyProvenance(f.provenance)}:{}),vertices:Object.freeze([...f.vertices]),attributes:copyAttributes(f.attributes)}))), triangles: Object.freeze(triangles.map(t=>Object.freeze({...t,vertices:Object.freeze([...t.vertices]) as readonly [number,number,number]}))), edges: Object.freeze([...edges.values()].map(e => {
    const old=prior.get(JSON.stringify(e.vertices.map(v=>points[v].id).sort()));
    return { ...(old?.provenance?{provenance:copyProvenance(old.provenance)}:{}), id: old?.id ?? `e:${points[e.vertices[0]].id}:${points[e.vertices[1]].id}`, vertices: Object.freeze(e.vertices), faces: Object.freeze(e.faces), attributes: copyAttributes(old?.attributes??{}) };
  })) };
  inheritTopology3(result,previous);return result;
}
export function surface3(positions: readonly Vec3[], polygons: readonly (readonly number[])[]): Surface3 {
  positions.forEach(finite3);
  const points=positions.map((position,i)=>({id:`p${i}`,position,attributes:{}}));
  const faces=polygons.map((vertices,i)=>({id:`f${i}`,vertices,attributes:{}}));
  const triangles:SurfaceTriangle3[]=[];
  faces.forEach((f,face)=>{
    if (f.vertices.length < 3 || new Set(f.vertices).size !== f.vertices.length || f.vertices.some(v => !Number.isInteger(v) || v < 0 || v >= points.length)) throw new Error('surface face requires at least three distinct valid point indices');
    for(const vertices of triangulate(positions,f.vertices))triangles.push({vertices,face});
  });
  return assembleSurface3(points,faces,triangles);
}

export function box3(size: Vec3 = [1, 1, 1], center: Vec3 = [0, 0, 0]): Surface3 {
  finite3(size); finite3(center);
  if (size.some(v => v <= 0)) throw new Error('box dimensions must be positive');
  const signs: Vec3[] = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
  return surface3(signs.map(p => p.map((v, i) => center[i] + v * size[i] / 2) as unknown as Vec3), [[3,2,1,0],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]]);
}

/** Editable point-only geometry. Drawing remains explicit through scene wires
 * or a later point interpretation; no implicit connecting edges are created. */
export function pointCloud3(positions: readonly Vec3[]): Surface3 {
  return surface3(positions, []);
}

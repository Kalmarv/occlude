import { groupRows } from '../../groupRows.js';
import { add3,cross3,finite3,mul3,sub3,unit3,type Vec3 } from '../math.js';
import { assembleSurface3,surface3,type Surface3,type SurfaceFace3,type SurfaceTriangle3,type Attributes3 } from './surface.js';

export function grid3(columns:number,rows:number,size:readonly[number,number]=[1,1]):Surface3 {
  if(!Number.isSafeInteger(columns)||!Number.isSafeInteger(rows)||columns<1||rows<1||columns*rows>1_000_000||size.some(n=>!Number.isFinite(n)||n<=0))throw new Error('grid needs positive cell counts and dimensions (at most one million faces)');
  const positions:Vec3[]=[],faces:number[][]=[];
  for(let y=0;y<=rows;y++)for(let x=0;x<=columns;x++)positions.push([(x/columns-.5)*size[0],(y/rows-.5)*size[1],0]);
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){const p=y*(columns+1)+x;faces.push([p,p+1,p+columns+2,p+columns+1]);}
  return surface3(positions,faces);
}
export interface FaceMeasure3 { readonly source:Surface3;readonly index:number;readonly id:string;readonly normal:Vec3;readonly center:Vec3;readonly area:number;readonly attributes:Readonly<Attributes3>;readonly adjacent:readonly number[] }
/** Measures follow the represented triangles, including deformed polygons. */
export function measureFaces3(surface:Surface3):readonly FaceMeasure3[] {
  const normals=surface.faces.map(()=>[0,0,0] as Vec3),centers=surface.faces.map(()=>[0,0,0] as Vec3),areas=surface.faces.map(()=>0),neighbors=surface.faces.map(()=>new Set<number>());
  for(const edge of surface.edges)for(const a of edge.faces)for(const b of edge.faces)if(a!==b)neighbors[a].add(b);
  for(const t of surface.triangles){const [a,b,c]=t.vertices.map(v=>surface.points[v].position),n=cross3(sub3(b,a),sub3(c,a)),area=Math.hypot(...n)/2;normals[t.face]=add3(normals[t.face],n);areas[t.face]+=area;centers[t.face]=add3(centers[t.face],mul3(add3(add3(a,b),c),area/3));}
  return Object.freeze(surface.faces.map((f,i)=>Object.freeze({source:surface,index:i,id:f.id,normal:Object.freeze(unit3(normals[i])),center:Object.freeze(mul3(centers[i],1/areas[i])),area:areas[i],attributes:Object.freeze(structuredClone(f.attributes)),adjacent:Object.freeze([...neighbors[i]].sort((a,b)=>a-b))})));
}
export class FaceSelection3 implements Iterable<FaceMeasure3> {
  private readonly measures:readonly FaceMeasure3[];
  readonly indices:readonly number[];
  constructor(readonly source:Surface3,indices:readonly number[]=source.faces.map((_,i)=>i)) {
    if(indices.some(i=>!Number.isInteger(i)||i<0||i>=source.faces.length))throw new Error('invalid face selection index');
    this.indices=Object.freeze([...new Set(indices)].sort((a,b)=>a-b));this.measures=measureFaces3(source);Object.freeze(this);
  }
  *[Symbol.iterator](){for(const i of this.indices)yield this.measures[i];}
  get length(){return this.indices.length;}
  filter(fn:(f:FaceMeasure3)=>boolean){return new FaceSelection3(this.source,this.indices.filter(i=>fn(this.measures[i])));}
  map<T>(fn:(f:FaceMeasure3)=>T):T[]{return this.indices.map(i=>fn(this.measures[i]));}
  groupBy<K>(fn:(f:FaceMeasure3)=>K){return groupRows(this.indices,i=>i,i=>fn(this.measures[i])).map(g=>({key:g.key,selection:new FaceSelection3(this.source,g.rows)}));}
  adjacent(){return new FaceSelection3(this.source,this.indices.flatMap(i=>this.measures[i].adjacent));}
}
export function cloneSurface3(surface:Surface3):Surface3 {return assembleSurface3(surface.points,surface.faces,surface.triangles,surface);}

/** Independent extrusion replaces each selected cap, retaining its old boundary
 * through side faces. Neighboring selected faces are rejected in the MVP so no
 * coincident side walls are silently discarded. Negative distances recess.
 * Zero distances create no topology. Fixed cap triangulations survive folds. */
export function extrudeFaces3(surface:Surface3,selection:FaceSelection3,distance:number|((face:FaceMeasure3)=>number),options:{operation:string;extensiveFaceAttributes?:readonly string[]}):Surface3 {
  if(selection.source!==surface)throw new Error('face selection belongs to another surface state');
  if(!options.operation)throw new Error('extrusion requires a stable operation ID');
  surface=snapshotSurface3(surface);
  const measures=measureFaces3(surface),distances=new Map<number,number>();
  for(const i of selection.indices){const d=typeof distance==='function'?distance(measures[i]):distance;if(!Number.isFinite(d))throw new Error('extrusion distance must be finite');if(d!==0)distances.set(i,d);}
  for(const e of surface.edges)if(e.faces.filter(f=>distances.has(f)).length>1)throw new Error('independent extrusion requires nonadjacent selected faces; select a separated set per pass');
  const points=surface.points.map(p=>({...p,position:[...p.position] as Vec3,attributes:structuredClone(p.attributes)})),faces:SurfaceFace3[]=[],triangles:SurfaceTriangle3[]=[];
  const capPoints=new Map<number,Map<number,number>>(),parents=new Map<number,number>();
  const id=(...parts:(string|number)[])=>JSON.stringify(['extrude',options.operation,...parts]);
  const byFace=surface.faces.map(()=>[] as SurfaceTriangle3[]);surface.triangles.forEach(t=>byFace[t.face].push(t));
  const add=(face:SurfaceFace3,parts:readonly(readonly[number,number,number])[],parent:number)=>{const i=faces.length;faces.push(face);parents.set(i,parent);for(const vertices of parts)triangles.push({face:i,vertices});};
  surface.faces.forEach((f,i)=>{
    const d=distances.get(i);
    if(d===undefined){add({...f},byFace[i].map(t=>t.vertices),i);return;}
    const mapping=new Map<number,number>();capPoints.set(i,mapping);
    for(const v of f.vertices){mapping.set(v,points.length);const p=surface.points[v];points.push({id:id(f.id,'point',p.id),position:add3(p.position,mul3(measures[i].normal,d)),attributes:{...structuredClone(p.attributes),parentPoint:p.id}});}
    add({id:id(f.id,'cap'),vertices:f.vertices.map(v=>mapping.get(v)!),attributes:{...structuredClone(f.attributes),parentFace:f.id,role:'cap'}},byFace[i].map(t=>t.vertices.map(v=>mapping.get(v)!) as [number,number,number]),i);
    f.vertices.forEach((a,j)=>{const b=f.vertices[(j+1)%f.vertices.length],c=mapping.get(b)!,e=mapping.get(a)!;add({id:id(f.id,'side',j),vertices:[a,b,c,e],attributes:{...structuredClone(f.attributes),parentFace:f.id,role:'side'}},[[a,b,c],[a,c,e]],i);});
  });
  const result=assembleSurface3(points,faces,triangles,surface);
  // Copied labels/scalars are intensive by default. Explicit extensive face
  // quantities are distributed by resulting area, conserving each parent's sum.
  if(options.extensiveFaceAttributes?.length){const measured=measureFaces3(result),totals=new Map<number,number>();measured.forEach((f,i)=>{const p=parents.get(i)!;totals.set(p,(totals.get(p)??0)+f.area);});result.faces.forEach((f,i)=>{const p=parents.get(i)!;for(const name of options.extensiveFaceAttributes!){const value=surface.faces[p].attributes[name];if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`extensive face attribute ${name} must be finite numeric`);f.attributes[name]=value*measured[i].area/totals.get(p)!;}});}
  const edgeKey=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`,capEdges=new Map(result.edges.map(e=>[edgeKey(...e.vertices),e]));
  for(const edge of surface.edges)for(const f of edge.faces){const mapping=capPoints.get(f);if(!mapping)continue;const cap=capEdges.get(edgeKey(mapping.get(edge.vertices[0])!,mapping.get(edge.vertices[1])!));if(cap)cap.attributes={...structuredClone(edge.attributes),parentEdge:edge.id};}
  return result;
}

/** Affine modeling edit, explicit world-space pivot and XYZ Euler degrees.
 * Negative determinant reverses polygon and triangle winding consistently. */
export function transformSurface3(surface:Surface3,options:{translate?:Vec3;rotate?:Vec3;scale?:Vec3;origin?:Vec3}):Surface3 {
  const translate=options.translate??[0,0,0],rotate=options.rotate??[0,0,0],scale=options.scale??[1,1,1],origin=options.origin??[0,0,0];[translate,rotate,scale,origin].forEach(finite3);if(scale.some(v=>v===0))throw new Error('surface scale must be nonsingular');
  const points=surface.points.map(p=>{let v=sub3(p.position,origin).map((n,i)=>n*scale[i]) as unknown as Vec3;for(let axis=0;axis<3;axis++){const angle=rotate[axis]*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),a=(axis+1)%3,b=(axis+2)%3,next=[...v];next[a]=c*v[a]-s*v[b];next[b]=s*v[a]+c*v[b];v=next as unknown as Vec3;}return {...p,position:add3(add3(v,origin),translate)};});
  const mirrored=scale[0]*scale[1]*scale[2]<0;
  return assembleSurface3(points,surface.faces.map(f=>({...f,vertices:mirrored?[...f.vertices].reverse():f.vertices})),surface.triangles.map(t=>({...t,vertices:mirrored?[t.vertices[0],t.vertices[2],t.vertices[1]]:t.vertices})),surface);
}

const capturedSurfaces3=new WeakSet<Surface3>();

/** Owned frozen input for one procedural pass; editable results are explicit.
 * Trusted immutable snapshots are reusable across dependent generators. */
export function snapshotSurface3(surface:Surface3):Surface3 {
  if(capturedSurfaces3.has(surface))return surface;
  const snapshot=cloneSurface3(surface);
  const freeze=(value:unknown):void=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
  // Array containers are already frozen by assembly; recurse through rows.
  for(const p of snapshot.points){freeze(p.position);freeze(p.attributes);freeze(p);}for(const f of snapshot.faces){freeze(f.attributes);freeze(f);}for(const e of snapshot.edges){freeze(e.attributes);freeze(e);}
  capturedSurfaces3.add(snapshot);
  return Object.freeze(snapshot);
}
export function stepsSurface3(initial:Surface3,count:number,pass:(input:Surface3,iteration:number)=>Surface3,options:{history?:number}={}):{surface:Surface3;history:readonly Surface3[]} {
  const keep=options.history??0;
  if(!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(keep)||keep<0)throw new Error('step and history counts must be nonnegative integers');
  let current=cloneSurface3(initial);const history:Surface3[]=[];
  for(let i=0;i<count;i++){const input=snapshotSurface3(current);current=cloneSurface3(pass(input,i));if(keep){history.push(snapshotSurface3(current));if(history.length>keep)history.shift();}}
  return {surface:current,history:Object.freeze(history)};
}

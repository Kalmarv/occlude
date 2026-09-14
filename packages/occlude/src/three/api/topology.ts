import {Collection} from './collection.js';
import {Mesh,PointGeometry,CurveGeometry,type PointRow,type EdgeRow,type FaceRow,type CornerRow,type EdgeAttributes} from './mesh.js';
import {assembleSurface3,type Attributes3} from '../geometry/surface.js';
import {measureFaces3} from '../geometry/model.js';
import {topology3,topologyConnected,topologyComponents,type SurfaceTopology3} from '../geometry/topology.js';
import {sub3} from '../math.js';

export type MeshPointRow<P extends Attributes3={},E extends EdgeAttributes={},F extends Attributes3={},C extends Attributes3={}> = PointRow<P>&{
  readonly edges:MeshEdges<P,E,F,C>;readonly faces:MeshFaces<P,E,F,C>;readonly adjacent:MeshPoints<P,E,F,C>;readonly corners:MeshCorners<P,E,F,C>;
};
export type MeshEdgeRow<E extends EdgeAttributes={},P extends Attributes3={},F extends Attributes3={},C extends Attributes3={}> = EdgeRow<E,P>&{
  readonly a:MeshPointRow<P,E,F,C>;readonly b:MeshPointRow<P,E,F,C>;readonly points:MeshPoints<P,E,F,C>;readonly faces:MeshFaces<P,E,F,C>;
};
export type MeshFaceRow<F extends Attributes3={},P extends Attributes3={},E extends EdgeAttributes={},C extends Attributes3={}> = FaceRow<F>&{
  readonly points:MeshPoints<P,E,F,C>;readonly edges:MeshEdges<P,E,F,C>;readonly adjacent:MeshFaces<P,E,F,C>;readonly corners:MeshCorners<P,E,F,C>;
};
export type MeshCornerRow<C extends Attributes3={},P extends Attributes3={},E extends EdgeAttributes={},F extends Attributes3={}> = CornerRow<C>&{
  readonly point:MeshPointRow<P,E,F,C>;readonly face:MeshFaceRow<F,P,E,C>;
};
interface Context<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3> {
  readonly corners:readonly MeshCornerRow<C,P,E,F>[];
  readonly mesh:Mesh<P,E,F,C>;readonly topology:SurfaceTopology3;
  readonly points:readonly MeshPointRow<P,E,F,C>[];readonly edges:readonly MeshEdgeRow<E,P,F,C>[];readonly faces:readonly MeshFaceRow<F,P,E,C>[];
}
const contexts=new WeakMap<object,Context<any,any,any,any>>();
function relations<T>(row:object,getters:Record<string,()=>unknown>):T {
  for(const [name,get] of Object.entries(getters))Object.defineProperty(row,name,{get,enumerable:false});
  return Object.freeze(row) as T;
}
function context<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>):Context<P,E,F,C>{
  const cached=contexts.get(mesh);if(cached)return cached;
  const surface=mesh.surface,topology=topology3(surface);
  const points:readonly MeshPointRow<P,E,F,C>[]=Object.freeze(surface.points.map((p,index)=>relations<MeshPointRow<P,E,F,C>>({...p.attributes,id:p.id,index,x:p.position[0],y:p.position[1],z:p.position[2],attributes:p.attributes,provenance:p.provenance},{
    edges:()=>new MeshEdges(result,topology.pointEdges[index]),faces:()=>new MeshFaces(result,topology.pointFaces[index]),adjacent:()=>new MeshPoints(result,topology.pointNeighbors[index]),corners:()=>new MeshCorners(result,topology.pointCorners[index]),
  })));
  const edges=Object.freeze(surface.edges.map((e,index)=>relations<MeshEdgeRow<E,P,F,C>>({...e.attributes,id:e.id,index,vertices:e.vertices,a:points[e.vertices[0]],b:points[e.vertices[1]],length:Math.hypot(...sub3(surface.points[e.vertices[0]].position,surface.points[e.vertices[1]].position)),attributes:e.attributes,provenance:e.provenance},{
    points:()=>new MeshPoints(result,e.vertices),faces:()=>new MeshFaces(result,e.faces),
  })));
  const faces=Object.freeze(measureFaces3(surface).map((f,index)=>relations<MeshFaceRow<F,P,E,C>>({...surface.faces[index].attributes,id:f.id,index,vertices:surface.faces[index].vertices,normal:f.normal,center:f.center,area:f.area,attributes:surface.faces[index].attributes,provenance:surface.faces[index].provenance},{
    points:()=>new MeshPoints(result,surface.faces[index].vertices),edges:()=>new MeshEdges(result,topology.faceEdges[index]),adjacent:()=>new MeshFaces(result,topology.faceNeighbors[index]),corners:()=>new MeshCorners(result,topology.faceCorners[index]),
  })));
  let cornerIndex=0;
  const corners:readonly MeshCornerRow<C,P,E,F>[]=Object.freeze(surface.faces.flatMap((face,faceIndex)=>face.corners!.map((c,localIndex)=>relations<MeshCornerRow<C,P,E,F>>({...c.attributes,id:c.id,index:cornerIndex++,localIndex,attributes:c.attributes,provenance:c.provenance},{point:()=>points[face.vertices[localIndex]],face:()=>faces[faceIndex]}))));
  const result:Context<P,E,F,C>=Object.freeze({mesh,topology,points,edges,faces,corners});contexts.set(mesh,result);
  // Register every row, including endpoints first reached through relationships.
  new MeshPoints(result);new MeshEdges(result);new MeshFaces(result);new MeshCorners(result);
  return result;
}
const selectionContexts=new WeakMap<object,Context<any,any,any,any>>();
export class MeshPoints<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3={}> extends Collection<MeshPointRow<P,E,F,C>,PointGeometry<P>> {
  constructor(ctx:Context<P,E,F,C>,indices?:readonly number[],key?:unknown){
    super(ctx.mesh.surface,'point',ctx.points,ids=>new PointGeometry<P>(assembleSurface3(ids.map(i=>ctx.mesh.surface.points[i]),[],[])),indices,key);selectionContexts.set(this,ctx);
  }
  private get context():Context<P,E,F,C>{return selectionContexts.get(this)!;}
  protected derive(indices:readonly number[],key:unknown=this.key):this{return new MeshPoints(this.context,indices,key) as this;}
  edges():MeshEdges<P,E,F,C>{return new MeshEdges(this.context,this.indices.flatMap(i=>this.context.topology.pointEdges[i]));}
  faces():MeshFaces<P,E,F,C>{return new MeshFaces(this.context,this.indices.flatMap(i=>this.context.topology.pointFaces[i]));}
  corners():MeshCorners<P,E,F,C>{return new MeshCorners(this.context,this.indices.flatMap(i=>this.context.topology.pointCorners[i]));}
  adjacent():this{return this.derive(this.indices.flatMap(i=>this.context.topology.pointNeighbors[i]));}
  connected():this{return this.derive(topologyConnected(this.indices,this.context.topology.pointNeighbors));}
  components():readonly this[]{return Object.freeze(topologyComponents(this.indices,this.context.topology.pointNeighbors).map(ids=>this.derive(ids)));}
}
export class MeshEdges<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3={}> extends Collection<MeshEdgeRow<E,P,F,C>,CurveGeometry<P,E>> {
  constructor(ctx:Context<P,E,F,C>,indices?:readonly number[],key?:unknown){
    super(ctx.mesh.surface,'edge',ctx.edges,ids=>new CurveGeometry<P,E>(ctx.mesh.surface,ids),indices,key);selectionContexts.set(this,ctx);
  }
  private get context():Context<P,E,F,C>{return selectionContexts.get(this)!;}
  protected derive(indices:readonly number[],key:unknown=this.key):this{return new MeshEdges(this.context,indices,key) as this;}
  points():MeshPoints<P,E,F,C>{return new MeshPoints(this.context,this.indices.flatMap(i=>this.context.mesh.surface.edges[i].vertices));}
  faces():MeshFaces<P,E,F,C>{return new MeshFaces(this.context,this.indices.flatMap(i=>this.context.mesh.surface.edges[i].faces));}
}
export class MeshFaces<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3={}> extends Collection<MeshFaceRow<F,P,E,C>,Mesh<P,E,F,C>> {
  constructor(ctx:Context<P,E,F,C>,indices?:readonly number[],key?:unknown){super(ctx.mesh.surface,'face',ctx.faces,ids=>extractFaces(ctx.mesh,ids),indices,key);selectionContexts.set(this,ctx);}
  private get context():Context<P,E,F,C>{return selectionContexts.get(this)!;}
  protected derive(indices:readonly number[],key:unknown=this.key):this{return new MeshFaces(this.context,indices,key) as this;}
  points():MeshPoints<P,E,F,C>{return new MeshPoints(this.context,this.indices.flatMap(i=>this.context.mesh.surface.faces[i].vertices));}
  edges():MeshEdges<P,E,F,C>{return new MeshEdges(this.context,this.indices.flatMap(i=>this.context.topology.faceEdges[i]));}
  corners():MeshCorners<P,E,F,C>{return new MeshCorners(this.context,this.indices.flatMap(i=>this.context.topology.faceCorners[i]));}
  boundaryEdges():MeshEdges<P,E,F,C>{const selected=new Set(this.indices);return this.edges().filter(e=>e.faces.indices.filter(i=>selected.has(i)).length===1);}
  adjacent():this{return this.derive(this.indices.flatMap(i=>this.context.topology.faceNeighbors[i]));}
  connected():this{return this.derive(topologyConnected(this.indices,this.context.topology.faceNeighbors));}
  components():readonly this[]{return Object.freeze(topologyComponents(this.indices,this.context.topology.faceNeighbors).map(ids=>this.derive(ids)));}
}
export class MeshCorners<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3> extends Collection<MeshCornerRow<C,P,E,F>,readonly MeshCornerRow<C,P,E,F>[]> {
  constructor(ctx:Context<P,E,F,C>,indices?:readonly number[],key?:unknown){super(ctx.mesh.surface,'corner',ctx.corners,ids=>Object.freeze(ids.map(i=>ctx.corners[i])),indices,key);selectionContexts.set(this,ctx);}
  private get context():Context<P,E,F,C>{return selectionContexts.get(this)!;}
  protected derive(indices:readonly number[],key:unknown=this.key):this{return new MeshCorners(this.context,indices,key) as this;}
  points():MeshPoints<P,E,F,C>{return new MeshPoints(this.context,this.map(c=>c.point.index));}
  faces():MeshFaces<P,E,F,C>{return new MeshFaces(this.context,this.map(c=>c.face.index));}
}
function extractFaces<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>,indices:readonly number[]):Mesh<P,E,F,C>{
  const source=mesh.surface,used=[...new Set(indices.flatMap(i=>source.faces[i].vertices))].sort((a,b)=>a-b),mapping=new Map(used.map((v,i)=>[v,i]));
  const faceMap=new Map(indices.map((v,i)=>[v,i]));
  const surface=assembleSurface3(used.map(v=>source.points[v]),indices.map(i=>({...source.faces[i],vertices:source.faces[i].vertices.map(v=>mapping.get(v)!)})),source.triangles.filter(t=>faceMap.has(t.face)).map(t=>({face:faceMap.get(t.face)!,vertices:t.vertices.map(v=>mapping.get(v)!) as [number,number,number]})),source);
  return new Mesh(surface,{transfers:mesh.transfers,cornerTransfers:mesh.cornerTransfers});
}
export function meshPoints<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>):MeshPoints<P,E,F,C>{return new MeshPoints(context(mesh));}
export function meshEdges<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>):MeshEdges<P,E,F,C>{return new MeshEdges(context(mesh));}
export function meshFaces<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>):MeshFaces<P,E,F,C>{return new MeshFaces(context(mesh));}

export function meshCorners<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>):MeshCorners<P,E,F,C>{return new MeshCorners(context(mesh));}

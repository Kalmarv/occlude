import {Table3,kind3,select3,rowOrder,type Where3} from './collection.js';
import type {Field,AttributeFields,SetOptions3,SetManyOptions3,Widen3,Widened3,PointColumns3,PointFields3} from './columns.js';
import {Mesh,PointGeometry,CurveGeometry,writeMesh3,type PointRow,type EdgeRow,type FaceRow,type CornerRow,type EdgeAttributes} from './mesh.js';
import {assembleSurface3,type Attribute3,type Attributes3,type Surface3} from '../geometry/surface.js';
import {faceGeometry3} from '../geometry/model.js';
import {topology3,type SurfaceTopology3} from '../geometry/topology.js';
import {sub3,add3,mul3} from '../math.js';
import {pointsNear3,edgesNear3,place3,pointDistance3,edgeDistance3} from './near3.js';
import type {Vector3} from '../rotation.js';
import {ROW_TYPES,type Selection,type Types} from '../../selection.js';

export type MeshPointRow<P extends Attributes3={},E extends EdgeAttributes={},F extends Attributes3={},C extends Attributes3={}> = PointRow<P>&{
  readonly edges:Selection<MeshEdgeRow<E,P,F,C>>;readonly faces:Selection<MeshFaceRow<F,P,E,C>>;readonly adjacent:Selection<MeshPointRow<P,E,F,C>>;readonly corners:Selection<MeshCornerRow<C,P,E,F>>;
  readonly [ROW_TYPES]?:MeshPointTypes<P,E,F,C>;
};
export type MeshEdgeRow<E extends EdgeAttributes={},P extends Attributes3={},F extends Attributes3={},C extends Attributes3={}> = EdgeRow<E,P>&{
  readonly a:MeshPointRow<P,E,F,C>;readonly b:MeshPointRow<P,E,F,C>;readonly points:Selection<MeshPointRow<P,E,F,C>>;readonly faces:Selection<MeshFaceRow<F,P,E,C>>;
  readonly [ROW_TYPES]?:MeshEdgeTypes<P,E,F,C>;
};
export type MeshFaceRow<F extends Attributes3={},P extends Attributes3={},E extends EdgeAttributes={},C extends Attributes3={}> = FaceRow<F>&{
  readonly points:Selection<MeshPointRow<P,E,F,C>>;readonly edges:Selection<MeshEdgeRow<E,P,F,C>>;readonly adjacent:Selection<MeshFaceRow<F,P,E,C>>;readonly corners:Selection<MeshCornerRow<C,P,E,F>>;
  readonly [ROW_TYPES]?:MeshFaceTypes<P,E,F,C>;
};
export type MeshCornerRow<C extends Attributes3={},P extends Attributes3={},E extends EdgeAttributes={},F extends Attributes3={}> = CornerRow<C>&{
  readonly point:MeshPointRow<P,E,F,C>;readonly face:MeshFaceRow<F,P,E,C>;
  readonly [ROW_TYPES]?:MeshCornerTypes<P,E,F,C>;
};

/** @internal What a selection of mesh points answers (see `ROW_TYPES`). */
export type MeshPointTypes<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3> = Types<{
  source:Surface3;
  points:Selection<MeshPointRow<P,E,F,C>>;edges:Selection<MeshEdgeRow<E,P,F,C>>;faces:Selection<MeshFaceRow<F,P,E,C>>;corners:Selection<MeshCornerRow<C,P,E,F>>;
  extract:()=>PointGeometry<P>;
  /** The mesh with point columns set on these points, or on those `where`
   * names among them: `set(column, value, where?, { transfer? })`, or
   * `set({ column: value, … }, where?, { transfer: { column: policy } })`.
   * `x`, `y` and `z` are the position. `transfer` declares how the column
   * refines (`'interpolate'`, the default, or `'nearest'`). */
  set:{
    <Name extends string,V extends Attribute3>(column:Name,value:Field<MeshPointRow<P,E,F,C>,V>,where?:Where3<MeshPointRow<P,E,F,C>>|SetOptions3,opts?:SetOptions3):Mesh<PointColumns3<P,NoInfer<Name>,NoInfer<V>>,E,F,C>;
    <A extends Attributes3>(values:AttributeFields<MeshPointRow<P,E,F,C>,A>,where?:Where3<MeshPointRow<P,E,F,C>>|SetManyOptions3,opts?:SetManyOptions3):Mesh<PointFields3<P,NoInfer<A>>,E,F,C>;
  };
}>;
/** @internal What a selection of mesh edges answers. Subdivision copies an
 * edge's columns to its two halves, so an edge column has no transfer. */
export type MeshEdgeTypes<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3> = Types<{
  source:Surface3;
  points:Selection<MeshPointRow<P,E,F,C>>;edges:Selection<MeshEdgeRow<E,P,F,C>>;faces:Selection<MeshFaceRow<F,P,E,C>>;
  extract:()=>CurveGeometry<P,E>;
  set:{
    <Name extends string,V extends Attribute3>(column:Name,value:Field<MeshEdgeRow<E,P,F,C>,V>,where?:Where3<MeshEdgeRow<E,P,F,C>>):Mesh<P,Omit<E,NoInfer<Name>>&Record<NoInfer<Name>,Widen3<NoInfer<V>>>,F,C>;
    <A extends Attributes3>(values:AttributeFields<MeshEdgeRow<E,P,F,C>,A>,where?:Where3<MeshEdgeRow<E,P,F,C>>):Mesh<P,Omit<E,keyof NoInfer<A>>&Widened3<NoInfer<A>>,F,C>;
  };
}>;
/** @internal What a selection of mesh faces answers. Child faces inherit
 * their parent's columns, so a face column has no transfer. */
export type MeshFaceTypes<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3> = Types<{
  source:Surface3;
  points:Selection<MeshPointRow<P,E,F,C>>;edges:Selection<MeshEdgeRow<E,P,F,C>>;faces:Selection<MeshFaceRow<F,P,E,C>>;corners:Selection<MeshCornerRow<C,P,E,F>>;
  boundaryEdges:()=>Selection<MeshEdgeRow<E,P,F,C>>;
  extract:()=>Mesh<P,E,F,C>;
  set:{
    <Name extends string,V extends Attribute3>(column:Name,value:Field<MeshFaceRow<F,P,E,C>,V>,where?:Where3<MeshFaceRow<F,P,E,C>>):Mesh<P,E,Omit<F,NoInfer<Name>>&Record<NoInfer<Name>,Widen3<NoInfer<V>>>,C>;
    <A extends Attributes3>(values:AttributeFields<MeshFaceRow<F,P,E,C>,A>,where?:Where3<MeshFaceRow<F,P,E,C>>):Mesh<P,E,Omit<F,keyof NoInfer<A>>&Widened3<NoInfer<A>>,C>;
  };
}>;
/** @internal What a selection of mesh corners answers. A corner's columns
 * are its face's view of the point: `uv`. */
export type MeshCornerTypes<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3> = Types<{
  source:Surface3;
  points:Selection<MeshPointRow<P,E,F,C>>;faces:Selection<MeshFaceRow<F,P,E,C>>;corners:Selection<MeshCornerRow<C,P,E,F>>;
  extract:()=>readonly MeshCornerRow<C,P,E,F>[];
  set:{
    <Name extends string,V extends Attribute3>(column:Name,value:Field<MeshCornerRow<C,P,E,F>,V>,where?:Where3<MeshCornerRow<C,P,E,F>>|SetOptions3,opts?:SetOptions3):Mesh<P,E,F,Omit<C,NoInfer<Name>>&Record<NoInfer<Name>,Widen3<NoInfer<V>>>>;
    <A extends Attributes3>(values:AttributeFields<MeshCornerRow<C,P,E,F>,A>,where?:Where3<MeshCornerRow<C,P,E,F>>|SetManyOptions3,opts?:SetManyOptions3):Mesh<P,E,F,Omit<C,keyof NoInfer<A>>&Widened3<NoInfer<A>>>;
  };
}>;

type AnyRow={readonly id:string;readonly index:number};
/** One mesh revision's rows and relations, built per domain on first use:
 * an attribute edit that only reads faces never pays for point, edge and
 * corner rows of the same revision. */
interface Context {
  readonly mesh:Mesh<any,any,any,any>;readonly topology:SurfaceTopology3;
  readonly points:Table3<AnyRow>;readonly edges:Table3<AnyRow>;readonly faces:Table3<AnyRow>;readonly corners:Table3<AnyRow>;
}
const contexts=new WeakMap<object,Context>();
/** The mesh context of a mesh domain. */
const contextOf=new WeakMap<object,Context>();
/** A face's middle is its `centroid`, the 2D face word; `center` is an
 * edge's midpoint in both worlds. */
const faceCenterRefused=():never=>{throw new Error('a face\'s middle is `centroid` (the 2D face word); `center` is an edge\'s midpoint');};
function relations<T>(row:object,getters:Record<string,()=>unknown>):T {
  for(const [name,get] of Object.entries(getters))Object.defineProperty(row,name,{get,enumerable:false});
  return Object.freeze(row) as T;
}
type Sel3=Selection<any>&{readonly domain:Table3<AnyRow>};
const ctxOf=(sel:Sel3):Context=>contextOf.get(sel.domain)!;
const MESH_POINTS=kind3('point',{
  /** Itself. */
  points:{get(this:Sel3){return this;}},
  /** The edges that meet a member, once each, row order. */
  edges:{get(this:Sel3){const c=ctxOf(this);return select3(c.edges,rowOrder(this.indices.flatMap(i=>c.topology.pointEdges[i])));}},
  /** The faces around a member, once each, row order. */
  faces:{get(this:Sel3){const c=ctxOf(this);return select3(c.faces,rowOrder(this.indices.flatMap(i=>c.topology.pointFaces[i])));}},
  /** The corners at a member, once each, row order. */
  corners:{get(this:Sel3){const c=ctxOf(this);return select3(c.corners,rowOrder(this.indices.flatMap(i=>c.topology.pointCorners[i])));}},
});
const MESH_EDGES=kind3('edge',{
  /** The ends of the members, once each, row order. */
  points:{get(this:Sel3){const c=ctxOf(this);return select3(c.points,rowOrder(this.indices.flatMap(i=>c.mesh.surface.edges[i].vertices)));}},
  /** Itself. */
  edges:{get(this:Sel3){return this;}},
  /** The faces on the members' sides, once each, row order. */
  faces:{get(this:Sel3){const c=ctxOf(this);return select3(c.faces,rowOrder(this.indices.flatMap(i=>c.mesh.surface.edges[i].faces)));}},
});
const MESH_FACES=kind3('face',{
  /** The corners' points of the members, once each, row order. */
  points:{get(this:Sel3){const c=ctxOf(this);return select3(c.points,rowOrder(this.indices.flatMap(i=>c.mesh.surface.faces[i].vertices)));}},
  /** The edges around the members, once each, row order. */
  edges:{get(this:Sel3){const c=ctxOf(this);return select3(c.edges,rowOrder(this.indices.flatMap(i=>c.topology.faceEdges[i])));}},
  /** Itself. */
  faces:{get(this:Sel3){return this;}},
  /** The members' corners, once each, row order. */
  corners:{get(this:Sel3){const c=ctxOf(this);return select3(c.corners,rowOrder(this.indices.flatMap(i=>c.topology.faceCorners[i])));}},
  /** The edges with a selected face on exactly one side: the outline of
   * the selected region, holes and open sheet edges included. */
  boundaryEdges:{value(this:Sel3){
    const c=ctxOf(this),edges=rowOrder(this.indices.flatMap(i=>c.topology.faceEdges[i]));
    return select3(c.edges,edges.filter(e=>c.mesh.surface.edges[e].faces.filter(f=>this.holds(f)).length===1));
  }},
});
const MESH_CORNERS=kind3('corner',{
  /** The points the members sit on, once each, row order. */
  points:{get(this:Sel3){const c=ctxOf(this);return select3(c.points,rowOrder(this.map(r=>(r as MeshCornerRow).point.index)));}},
  /** The faces the members belong to, once each, row order. */
  faces:{get(this:Sel3){const c=ctxOf(this);return select3(c.faces,rowOrder(this.map(r=>(r as MeshCornerRow).face.index)));}},
  /** Itself. */
  corners:{get(this:Sel3){return this;}},
});

function context(mesh:Mesh<any,any,any,any>):Context{
  const cached=contexts.get(mesh);if(cached)return cached;
  const surface=mesh.surface,topology=topology3(surface);
  // Each domain is made on first use; a row first reached through a
  // relationship (an edge's endpoint, a corner's face) builds its domain,
  // so every row knows its source revision and domain.
  const lazy=<T>(build:()=>T):()=>T=>{let value:T|undefined,built=false;return ()=>{if(!built){value=build();built=true;}return value as T;};};
  const domain=(kind:ReturnType<typeof kind3>,name:'point'|'edge'|'face'|'corner',rows:readonly AnyRow[],options:ConstructorParameters<typeof Table3>[4]):Table3<AnyRow>=>{
    const d=new Table3<AnyRow>(kind,surface,name,rows,options);contextOf.set(d,result);return d;
  };
  const points=lazy(()=>{
    const rows:readonly AnyRow[]=Object.freeze(surface.points.map((p,index)=>relations<AnyRow>({...p.attributes,id:p.id,index,x:p.position[0],y:p.position[1],z:p.position[2],attributes:p.attributes,provenance:p.provenance},{
      edges:()=>select3(result.edges,rowOrder(topology.pointEdges[index])),faces:()=>select3(result.faces,rowOrder(topology.pointFaces[index])),
      adjacent:()=>select3(result.points,rowOrder(topology.pointNeighbors[index])),corners:()=>select3(result.corners,rowOrder(topology.pointCorners[index])),
    })));
    return domain(MESH_POINTS,'point',rows,{
      extract:ids=>new PointGeometry(assembleSurface3(ids.map(i=>surface.points[i]),[],[])),
      write:write=>writeMesh3(mesh,'point',write),
      neighbours:r=>topology.pointNeighbors[r],
      // A point of this revision is never its own neighbour; any other
      // place is just a position, and a point under it is found.
      near:(p,radius)=>{
        const q=place3(p as Vector3,'points'),index=(p as {index?:unknown}).index,self=typeof index==='number'&&rows[index]===p?index:-1;
        const found=pointsNear3(surface,q,radius).filter(i=>i!==self);
        return {rows:found,distances:found.map(i=>pointDistance3(surface,q,i))};
      },
    });
  });
  const edges=lazy(()=>{
    const p=points().table as readonly AnyRow[];
    return domain(MESH_EDGES,'edge',Object.freeze(surface.edges.map((e,index)=>relations<AnyRow>({...e.attributes,id:e.id,index,vertices:e.vertices,a:p[e.vertices[0]],b:p[e.vertices[1]],length:Math.hypot(...sub3(surface.points[e.vertices[0]].position,surface.points[e.vertices[1]].position)),center:mul3(add3(surface.points[e.vertices[0]].position,surface.points[e.vertices[1]].position),0.5),attributes:e.attributes,provenance:e.provenance},{
      points:()=>select3(result.points,rowOrder(e.vertices)),faces:()=>select3(result.faces,rowOrder(e.faces)),
    }))),{
      extract:ids=>new CurveGeometry(surface,ids),
      write:write=>writeMesh3(mesh,'edge',write),
      neighbours:r=>topology.edgeNeighbors[r],
      near:(p,radius)=>{const q=place3(p as Vector3,'edges'),rows=edgesNear3(surface,q,radius);return {rows,distances:rows.map(i=>edgeDistance3(surface,q,i))};},
    });
  });
  const faces=lazy(()=>{
    const {normals,centers,areas}=faceGeometry3(surface);
    return domain(MESH_FACES,'face',Object.freeze(surface.faces.map((face,index)=>relations<AnyRow>({...face.attributes,id:face.id,index,vertices:face.vertices,normal:normals[index],centroid:centers[index],area:areas[index],attributes:face.attributes,provenance:face.provenance},{
      center:faceCenterRefused,
      points:()=>select3(result.points,rowOrder(face.vertices)),edges:()=>select3(result.edges,rowOrder(topology.faceEdges[index])),
      adjacent:()=>select3(result.faces,rowOrder(topology.faceNeighbors[index])),corners:()=>select3(result.corners,rowOrder(topology.faceCorners[index])),
    }))),{
      extract:ids=>extractFaces(mesh,ids),
      write:write=>writeMesh3(mesh,'face',write),
      neighbours:r=>topology.faceNeighbors[r],
    });
  });
  const corners=lazy(()=>{
    let cornerIndex=0;
    const rows:readonly AnyRow[]=Object.freeze(surface.faces.flatMap((face,faceIndex)=>face.corners!.map((c,localIndex)=>relations<AnyRow>({...c.attributes,id:c.id,index:cornerIndex++,localIndex,attributes:c.attributes,provenance:c.provenance},{point:()=>points().table[face.vertices[localIndex]],face:()=>faces().table[faceIndex]}))));
    return domain(MESH_CORNERS,'corner',rows,{
      extract:ids=>Object.freeze(ids.map(i=>rows[i])),
      write:write=>writeMesh3(mesh,'corner',write),
    });
  });
  const result:Context=Object.freeze({
    mesh,topology,
    get points(){return points();},get edges(){return edges();},get faces(){return faces();},get corners(){return corners();},
  });
  contexts.set(mesh,result);
  return result;
}
function extractFaces<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>,indices:readonly number[]):Mesh<P,E,F,C>{
  const source=mesh.surface,used=[...new Set(indices.flatMap(i=>source.faces[i].vertices))].sort((a,b)=>a-b),mapping=new Map(used.map((v,i)=>[v,i]));
  const faceMap=new Map(indices.map((v,i)=>[v,i]));
  const surface=assembleSurface3(used.map(v=>source.points[v]),indices.map(i=>({...source.faces[i],vertices:source.faces[i].vertices.map(v=>mapping.get(v)!)})),source.triangles.filter(t=>faceMap.has(t.face)).map(t=>({face:faceMap.get(t.face)!,vertices:t.vertices.map(v=>mapping.get(v)!) as [number,number,number]})),source);
  return new Mesh(surface,{transfers:mesh.transfers,cornerTransfers:mesh.cornerTransfers});
}
export function meshPoints<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>):Selection<MeshPointRow<P,E,F,C>>{return select3(context(mesh).points) as unknown as Selection<MeshPointRow<P,E,F,C>>;}
export function meshEdges<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>):Selection<MeshEdgeRow<E,P,F,C>>{return select3(context(mesh).edges) as unknown as Selection<MeshEdgeRow<E,P,F,C>>;}
export function meshFaces<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>):Selection<MeshFaceRow<F,P,E,C>>{return select3(context(mesh).faces) as unknown as Selection<MeshFaceRow<F,P,E,C>>;}
export function meshCorners<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>):Selection<MeshCornerRow<C,P,E,F>>{return select3(context(mesh).corners) as unknown as Selection<MeshCornerRow<C,P,E,F>>;}

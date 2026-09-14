import {Mesh,evaluate,type EdgeAttributes,type FaceRow,type Field,type PointRow} from './mesh.js';
import {Collection} from './collection.js';
import type {Attributes3,Surface3} from '../geometry/surface.js';
import {prepareSurfaceQueries3,validateRay3,validateNearest3,type RayQuery3,type NearestQuery3,type SurfaceHit3} from '../queries/surface.js';
import type {SurfaceQueryInput3,SurfaceQueryResult3} from '../modeling.js';
import {finite3,sub3,type Vec3} from '../math.js';

export interface Position3 {readonly x:number;readonly y:number;readonly z:number}
export type PointLike3=Vec3|Position3;
export interface SurfaceHit<F extends Attributes3=Attributes3> {
  readonly position:Vec3;readonly normal:Vec3;readonly distance:number;
  readonly triangle:number;readonly barycentric:Vec3;readonly face:FaceRow<F>;
}
export interface RayHit<F extends Attributes3=Attributes3> extends SurfaceHit<F>{readonly t:number}
export interface QueryResult<Row,Hit> {readonly source:Row;readonly hit:Hit|null}
export interface NearestOptions {readonly within?:number}
export interface RayOptions {/** Bounds are ray parameters, not world distances. */readonly near?:number;readonly far?:number}
export interface NearestBatchOptions<P extends Attributes3,R extends PointRow<{}>=PointRow<P>> {readonly position?:Field<R,PointLike3>;readonly within?:Field<R,number>}
export interface RayBatchOptions<P extends Attributes3,R extends PointRow<{}>=PointRow<P>> {readonly origin?:Field<R,PointLike3>;readonly direction:Field<R,Vec3>;readonly near?:Field<R,number>;readonly far?:Field<R,number>}
export interface SegmentBatchOptions<P extends Attributes3,R extends PointRow<{}>=PointRow<P>> {readonly from?:Field<R,PointLike3>;readonly to:Field<R,PointLike3>}
/** The execution toolkit supplies this host; users pass t to prepared.batch(t). */
export interface QueryHost {querySurface3(surface:Surface3,input:SurfaceQueryInput3):Promise<SurfaceQueryResult3>}
export function position3(point:PointLike3):Vec3{const p=Array.isArray(point)?point:[(point as Position3).x,(point as Position3).y,(point as Position3).z];finite3(p as Vec3);return Object.freeze([...p]) as Vec3;}
function rows<R extends PointRow<{}>>(selection:Collection<R,unknown>):readonly R[]{if(!(selection instanceof Collection)||selection.domain!=='point')throw new Error('query batches require a point collection');return Object.freeze([...selection]);}
function results<R,H>(source:readonly R[],hits:readonly(H|null)[]):readonly QueryResult<R,H>[]{if(source.length!==hits.length)throw new Error('query host returned an inconsistent result count');return Object.freeze(source.map((row,i)=>Object.freeze({source:row,hit:hits[i]})));}

interface QueryState<F extends Attributes3>{readonly source:ReturnType<typeof prepareSurfaceQueries3>;readonly faces:readonly FaceRow<F>[]}
const queryStates=new WeakMap<object,QueryState<any>>();
function state<F extends Attributes3>(prepared:PreparedQuery<F>):QueryState<F>{return queryStates.get(prepared)!;}
function hit<F extends Attributes3>(prepared:PreparedQuery<F>,value:SurfaceHit3|null,origin?:Vec3):SurfaceHit<F>|null{
  if(!value)return null;
  return Object.freeze({position:value.point,normal:value.normal,distance:origin?Math.hypot(...sub3(value.point,origin)):value.distance,triangle:value.triangle,barycentric:value.barycentric,face:state(prepared).faces[prepared.target.surface.triangles[value.triangle].face]});
}
function rayHit<F extends Attributes3>(prepared:PreparedQuery<F>,value:SurfaceHit3|null,origin:Vec3):RayHit<F>|null{return value?Object.freeze({...hit(prepared,value,origin)!,t:value.distance}):null;}
function run<F extends Attributes3>(prepared:PreparedQuery<F>,input:SurfaceQueryInput3):SurfaceQueryResult3{const {source}=state(prepared);return {nearest:source.nearest(input.nearest??[]),rays:source.rays(input.rays??[]),segments:source.segments(input.segments??[])};}
function convertNearest<F extends Attributes3>(prepared:PreparedQuery<F>,values:readonly(SurfaceHit3|null)[]):readonly(SurfaceHit<F>|null)[]{return values.map(v=>hit(prepared,v));}
function convertRays<F extends Attributes3>(prepared:PreparedQuery<F>,values:readonly(SurfaceHit3|null)[],origins:readonly Vec3[]):readonly(RayHit<F>|null)[]{if(values.length!==origins.length)throw new Error('query host returned an inconsistent result count');return values.map((v,i)=>rayHit(prepared,v,origins[i]));}

/** One owned target and cached CPU spatial index, shared by scalar and batch queries. */
export class PreparedQuery<F extends Attributes3=Attributes3> {
  constructor(readonly target:Mesh<any,any,F>){if(!(target instanceof Mesh))throw new Error('query requires a mesh target; realize mesh instances explicitly');queryStates.set(this,{source:prepareSurfaceQueries3(target.surface),faces:Object.freeze([...target.faces()])});Object.freeze(this);}
  nearest(point:PointLike3,options:NearestOptions={}):SurfaceHit<F>|null{return hit(this,state(this).source.nearest([{point:position3(point),maxDistance:options.within}])[0]);}
  ray(origin:PointLike3,direction:Vec3,options:RayOptions={}):RayHit<F>|null{const p=position3(origin);return rayHit(this,state(this).source.rays([{origin:p,direction:position3(direction),...options}])[0],p);}
  segment(from:PointLike3,to:PointLike3):RayHit<F>|null{
    const a=position3(from),b=position3(to),direction=sub3(b,a);
    if(direction.every(v=>v===0)){const hit=this.nearest(a,{within:0});return hit?Object.freeze({...hit,t:0}):null;}
    return this.ray(a,direction,{near:0,far:1});
  }
  batch():QueryBatch<F>;
  batch(host:QueryHost):AsyncQueryBatch<F>;
  batch(host?:QueryHost):QueryBatch<F>|AsyncQueryBatch<F>{return host?new AsyncQueryBatch(this,host):new QueryBatch(this);}
}
function nearestInput<R extends PointRow<{}>>(selection:Collection<R,unknown>,options:NearestBatchOptions<R['attributes'],R>){const source=rows(selection),queries=source.map(p=>({point:position3(options.position===undefined?p:evaluate(options.position,p)),maxDistance:options.within===undefined?undefined:evaluate(options.within,p)}));queries.forEach(validateNearest3);return {source,queries};}
function rayInput<R extends PointRow<{}>>(selection:Collection<R,unknown>,options:RayBatchOptions<R['attributes'],R>){const source=rows(selection),queries=source.map(p=>({origin:position3(options.origin===undefined?p:evaluate(options.origin,p)),direction:position3(evaluate(options.direction,p)),near:options.near===undefined?undefined:evaluate(options.near,p),far:options.far===undefined?undefined:evaluate(options.far,p)}));queries.forEach(validateRay3);return {source,queries};}
function segmentInput<R extends PointRow<{}>>(selection:Collection<R,unknown>,options:SegmentBatchOptions<R['attributes'],R>){
  const source=rows(selection),segments:(readonly[Vec3,Vec3])[]=[],nearest:NearestQuery3[]=[],indices:{kind:'segment'|'contact';index:number}[]=[];
  for(const p of source){const a=position3(options.from===undefined?p:evaluate(options.from,p)),b=position3(evaluate(options.to,p));
    if(a.every((v,k)=>v===b[k])){indices.push({kind:'contact',index:nearest.length});nearest.push({point:a,maxDistance:0});}
    else {validateRay3({origin:a,direction:sub3(b,a),near:0,far:1});indices.push({kind:'segment',index:segments.length});segments.push([a,b]);}
  }return {source,segments,nearest,indices};
}
function segmentResults<R extends PointRow<{}>,F extends Attributes3>(prepared:PreparedQuery<F>,input:ReturnType<typeof segmentInput<R>>,out:SurfaceQueryResult3){
  const hits=convertRays(prepared,out.segments,input.segments.map(s=>s[0])),contacts=convertNearest(prepared,out.nearest);
  if(contacts.length!==input.nearest.length)throw new Error('query host returned an inconsistent result count');
  return results(input.source,input.indices.map(({kind,index})=>kind==='segment'?hits[index]:contacts[index]?Object.freeze({...contacts[index]!,t:0}):null));
}
export class QueryBatch<F extends Attributes3> {
  constructor(private readonly prepared:PreparedQuery<F>){Object.freeze(this);}
  nearest<R extends PointRow<{}>>(selection:Collection<R,unknown>,options:NearestBatchOptions<R['attributes'],R>={}):readonly QueryResult<R,SurfaceHit<F>>[]{const input=nearestInput(selection,options);return results(input.source,convertNearest(this.prepared,run(this.prepared,{nearest:input.queries}).nearest));}
  rays<R extends PointRow<{}>>(selection:Collection<R,unknown>,options:RayBatchOptions<R['attributes'],R>):readonly QueryResult<R,RayHit<F>>[]{const input=rayInput(selection,options);return results(input.source,convertRays(this.prepared,run(this.prepared,{rays:input.queries}).rays,input.queries.map(q=>q.origin)));}
  segments<R extends PointRow<{}>>(selection:Collection<R,unknown>,options:SegmentBatchOptions<R['attributes'],R>):readonly QueryResult<R,RayHit<F>>[]{const input=segmentInput(selection,options);return segmentResults(this.prepared,input,run(this.prepared,{segments:input.segments,nearest:input.nearest}));}
}
/** Explicit async boundary: fields are captured before awaiting the execution host. */
export class AsyncQueryBatch<F extends Attributes3> {
  constructor(private readonly prepared:PreparedQuery<F>,private readonly host:QueryHost){if(typeof host.querySurface3!=='function')throw new Error('query batch host must be a sketch execution toolkit');Object.freeze(this);}
  async nearest<R extends PointRow<{}>>(selection:Collection<R,unknown>,options:NearestBatchOptions<R['attributes'],R>={}):Promise<readonly QueryResult<R,SurfaceHit<F>>[]>{const input=nearestInput(selection,options),out=await this.host.querySurface3(this.prepared.target.surface,{nearest:input.queries});return results(input.source,convertNearest(this.prepared,out.nearest));}
  async rays<R extends PointRow<{}>>(selection:Collection<R,unknown>,options:RayBatchOptions<R['attributes'],R>):Promise<readonly QueryResult<R,RayHit<F>>[]>{const input=rayInput(selection,options),out=await this.host.querySurface3(this.prepared.target.surface,{rays:input.queries});return results(input.source,convertRays(this.prepared,out.rays,input.queries.map(q=>q.origin)));}
  async segments<R extends PointRow<{}>>(selection:Collection<R,unknown>,options:SegmentBatchOptions<R['attributes'],R>):Promise<readonly QueryResult<R,RayHit<F>>[]>{const input=segmentInput(selection,options),out=await this.host.querySurface3(this.prepared.target.surface,{segments:input.segments,nearest:input.nearest});return segmentResults(this.prepared,input,out);}
}
export function query<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3>(target:Mesh<P,E,F>):PreparedQuery<F>{return new PreparedQuery(target);}

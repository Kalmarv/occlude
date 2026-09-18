import {orient2d} from 'robust-predicates';
import {add3,cross3,dot3,finite3,mul3,sub3,unit3,type Vec3,type Triangle3} from '../math.js';
import {snapshotSurface3} from '../geometry/model.js';
import type {Surface3} from '../geometry/surface.js';
export interface RayQuery3 {readonly origin:Vec3;readonly direction:Vec3;readonly near?:number;readonly far?:number}
export interface NearestQuery3 {readonly point:Vec3;readonly maxDistance?:number}
export interface SurfaceHit3 {readonly triangle:number;readonly faceId:string;readonly point:Vec3;readonly normal:Vec3;readonly barycentric:Vec3;/** Ray parameter or nearest Euclidean distance. */readonly distance:number}
type Bounds=readonly[number,number,number,number,number,number];
interface Node {bounds:Bounds;left?:Node;right?:Node;indices?:readonly number[]}
const length2=(v:Vec3)=>dot3(v,v);
/** Null on a triangle with no area: a query finds no hit there rather than
 * failing, and the other triangles still answer. */
export function triangleBarycentric3(triangle:Triangle3,p:Vec3):Vec3|null {
  const [a,b,c]=triangle,n=cross3(sub3(b,a),sub3(c,a));let axis=0;for(let k=1;k<3;k++)if(Math.abs(n[k])>Math.abs(n[axis]))axis=k;
  const x=(axis+1)%3,y=(axis+2)%3,orient=(a:Vec3,b:Vec3,c:Vec3)=>orient2d(a[x],a[y],b[x],b[y],c[x],c[y]);
  const denominator=orient(a,b,c);if(denominator===0)return null;
  return [orient(b,c,p)/denominator,orient(c,a,p)/denominator,orient(a,b,p)/denominator];
}
/** Two-sided isolated intersections. Parallel/coplanar rays return no isolated
 * hit; near/far endpoints are inclusive. Direction magnitude defines t units. */
export function rayTriangle3(triangle:Triangle3,query:RayQuery3):{point:Vec3;barycentric:Vec3;distance:number}|null {
  const [a,b,c]=triangle,n=cross3(sub3(b,a),sub3(c,a)),den=dot3(n,query.direction);
  if(den===0)return null;const t=dot3(n,sub3(a,query.origin))/den;
  if(t<(query.near??0)||t>(query.far??Infinity))return null;
  const point=add3(query.origin,mul3(query.direction,t)),barycentric=triangleBarycentric3(triangle,point);
  return barycentric&&barycentric.every(v=>v>=0)?{point,barycentric,distance:t}:null;
}
/** Project to the plane if inside; otherwise minimize over all three edges. */
export function nearestTriangle3(triangle:Triangle3,p:Vec3):{point:Vec3;barycentric:Vec3;distance:number} {
  // A triangle with no plane is measured along its edges alone.
  const [a,b,c]=triangle,n=cross3(sub3(b,a),sub3(c,a)),nn=length2(n);
  const projected=nn>0&&Number.isFinite(nn)?sub3(p,mul3(n,dot3(n,sub3(p,a))/nn)):undefined;
  const barycentric=projected&&triangleBarycentric3(triangle,projected);
  if(projected&&barycentric&&barycentric.every(v=>v>=0))return {point:projected,barycentric,distance:Math.hypot(...sub3(p,projected))};
  let best:{point:Vec3;barycentric:Vec3;distance:number}|null=null;
  for(let i=0;i<3;i++){const a=triangle[i],b=triangle[(i+1)%3],d=sub3(b,a),t=Math.max(0,Math.min(1,dot3(sub3(p,a),d)/length2(d))),point=add3(a,mul3(d,t)),distance=Math.hypot(...sub3(p,point));if(!best||distance<best.distance){const weights=[0,0,0];weights[i]=1-t;weights[(i+1)%3]=t;best={point,barycentric:weights as unknown as Vec3,distance};}}
  return best!;
}
const boxDistance=(b:Bounds,p:Vec3)=>Math.hypot(...p.map((v,k)=>Math.max(b[k]-v,0,v-b[k+3])));
function rayBox(b:Bounds,q:RayQuery3,limit:number):boolean {let lo=q.near??0,hi=Math.min(q.far??Infinity,limit);for(let k=0;k<3;k++){if(q.direction[k]===0){if(q.origin[k]<b[k]||q.origin[k]>b[k+3])return false;continue;}const a=(b[k]-q.origin[k])/q.direction[k],c=(b[k+3]-q.origin[k])/q.direction[k];lo=Math.max(lo,Math.min(a,c));hi=Math.min(hi,Math.max(a,c));if(lo>hi)return false;}return true;}
export function validateRay3(q:RayQuery3):void {finite3(q.origin);finite3(q.direction);if((Math.hypot(...q.direction)===0||!Number.isFinite(Math.hypot(...q.direction)))||!Number.isFinite(q.near??0)||(q.near??0)<0||Number.isNaN(q.far??Infinity)||(q.far??Infinity)<(q.near??0))throw new Error('ray requires a nonzero direction and 0 <= near <= far');}
export function validateNearest3(q:NearestQuery3):void {finite3(q.point);if(Number.isNaN(q.maxDistance??Infinity)||(q.maxDistance??Infinity)<0)throw new Error('nearest maximum distance must be nonnegative');}
/** Prepared owned world-space geometry and deterministic median BVH. Batches
 * reuse one snapshot; ties choose the lowest triangle row in that snapshot. */
export class SurfaceQueries3 {
  readonly surface:Surface3;
  readonly triangles:readonly Triangle3[];
  private readonly root:Node|null;
  constructor(surface:Surface3){
    this.surface=snapshotSurface3(surface);this.triangles=Object.freeze(this.surface.triangles.map(t=>Object.freeze(t.vertices.map(v=>this.surface.points[v].position)) as unknown as Triangle3));
    const bounds=this.triangles.map(tri=>{const b=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];for(const p of tri)for(let k=0;k<3;k++){b[k]=Math.min(b[k],p[k]);b[k+3]=Math.max(b[k+3],p[k]);}const e=Math.max(1,...b.map(Math.abs))*Number.EPSILON*64;for(let k=0;k<3;k++){b[k]-=e;b[k+3]+=e;}unit3(cross3(sub3(tri[1],tri[0]),sub3(tri[2],tri[0])));return b as unknown as Bounds;});
    const build=(indices:number[]):Node=>{const b=[Infinity,Infinity,Infinity,-Infinity,-Infinity,-Infinity];for(const i of indices)for(let k=0;k<3;k++){b[k]=Math.min(b[k],bounds[i][k]);b[k+3]=Math.max(b[k+3],bounds[i][k+3]);}if(indices.length<=8)return {bounds:b as unknown as Bounds,indices};let axis=0;for(let k=1;k<3;k++)if(b[k+3]-b[k]>b[axis+3]-b[axis])axis=k;indices.sort((a,c)=>(bounds[a][axis]/2+bounds[a][axis+3]/2)-(bounds[c][axis]/2+bounds[c][axis+3]/2)||a-c);const half=Math.floor(indices.length/2);return {bounds:b as unknown as Bounds,left:build(indices.slice(0,half)),right:build(indices.slice(half))};};
    this.root=bounds.length?build(bounds.map((_,i)=>i)):null;
  }
  hit(triangle:number,data:{point:Vec3;barycentric:Vec3;distance:number}):SurfaceHit3 {finite3(data.point);finite3(data.barycentric);if(!Number.isFinite(data.distance))throw new Error('surface query result exceeds finite coordinate range');const t=this.triangles[triangle];return Object.freeze({...data,point:Object.freeze([...data.point]) as Vec3,barycentric:Object.freeze([...data.barycentric]) as Vec3,triangle,faceId:this.surface.faces[this.surface.triangles[triangle].face].id,normal:Object.freeze(unit3(cross3(sub3(t[1],t[0]),sub3(t[2],t[0]))))});}
  rays(queries:readonly RayQuery3[],signal?:AbortSignal):readonly(SurfaceHit3|null)[]{return queries.map(q=>{signal?.throwIfAborted();validateRay3(q);let best:SurfaceHit3|null=null;const stack=this.root?[this.root]:[];while(stack.length){const node=stack.pop()!;if(!rayBox(node.bounds,q,best?.distance??Infinity))continue;if(node.indices){for(const i of node.indices){const hit=rayTriangle3(this.triangles[i],q);if(hit&&(!best||hit.distance<best.distance||hit.distance===best.distance&&i<best.triangle))best=this.hit(i,hit);}}else stack.push(node.right!,node.left!);}return best;});}
  segments(segments:readonly(readonly[Vec3,Vec3])[],signal?:AbortSignal):readonly(SurfaceHit3|null)[]{return this.rays(segments.map(([a,b])=>({origin:a,direction:sub3(b,a),near:0,far:1})),signal);}
  nearest(queries:readonly NearestQuery3[],signal?:AbortSignal):readonly(SurfaceHit3|null)[]{return queries.map(q=>{signal?.throwIfAborted();validateNearest3(q);let best:SurfaceHit3|null=null;const stack=this.root?[this.root]:[];while(stack.length){const node=stack.pop()!;if(boxDistance(node.bounds,q.point)>(best?.distance??q.maxDistance??Infinity))continue;if(node.indices){for(const i of node.indices){const hit=nearestTriangle3(this.triangles[i],q.point);if(hit.distance<=(q.maxDistance??Infinity)&&(!best||hit.distance<best.distance||hit.distance===best.distance&&i<best.triangle))best=this.hit(i,hit);}}else {const a=node.left!,b=node.right!;if(boxDistance(a.bounds,q.point)<=boxDistance(b.bounds,q.point))stack.push(b,a);else stack.push(a,b);}}return best;});}
}

const preparedSurfaces=new WeakMap<Surface3,SurfaceQueries3>();
/** Reuse the index only for the same owned revision. Mutable inputs are
 * snapshotted before lookup, so a later edit never reuses a stale index. */
export function prepareSurfaceQueries3(surface:Surface3):SurfaceQueries3 {
  const owned=snapshotSurface3(surface);let prepared=preparedSurfaces.get(owned);
  if(!prepared){prepared=new SurfaceQueries3(owned);preparedSurfaces.set(owned,prepared);}return prepared;
}

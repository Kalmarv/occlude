import {checkSampling} from '../../material.js';
import {surface3,type Attributes3,type Attribute3,type Surface3,type SurfacePoint3} from '../geometry/surface.js';
import {sub3,type Vec3} from '../math.js';
import {curvePath} from './curveTopology.js';
import type {CurveGeometry} from './mesh.js';

/** The whole length of a curve, every edge once, in world units. */
export function curveLength(surface:Surface3):number {
  let total=0;
  for(const e of surface.edges)total+=Math.hypot(...sub3(surface.points[e.vertices[0]].position,surface.points[e.vertices[1]].position));
  return total;
}
const unit=(v:Vec3):Vec3=>{const l=Math.hypot(...v);return l>0?[v[0]/l,v[1]/l,v[2]/l]:[0,0,0];};
function mix(a:Attributes3,b:Attributes3,t:number):Attributes3 {
  const out:Record<string,Attribute3>={};
  for(const name of Object.keys(a)){
    const x=a[name],y=b[name];
    out[name]=typeof x==='number'&&typeof y==='number'?x+(y-x)*t:t<0.5||y===undefined?x:y;
  }
  return out;
}
/** One place on a curve: where it is, the edge under it, and the columns
 * `along` gives it. */
interface Place {readonly position:Vec3;readonly edge:string;readonly attributes:Attributes3}
/** Places along one unbranched curve: `count` of them including both ends
 * of an open curve (no duplicate seam on a closed one), or the count that
 * best fits `spacing` — the rules the 2D `along` keeps. Each has `s`, `u`
 * and the unit `tangent` (on a vertex, the mean of the two segments that
 * meet there), and the point columns, numbers interpolated linearly and
 * the rest from the nearer end. */
function places(curve:CurveGeometry<any,any>,opts:{readonly count?:number;readonly spacing?:number},who:string):{readonly places:readonly Place[];readonly closed:boolean} {
  if(!checkSampling(who,opts))return {places:[],closed:false};
  let path;
  try{path=curvePath(curve);}catch{throw new Error(`${who}: a curve with branches has no one arc length — walk each piece (curve.edges.components())`);}
  const {points,edges}=curve.surface,ids=path.points,n=ids.length;
  if(n===0)return {places:[],closed:false};
  const segs=path.closed?n:n-1,cum=[0];
  for(let i=0;i<segs;i++)cum.push(cum[i]+Math.hypot(...sub3(points[ids[(i+1)%n]].position,points[ids[i]].position)));
  const total=cum[segs];
  const at=(seg:number,t:number,d:number):Place=>{
    const a=points[ids[seg]],b=points[ids[(seg+1)%n]],p=a.position,q=b.position,dir=unit(sub3(q,p));
    // On a vertex, the mean of the segments that meet there.
    const onEnd=t===0&&(seg>0||path.closed)?unit(sub3(p,points[ids[(seg+n-1)%n]].position)):undefined;
    const tangent=onEnd?unit([dir[0]+onEnd[0],dir[1]+onEnd[1],dir[2]+onEnd[2]]):dir;
    const edge=path.edges[Math.min(seg,path.edges.length-1)];
    return {position:[p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t,p[2]+(q[2]-p[2])*t],edge:edges[edge]?.id??'',attributes:{...mix(a.attributes,b.attributes,t),s:d,u:total>0?d/total:0,tangent:[...tangent]}};
  };
  if(!(total>0)||segs<1)return {places:[at(0,0,0)],closed:path.closed};
  const count=opts.count!==undefined?Math.max(path.closed?3:2,opts.count):(path.closed?Math.max(3,Math.round(total/opts.spacing!)):Math.max(1,Math.round(total/opts.spacing!))+1);
  const gaps=path.closed?count:count-1,out:Place[]=[];
  let seg=0;
  for(let k=0;k<count;k++){
    const d=total*k/gaps;
    while(seg<segs-1&&cum[seg+1]<d)seg++;
    const len=cum[seg+1]-cum[seg];
    out.push(at(seg,len>0?Math.min(1,(d-cum[seg])/len):0,d));
  }
  return {places:out,closed:path.closed};
}
/** The points `curve.along` answers, as a surface of points alone: ids
 * `p0`, `p1`, … in walk order, each point's lineage the edge under it. */
export function alongSurface(curve:CurveGeometry<any,any>,opts:{readonly count?:number;readonly spacing?:number}):Surface3 {
  const walked=places(curve,opts,'along').places,base=surface3(walked.map(w=>w.position),[]);
  return {...base,points:base.points.map((p,i):SurfacePoint3=>({...p,attributes:Object.freeze(walked[i].attributes),provenance:{operation:'along',parents:[walked[i].edge]}}))};
}
/** The curve through its own places: the same path redistributed by arc
 * length, columns carried as `along` carries them, each point's lineage the
 * edge under it. */
export function resampledSurface(curve:CurveGeometry<any,any>,opts:{readonly count?:number;readonly spacing?:number}):Surface3 {
  const walked=places(curve,opts,'resample'),closed=walked.closed;
  const points=walked.places.map((w,i)=>{
    const {s:_s,u:_u,tangent:_t,...attributes}=w.attributes;
    return {id:JSON.stringify(['resample',curve.surface.points[0]?.id??'curve',i]),position:w.position,attributes:Object.freeze(attributes),provenance:{operation:'resample',parents:[w.edge]}};
  });
  const n=points.length,segments=closed?n:n-1;
  const edges=n<2?[]:Array.from({length:segments},(_,i)=>({id:`e:p${i}:p${(i+1)%n}`,vertices:[i,(i+1)%n] as [number,number],faces:[] as number[],attributes:{}}));
  return {points,edges,faces:[],triangles:[]} as unknown as Surface3;
}

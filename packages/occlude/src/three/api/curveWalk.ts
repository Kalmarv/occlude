import {checkSampling} from '../../material.js';
import {Column,kinds,kindOf,type AnyColumn} from '../../column.js';
import {finite3,sub3,type Vec3} from '../math.js';
import {meshPath} from './curveTopology.js';
import {pointsMade3} from './mesh.js';
import {kernelColumn,type Lineage3,type Made3,type Mesh3} from '../geometry/mesh3.js';

type Lineage=NonNullable<Lineage3['points']>;
/** The columns a walk writes, which a resampled curve does not keep. */
const WALK:ReadonlySet<string>=new Set(['s','u','tangent']);

const unit=(v:Vec3):Vec3=>{const l=Math.hypot(...v);return l>0?[v[0]/l,v[1]/l,v[2]/l]:[0,0,0];};
/** One place on a curve: where it is, the edge under it, the two points of
 * the segment it lies on and how far along it (`t`), its arc length `s`
 * and parameter `u`, and the unit `tangent`. */
interface Place {readonly position:Vec3;readonly edge:string;readonly a:number;readonly b:number;readonly t:number;readonly s:number;readonly u:number;readonly tangent:Vec3}
/** Places along one unbranched curve: `count` of them including both ends
 * of an open curve (no duplicate seam on a closed one), or the count that
 * best fits `spacing` — the rules the 2D `along` keeps. Each has `s`, `u`
 * and the unit `tangent` (on a vertex, the mean of the two segments that
 * meet there). */
function places(curve:Mesh3,opts:{readonly count?:number;readonly spacing?:number},who:string):{readonly places:readonly Place[];readonly closed:boolean} {
  if(!checkSampling(who,opts))return {places:[],closed:false};
  let path;
  try{path=meshPath(curve);}catch{throw new Error(`${who}: a curve with branches has no one arc length — walk each piece (curve.edges.components())`);}
  const ids=path.points,n=ids.length,position=(i:number):Vec3=>curve.position(i);
  if(n===0)return {places:[],closed:false};
  const segs=path.closed?n:n-1,cum=[0];
  for(let i=0;i<segs;i++)cum.push(cum[i]+Math.hypot(...sub3(position(ids[(i+1)%n]),position(ids[i]))));
  const total=cum[segs];
  const at=(seg:number,t:number,d:number):Place=>{
    const a=ids[seg],b=ids[(seg+1)%n],p=position(a),q=position(b),dir=unit(sub3(q,p));
    // On a vertex, the mean of the segments that meet there.
    const onEnd=t===0&&(seg>0||path.closed)?unit(sub3(p,position(ids[(seg+n-1)%n]))):undefined;
    const tangent=onEnd?unit([dir[0]+onEnd[0],dir[1]+onEnd[1],dir[2]+onEnd[2]]):dir;
    const edge=path.edges[Math.min(seg,path.edges.length-1)];
    return {position:[p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t,p[2]+(q[2]-p[2])*t],edge:edge===undefined?'':curve.names.edges[edge],a,b,t,s:d,u:total>0?d/total:0,tangent};
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
/** The curve's point columns at each place (but those `skip` names): a
 * number interpolated between the segment's two points, any other value
 * from the nearer one. */
function carried(curve:Mesh3,walked:readonly Place[],skip?:ReadonlySet<string>):Record<string,AnyColumn> {
  const out:Record<string,AnyColumn>={},cols=curve.cols.points;
  for(const name in cols){
    const column=cols[name];
    if(!kernelColumn(column)||skip?.has(name))continue;
    if(column instanceof Column){
      const flat=column.flat() as Float64Array;
      out[name]=Column.of(Float64Array.from(walked,w=>{const x=flat[w.a],y=flat[w.b];return x+(y-x)*w.t;}));
    }else{
      const kind=kindOf(column) as {from(values:ArrayLike<unknown>):AnyColumn};
      out[name]=kind.from(walked.map(w=>column.get(w.t<0.5?w.a:w.b)));
    }
  }
  return out;
}
const lineageOf=(operation:string,walked:readonly Place[]):Lineage=>walked.map(w=>({operation,parents:[w.edge]}));
/** The points `curve.along` answers, points alone: named `p0`, `p1`, … in
 * walk order, with the curve's point columns carried and `s`, `u` and
 * `tangent`, each point's lineage the edge under it. */
export function alongSurface(curve:Mesh3,opts:{readonly count?:number;readonly spacing?:number}):Made3 {
  const walked=places(curve,opts,'along').places;
  walked.forEach(w=>finite3(w.position,'mesh'));
  const cols=carried(curve,walked);
  cols.s=Column.of(Float64Array.from(walked,w=>w.s));
  cols.u=Column.of(Float64Array.from(walked,w=>w.u));
  cols.tangent=kinds.vector(3).from(walked.map(w=>w.tangent));
  return pointsMade3(walked.map(w=>w.position),walked.map((_,i)=>`p${i}`),cols,lineageOf('along',walked));
}
/** The curve through its own places: the same path redistributed by arc
 * length, columns carried as `along` carries them, each point's lineage the
 * edge under it. */
export function resampledSurface(curve:Mesh3,opts:{readonly count?:number;readonly spacing?:number}):Made3 {
  const walked=places(curve,opts,'resample'),closed=walked.closed,n=walked.places.length;
  // The walk's own columns are not the resampled curve's.
  const cols=carried(curve,walked.places,WALK);
  const from=curve.names.points[0]??'curve',segments=n<2?0:closed?n:n-1;
  const edges=Array.from({length:segments},(_,i)=>[i,(i+1)%n]);
  const points=pointsMade3(walked.places.map(w=>w.position),walked.places.map((_,i)=>JSON.stringify(['resample',from,i])),cols,lineageOf('resample',walked.places));
  return {...points,names:{...points.names,edges:edges.map(([a,b])=>`e:p${a}:p${b}`)},edges:Uint32Array.from(edges.flat())};
}

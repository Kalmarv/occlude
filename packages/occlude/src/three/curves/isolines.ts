import type {Surface3} from '../geometry/surface.js';
import {snapshotSurface3} from '../geometry/model.js';
import {triangleCorners3} from '../geometry/corners.js';
import {integerWeights,weightedPoint,encodePoint,pointNumber,type H} from '../geometry/exact.js';
import {surfaceBinding3,bindingTriangle3,surfaceCurveNetwork3,type SurfaceCurveNetworkInput3,type SurfaceCurveBudget3,type SurfaceCurveNetwork3} from './network.js';
import {identity} from '../api/identity.js';

/** Scalar isolines of the piecewise-linear interpolant of per-corner values on
 * the represented triangles. Nothing here is exact about the field: the level
 * crossing parameter is binary64, but the crossing POINT is then constructed
 * exactly on the represented triangle edge, so incidence to both triangles
 * sharing that edge is exact. Half-open convention: a corner whose value
 * equals the level counts as above it, so a level through a vertex yields the
 * vertex itself as a node (no zero-length pieces are emitted). Two triangles
 * share a crossing node only when their corner values agree along the edge; a
 * seam (different corner values at one vertex) keeps its nodes separate. */
export interface IsolineLevels3 {readonly levels:readonly number[]}
export interface IsolineOptions3 {readonly key?:string;readonly maxSegments?:number;readonly maxNodes?:number;readonly budget?:SurfaceCurveBudget3}
export interface IsolineResult3 {readonly network:SurfaceCurveNetwork3;readonly stats:{readonly crossings:number;readonly segments:number;readonly chains:number;readonly nodes:number}}
const nextUp=(x:number)=>{const y=x+Number.EPSILON*Math.max(1,Math.abs(x));return y>x?y:x+Number.MIN_VALUE;};
function positiveBudget(value:number|undefined,fallback:number,name:string):number {
  const n=value??fallback;if(!(n===Infinity||Number.isSafeInteger(n))||n<0)throw new Error(`isolines ${name} budget must be a nonnegative integer or Infinity`);return n;
}
/** `values` holds one number per corner in face order, then polygon order. */
export function isolines3(input:Surface3,values:ArrayLike<number>,levels:readonly number[],options:IsolineOptions3={}):IsolineResult3 {
  const surface=snapshotSurface3(input),binding=surfaceBinding3(surface),key=options.key??'isolines';
  const maxSegments=positiveBudget(options.maxSegments,250000,'segment'),maxNodes=positiveBudget(options.maxNodes,250000,'node');
  // A level that is not a number draws no contour, and its neighbours keep
  // their own level index; no levels at all leaves the network empty rather
  // than breaking the sketch.
  const offsets:number[]=[];let total=0;for(const face of surface.faces){offsets.push(total);total+=face.vertices.length;}
  if(values.length!==total)throw new Error('isolines require one value per corner');
  // A corner the field could not answer skips the triangles that touch it.

  const nodes:SurfaceCurveNetworkInput3['nodes'][number][]=[],nodeIds=new Map<string,string>(),positions=new Map<string,readonly [number,number,number]>();
  const segments:{id:string;a:string;b:string;wa:readonly bigint[];wb:readonly bigint[];triangle:number;length:number;index:number;level:number}[]=[];
  // The two triangles that share an edge compute the same crossing: the same
  // ordered vertex pair and, when their corner values agree there, the same
  // binary64 parameter, so the weighted point is the same exact point built
  // twice. Its canonicalization is the isolines' largest exact cost, so the
  // point is built once and the second triangle is handed the same value.
  const crossings=new Map<string,H>();
  const stats={crossings:0,segments:0,chains:0,nodes:0};
  const node=(li:number,slots:readonly number[],valuesKey:string,point:H):string=>{
    const k=JSON.stringify([li,slots,valuesKey,encodePoint(point)]);const previous=nodeIds.get(k);if(previous)return previous;
    if(nodes.length>=maxNodes)throw new Error('isolines exceed node budget');
    const id=identity('isoline-node',key,k);nodeIds.set(k,id);nodes.push({id,point});positions.set(id,pointNumber(point));return id;
  };
  levels.forEach((level,li)=>{
    if(!Number.isFinite(level))return;
    for(let ti=0;ti<surface.triangles.length;ti++){
      const t=surface.triangles[ti],corners=triangleCorners3(surface,ti),f=corners.map(c=>values[offsets[t.face]+c]);
      if(!f.every(Number.isFinite))continue;
      const above=f.map(v=>v>=level);
      if(above.every(Boolean)||!above.some(Boolean))continue;
      const world=bindingTriangle3(binding,ti),ends:string[]=[],endWeights:(readonly bigint[])[]=[];
      for(let e=0;e<3;e++){
        const i=e,j=(e+1)%3;if(above[i]===above[j])continue;
        const [lo,hi]=above[j]?[i,j]:[j,i],s=(level-f[lo])/(f[hi]-f[lo]);
        stats.crossings++;
        const w=integerWeights([1-s,s]),weights=[0n,0n,0n];weights[lo]=w[0];weights[hi]=w[1];
        // The key names the ordered world vertices and the parameter, which is
        // everything the affine combination reads; `s` is a finite binary64 in
        // (0, 1], so its decimal form names one double and no other.
        const ck=`${t.vertices[lo]},${t.vertices[hi]},${s}`;
        let point=crossings.get(ck);
        if(!point){point=weightedPoint(world,weights);crossings.set(ck,point);}
        const vertex=s>=1?t.vertices[hi]:undefined;
        ends.push(vertex!==undefined?node(li,[vertex],String(f[hi]),point):node(li,[t.vertices[lo],t.vertices[hi]].sort((a,b)=>a-b),JSON.stringify(t.vertices[lo]<t.vertices[hi]?[f[lo],f[hi]]:[f[hi],f[lo]]),point));
        endWeights.push(weights);
      }
      if(ends.length!==2||ends[0]===ends[1])continue;
      if(segments.length>=maxSegments)throw new Error('isolines exceed segment budget');
      const [pa,pb]=[positions.get(ends[0])!,positions.get(ends[1])!],length=Math.hypot(pa[0]-pb[0],pa[1]-pb[1],pa[2]-pb[2]);
      segments.push({id:identity('isoline-segment',key,li,ti,ends),a:ends[0],b:ends[1],wa:endWeights[0],wb:endWeights[1],triangle:ti,length,index:li,level});
    }
  });
  // Chain by shared nodes per level: open chains start at degree != 2 nodes,
  // leftovers are closed loops. Range is cumulative length fraction.
  const rows:SurfaceCurveNetworkInput3['segments'][number][]=[];
  const byLevel=new Map<number,number[]>();segments.forEach((s,i)=>{const list=byLevel.get(s.index)??[];list.push(i);byLevel.set(s.index,list);});
  for(const [li,list] of byLevel){
    const incident=new Map<string,number[]>();for(const i of list)for(const n of [segments[i].a,segments[i].b]){const l=incident.get(n)??[];l.push(i);incident.set(n,l);}
    const used=new Set<number>();let ordinal=0;
    const walk=(start:number,from:string)=>{
      const chain:{segment:number;forward:boolean}[]=[];let current=start,at=from;
      while(!used.has(current)){
        used.add(current);const s=segments[current],forward=s.a===at,next=forward?s.b:s.a;chain.push({segment:current,forward});
        const candidates=(incident.get(next)??[]).filter(i=>!used.has(i));
        if(candidates.length!==1||(incident.get(next)??[]).length!==2)break;
        current=candidates[0];at=next;
      }
      return chain;
    };
    const emit=(chain:{segment:number;forward:boolean}[])=>{
      const chainId=identity('isoline-chain',key,li,ordinal++),total=chain.reduce((sum,c)=>sum+segments[c.segment].length,0);
      let cursor=0,previous=0;stats.chains++;
      for(const c of chain){
        const s=segments[c.segment];const lo=Math.max(cursor/total,previous),hi=Math.max((cursor+s.length)/total,nextUp(lo));cursor+=s.length;
        // The producer already holds each end's integer weights on this
        // triangle — the same affine combination that built the point — so the
        // network verifies them with multiplications instead of solving the
        // barycentric system again. `a`/`b` follow the chain's direction.
        rows.push({id:s.id,kind:'isoline',a:c.forward?s.a:s.b,b:c.forward?s.b:s.a,chainId,range:[lo,Math.min(1,hi)>lo?Math.min(1,hi):hi],supports:[{source:0,triangle:s.triangle,a:c.forward?s.wa:s.wb,b:c.forward?s.wb:s.wa}],attributes:{level:s.level,levelIndex:s.index}});
        previous=hi;
      }
    };
    for(const i of list){if(used.has(i))continue;const s=segments[i];const start=[s.a,s.b].find(n=>(incident.get(n)??[]).length!==2);if(start!==undefined)emit(walk(i,start));}
    for(const i of list){if(used.has(i))continue;emit(walk(i,segments[i].a));}
  }
  const network=surfaceCurveNetwork3({sources:[{id:'surface',binding}],nodes,segments:rows},options.budget);
  stats.segments=network.segments.length;stats.nodes=network.nodes.length;
  return {network,stats:Object.freeze(stats)};
}

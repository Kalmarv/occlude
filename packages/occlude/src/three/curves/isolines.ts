import type {Surface3} from '../geometry/surface.js';
import {snapshotSurface3} from '../geometry/model.js';
import {triangleCorners3} from '../geometry/corners.js';
import {integerWeights,weightedPoint,encodePoint,pointNumber,type H} from '../geometry/exact.js';
import {surfaceBinding3,bindingTriangle3,surfaceCurveNetwork3,selectSurfaceCurveNetwork3,type SurfaceCurveNetworkInput3,type SurfaceCurveBudget3,type SurfaceCurveNetwork3} from './network.js';
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
/** What a lazy run skipped and what it still had to build. Present only when
 * a `hidden` predicate was given. */
export interface IsolineLazyStats3 {
  /** (level, triangle) crossings the predicate certified and this run deferred. */
  readonly deferred:number;
  /** Certified crossings built anyway: a corner value equals the level, so the
   * tie/plateau conventions own the record and laziness does not apply. */
  readonly excludedTies:number;
  /** Exact crossing points built for ink. */
  readonly points:number;
  /** Exact crossing points built only to keep a mixed chain's arc-length
   * phase — the report's §3.3 obstruction, measured. */
  readonly phasePoints:number;
  /** Hidden records kept as reference geometry: emitted into the reference
   * network, never into the classified one. */
  readonly referenceRecords:number;
  /** Logical chains with no surviving visible record. */
  readonly hiddenChains:number;
  /** Logical chains holding both deferred and emitted records. */
  readonly mixedChains:number;
}
export interface IsolineOptions3 {
  readonly key?:string;readonly maxSegments?:number;readonly maxNodes?:number;readonly budget?:SurfaceCurveBudget3;
  /** Opt-in laziness: a (level, triangle) this predicate certifies hidden
   * EVERYWHERE keeps its topology — the same crossing decisions, the same
   * ports, the same chains and the same order — and skips its coordinates.
   * The result's `segments` are the records that survive; its `reference` is
   * the whole of every chain that has a survivor, hidden records included, so
   * a consumer that measures a chain's arc length — the stroke stage's
   * reference polyline, and the dash phase and jitter that ride on it — sees
   * exactly what full construction gave it. A chain nothing survives in emits
   * nothing at all, reference and all, because no consumer can ask for it.
   * The caller owes the certificate: an uncertified pair must answer false.
   * Absent, this kernel is exactly what it was. */
  readonly hidden?:(level:number,triangle:number)=>boolean;
}
export interface IsolineResult3 {readonly network:SurfaceCurveNetwork3;readonly stats:{readonly crossings:number;readonly segments:number;readonly chains:number;readonly nodes:number;readonly lazy?:IsolineLazyStats3}}
const EMPTY_WEIGHTS:readonly bigint[]=Object.freeze([0n,0n,0n]);
const nextUp=(x:number)=>{const y=x+Number.EPSILON*Math.max(1,Math.abs(x));return y>x?y:x+Number.MIN_VALUE;};
function positiveBudget(value:number|undefined,fallback:number,name:string):number {
  const n=value??fallback;if(!(n===Infinity||Number.isSafeInteger(n))||n<0)throw new Error(`isolines ${name} budget must be a nonnegative integer or Infinity`);return n;
}
/** An end of a deferred record: everything the crossing point and its node are
 * a function of, and nothing built. `lo`/`hi` are corner indices on
 * `triangle`; `li`/`slots`/`valuesKey` are the node's name, so realising the
 * end later mints the very node an eager run would have. */
interface DeferredEnd3 {readonly triangle:number;readonly lo:number;readonly hi:number;readonly s:number;readonly crossing:string;readonly li:number;readonly slots:readonly number[];readonly valuesKey:string}
/** `values` holds one number per corner in face order, then polygon order. */
export function isolines3(input:Surface3,values:ArrayLike<number>,levels:readonly number[],options:IsolineOptions3={}):IsolineResult3 {
  const surface=snapshotSurface3(input),binding=surfaceBinding3(surface),key=options.key??'isolines';
  const maxSegments=positiveBudget(options.maxSegments,250000,'segment'),maxNodes=positiveBudget(options.maxNodes,250000,'node');
  const certified=options.hidden;
  if(certified!==undefined&&typeof certified!=='function')throw new Error('isolines hidden certificate must be a predicate');
  // A level that is not a number draws no contour, and its neighbours keep
  // their own level index; no levels at all leaves the network empty rather
  // than breaking the sketch.
  const offsets:number[]=[];let total=0;for(const face of surface.faces){offsets.push(total);total+=face.vertices.length;}
  if(values.length!==total)throw new Error('isolines require one value per corner');
  // A corner the field could not answer skips the triangles that touch it.

  const nodes:SurfaceCurveNetworkInput3['nodes'][number][]=[],nodeIds=new Map<string,string>(),positions=new Map<string,readonly [number,number,number]>();
  const segments:{id:string;a:string;b:string;ka:string;kb:string;wa:readonly bigint[];wb:readonly bigint[];ea:DeferredEnd3|null;eb:DeferredEnd3|null;triangle:number;length:number;index:number;level:number;hidden:boolean}[]=[];
  // The two triangles that share an edge compute the same crossing: the same
  // ordered vertex pair and, when their corner values agree there, the same
  // binary64 parameter, so the weighted point is the same exact point built
  // twice. Its canonicalization is the isolines' largest exact cost, so the
  // point is built once and the second triangle is handed the same value.
  const crossings=new Map<string,H>();
  const stats={crossings:0,segments:0,chains:0,nodes:0};
  const lazy={deferred:0,excludedTies:0,points:0,phasePoints:0,referenceRecords:0,hiddenChains:0,mixedChains:0};
  // A port names its node without its coordinates: the level, the mesh slots
  // and the corner values there decide the crossing parameter, so they decide
  // the point, so one port key is one node whether or not it is built. A run
  // without a certificate chains on node ids, exactly as it did.
  const node=(li:number,slots:readonly number[],valuesKey:string,point:H):string=>{
    const k=JSON.stringify([li,slots,valuesKey,encodePoint(point)]);const previous=nodeIds.get(k);if(previous)return previous;
    if(nodes.length>=maxNodes)throw new Error('isolines exceed node budget');
    const id=identity('isoline-node',key,k);nodeIds.set(k,id);nodes.push({id,point});positions.set(id,pointNumber(point));return id;
  };
  /** A deferred end, built at last: the very exact point an eager run would
   * have built — from the cache when the neighbouring triangle already paid
   * for it — its node, and its integer weights on its own triangle. Only a
   * chain with a survivor ever asks, and only for its own hidden records. */
  const realise=(end:DeferredEnd3):{id:string;weights:readonly bigint[]}=>{
    const w=integerWeights([1-end.s,end.s]),weights=[0n,0n,0n];weights[end.lo]=w[0];weights[end.hi]=w[1];
    let point=crossings.get(end.crossing);
    if(!point){point=weightedPoint(bindingTriangle3(binding,end.triangle),weights);crossings.set(end.crossing,point);lazy.phasePoints++;}
    return {id:node(end.li,end.slots,end.valuesKey,point),weights};
  };
  levels.forEach((level,li)=>{
    if(!Number.isFinite(level))return;
    for(let ti=0;ti<surface.triangles.length;ti++){
      const t=surface.triangles[ti],corners=triangleCorners3(surface,ti),f=corners.map(c=>values[offsets[t.face]+c]);
      if(!f.every(Number.isFinite))continue;
      const above=f.map(v=>v>=level);
      if(above.every(Boolean)||!above.some(Boolean))continue;
      // A certified pair defers, unless a corner value IS the level: the tie
      // and plateau conventions route through a vertex node, and this pass
      // leaves them to the original construction.
      let defer=false;
      if(certified!==undefined&&certified(level,ti)){
        if(f.some(v=>v===level))lazy.excludedTies++;else{defer=true;lazy.deferred++;}
      }
      const world=defer?undefined:bindingTriangle3(binding,ti),ends:string[]=[],ports:string[]=[],endWeights:(readonly bigint[])[]=[],deferred:(DeferredEnd3|null)[]=[];
      for(let e=0;e<3;e++){
        const i=e,j=(e+1)%3;if(above[i]===above[j])continue;
        const [lo,hi]=above[j]?[i,j]:[j,i],s=(level-f[lo])/(f[hi]-f[lo]);
        stats.crossings++;
        // The key names the ordered world vertices and the parameter, which is
        // everything the affine combination reads; `s` is a finite binary64 in
        // (0, 1], so its decimal form names one double and no other.
        const ck=`${t.vertices[lo]},${t.vertices[hi]},${s}`;
        // `s` is 1 exactly when the level IS the far corner's value, which a
        // deferred record has already excluded: a deferred crossing is on the
        // open edge, and its port is the same node an eager run would mint.
        const slots=s<1?[t.vertices[lo],t.vertices[hi]].sort((a,b)=>a-b):[t.vertices[hi]];
        const valuesKey=s<1?JSON.stringify(t.vertices[lo]<t.vertices[hi]?[f[lo],f[hi]]:[f[hi],f[lo]]):String(f[hi]);
        if(defer){
          // The end is named, not built: one object per end of a deferred
          // record, and nothing exact until a surviving chain asks.
          ends.push('');ports.push(JSON.stringify([li,slots,valuesKey]));endWeights.push(EMPTY_WEIGHTS);
          deferred.push({triangle:ti,lo,hi,s,crossing:ck,li,slots,valuesKey});
          continue;
        }
        const w=integerWeights([1-s,s]),weights=[0n,0n,0n];weights[lo]=w[0];weights[hi]=w[1];
        let point=crossings.get(ck);
        if(!point){point=weightedPoint(world!,weights);crossings.set(ck,point);lazy.points++;}
        const id=node(li,slots,valuesKey,point);
        ends.push(id);ports.push(certified===undefined?id:JSON.stringify([li,slots,valuesKey]));
        endWeights.push(weights);deferred.push(null);
      }
      if(ends.length!==2||ports[0]===ports[1])continue;
      if(segments.length>=maxSegments)throw new Error('isolines exceed segment budget');
      const length=defer?NaN:(()=>{const [pa,pb]=[positions.get(ends[0])!,positions.get(ends[1])!];return Math.hypot(pa[0]-pb[0],pa[1]-pb[1],pa[2]-pb[2]);})();
      segments.push({id:defer?'':identity('isoline-segment',key,li,ti,ends),a:ends[0],b:ends[1],ka:ports[0],kb:ports[1],wa:endWeights[0],wb:endWeights[1],ea:deferred[0],eb:deferred[1],triangle:ti,length,index:li,level,hidden:defer});
    }
  });
  // Chain by shared nodes per level: open chains start at degree != 2 nodes,
  // leftovers are closed loops. Range is cumulative length fraction.
  const rows:SurfaceCurveNetworkInput3['segments'][number][]=[];
  /** The ids of the rows that are reference geometry only. */
  const reference=new Set<string>();
  const byLevel=new Map<number,number[]>();segments.forEach((s,i)=>{const list=byLevel.get(s.index)??[];list.push(i);byLevel.set(s.index,list);});
  for(const [li,list] of byLevel){
    const incident=new Map<string,number[]>();for(const i of list)for(const n of [segments[i].ka,segments[i].kb]){const l=incident.get(n)??[];l.push(i);incident.set(n,l);}
    const used=new Set<number>();let ordinal=0;
    const walk=(start:number,from:string)=>{
      const chain:{segment:number;forward:boolean}[]=[];let current=start,at=from;
      while(!used.has(current)){
        used.add(current);const s=segments[current],forward=s.ka===at,next=forward?s.kb:s.ka;chain.push({segment:current,forward});
        const candidates=(incident.get(next)??[]).filter(i=>!used.has(i));
        if(candidates.length!==1||(incident.get(next)??[]).length!==2)break;
        current=candidates[0];at=next;
      }
      return chain;
    };
    const emit=(chain:{segment:number;forward:boolean}[])=>{
      const chainId=identity('isoline-chain',key,li,ordinal++);
      stats.chains++;
      // A chain nothing survives in emits nothing and needs no coordinates:
      // no consumer can reach it, so it owes no reference either.
      //
      // A chain that enters the certified faces and comes back out is built
      // WHOLE. Its hidden records are realised — the same nodes, the same
      // ids, the same weights, the same order an eager run gave them — and
      // go into the reference network alone, so the chain's arc length, its
      // index 0 and everything phased along it are what they always were.
      // Only the classified network loses them.
      if(certified!==undefined){
        const hidden=chain.filter(c=>segments[c.segment].hidden).length;
        if(hidden===chain.length){lazy.hiddenChains++;return;}
        if(hidden){
          lazy.mixedChains++;lazy.referenceRecords+=hidden;
          for(const c of chain){
            const s=segments[c.segment];if(!s.hidden)continue;
            const a=realise(s.ea!),b=realise(s.eb!);
            s.a=a.id;s.b=b.id;s.wa=a.weights;s.wb=b.weights;
            s.id=identity('isoline-segment',key,s.index,s.triangle,[a.id,b.id]);
            const [pa,pb]=[positions.get(a.id)!,positions.get(b.id)!];
            s.length=Math.hypot(pa[0]-pb[0],pa[1]-pb[1],pa[2]-pb[2]);
          }
        }
      }
      const total=chain.reduce((sum,c)=>sum+segments[c.segment].length,0);
      let cursor=0,previous=0;
      for(const c of chain){
        const s=segments[c.segment];const lo=Math.max(cursor/total,previous),hi=Math.max((cursor+s.length)/total,nextUp(lo));cursor+=s.length;
        // The producer already holds each end's integer weights on this
        // triangle — the same affine combination that built the point — so the
        // network verifies them with multiplications instead of solving the
        // barycentric system again. `a`/`b` follow the chain's direction.
        if(s.hidden)reference.add(s.id);
        rows.push({id:s.id,kind:'isoline',a:c.forward?s.a:s.b,b:c.forward?s.b:s.a,chainId,range:[lo,Math.min(1,hi)>lo?Math.min(1,hi):hi],supports:[{source:0,triangle:s.triangle,a:c.forward?s.wa:s.wb,b:c.forward?s.wb:s.wa}],attributes:{level:s.level,levelIndex:s.index}});
        previous=hi;
      }
    };
    for(const i of list){if(used.has(i))continue;const s=segments[i];const start=[s.ka,s.kb].find(n=>(incident.get(n)??[]).length!==2);if(start!==undefined)emit(walk(i,start));}
    for(const i of list){if(used.has(i))continue;emit(walk(i,segments[i].ka));}
  }
  const whole=surfaceCurveNetwork3({sources:[{id:'surface',binding}],nodes,segments:rows},options.budget);
  // The classified network is the whole one minus the records the certificate
  // proved hidden; `selectSurfaceCurveNetwork3` is what keeps the whole graph
  // reachable as `reference`, which is the same door a filtered selection uses.
  const network=reference.size?selectSurfaceCurveNetwork3(whole,whole.segments.flatMap((row,i)=>reference.has(row.id)?[]:[i])):whole;
  stats.segments=network.segments.length;stats.nodes=network.nodes.length;
  return {network,stats:Object.freeze(certified===undefined?stats:{...stats,lazy:Object.freeze(lazy)})};
}

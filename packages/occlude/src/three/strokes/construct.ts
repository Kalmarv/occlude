import { unionSourceRanges3 } from './ranges.js';
import { groupRows } from '../../groupRows.js';
import { toPaper3 } from '../camera.js';
import type { Feature3 } from '../features/snapshot.js';
import { lerp3 } from '../math.js';
import { unionIntervals3, type Interval3 } from '../visibility/interval.js';
import type { ClassifiedFeature3, ClassifiedScene3 } from '../visibility/scene.js';
import {decodePoint,difference,dot3} from '../geometry/exact.js';
import {collinearExact3} from '../curves/contact.js';

type Point = readonly [number, number];
export type Visibility3 = 'visible' | 'hidden';
export type StrokeBreak3 = 'source' | 'occlusion' | 'clipping' | 'style' | 'junction' | 'corner' | 'dash';
export interface LineSet3 {
  readonly id: string;
  readonly stroke: string;
  readonly priority?: number;
  readonly visibility?: Visibility3;
  readonly select?: ((feature: Feature3) => boolean) | FeatureSelection3;
  /** Local clipped segment parameters, intersected with classified visibility. */
  readonly ranges?: (feature: Feature3) => readonly Interval3[];
  readonly overdraw?: boolean;
}
export interface StrokePart3 {
  readonly feature: Feature3;
  /** Original source parameters, possibly descending after chaining. */
  readonly range: Interval3;
  readonly a: Point;
  readonly b: Point;
  readonly length: number;
}
export interface StrokeReference3 {
  readonly id: string;
  readonly points: readonly Point[];
  readonly arclength: readonly number[];
  readonly length: number;
}
export interface Stroke3 {
  /** Complete selected source chain, before visibility/style range cuts. */
  readonly reference: StrokeReference3;
  /** Selected intervals in reference segment-index + projected fraction. */
  readonly sourceRanges: readonly Interval3[];
  readonly id: string;
  readonly source: ClassifiedScene3;
  readonly set: string;
  readonly stroke: string;
  readonly visibility: Visibility3;
  readonly parts: readonly StrokePart3[];
  readonly points: readonly Point[];
  readonly arclength: readonly number[];
  readonly length: number;
  readonly closed: boolean;
  readonly breaks: readonly [StrokeBreak3, StrokeBreak3];
}
/** Immutable views retain exact source-state ownership, like relation.ts. */
export class FeatureSelection3 implements Iterable<ClassifiedFeature3> {
  constructor(readonly source: ClassifiedScene3, private readonly rows: readonly number[] = source.features.map((_,i)=>i)) {
    if(rows.some(i=>!Number.isSafeInteger(i)||i<0||i>=source.features.length))throw new Error('invalid classified feature selection index');
    this.rows=Object.freeze([...new Set(rows)]); Object.freeze(this);
  }
  *[Symbol.iterator]() { for(const i of this.rows) yield this.source.features[i]; }
  get length() { return this.rows.length; }
  filter(predicate: (feature: ClassifiedFeature3, i: number)=>boolean): FeatureSelection3 {
    return new FeatureSelection3(this.source,this.rows.filter((row,i)=>predicate(this.source.features[row],i)));
  }
  map<T>(fn: (feature: ClassifiedFeature3, i: number)=>T): T[] { return this.rows.map((row,i)=>fn(this.source.features[row],i)); }
  groupBy<K>(fn: (feature: ClassifiedFeature3, i: number)=>K): {key:K; selection:FeatureSelection3}[] {
    return groupRows(this.rows,row=>row,(row,i)=>fn(this.source.features[row],i)).map(g=>({key:g.key,selection:new FeatureSelection3(this.source,g.rows)}));
  }
  union(other: FeatureSelection3): FeatureSelection3 {
    if(other.source!==this.source)throw new Error('3D selections belong to different snapshots');
    return new FeatureSelection3(this.source,[...new Set([...this.rows,...other.rows])].sort((a,b)=>a-b));
  }
}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const distance=(a:Point,b:Point)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const intersect=(a:readonly Interval3[],b:readonly Interval3[])=>unionIntervals3(a.flatMap(x=>b.flatMap(y=>{const lo=Math.max(x[0],y[0]),hi=Math.min(x[1],y[1]);return lo<hi?[[lo,hi] as Interval3]:[]})));
function subtract(ranges: readonly Interval3[], claimed: readonly Interval3[]): Interval3[] {
  let out=[...ranges];
  for(const [lo,hi] of claimed)out=out.flatMap(([a,b])=>hi<=a||lo>=b?[[a,b]]:[...(a<lo?[[a,lo] as Interval3]:[]),...(hi<b?[[hi,b] as Interval3]:[])]);
  return out;
}
interface Run { key:string; set:LineSet3; visibility:Visibility3; part:StrokePart3; ends:[string|null,string|null]; breaks:[StrokeBreak3,StrokeBreak3] }
const reversed=(p:StrokePart3):StrokePart3=>({...p,a:p.b,b:p.a,range:[p.range[1],p.range[0]]});

/** Select → resolve interval ownership → chain → corner split → length filter.
 * Junctions use source IDs, never projected crossings. No hidden gap is joined.
 * Stable set priority wins individual intervals; overdraw is explicit. */
export function constructStrokes3(source:ClassifiedScene3,sets:readonly LineSet3[],options:{endpointTolerance?:number;cornerDegrees?:number;minLength?:number;chain?:boolean}={}):readonly Stroke3[] {
  const frame=source.frame;
  const tolerance=options.endpointTolerance??1e-8, corner=options.cornerDegrees??180,minLength=options.minLength??0;
  if(![tolerance,corner,minLength].every(Number.isFinite)||tolerance<0||corner<0||corner>180||minLength<0)throw new Error('invalid stroke construction tolerances');
  if(new Set(sets.map(s=>s.id)).size!==sets.length||sets.some(s=>!s.id||!s.stroke||!Number.isFinite(s.priority??0)))throw new Error('line sets need unique IDs, named pens and finite priorities');
  const runs:Run[]=[],referenceRuns:Run[]=[],claimed=new Map<string,Interval3[]>();
  for(const set of [...sets].sort((a,b)=>(b.priority??0)-(a.priority??0)||compare(a.id,b.id))) {
    const visibility=set.visibility??'visible';
    const selection=set.select instanceof FeatureSelection3?set.select:undefined;
    if(selection && selection.source!==source)throw new Error('line set selection belongs to another classified snapshot');
    const included=selection?new Set(selection.map(row=>row.feature.id)):undefined;
    const include=(f:Feature3)=>!(included&&!included.has(f.id)||typeof set.select==='function'&&!set.select(f));
    const selectedChains=new Set<string>();
    for(const row of source.features){const curve=curveSource(source,row.feature);if(curve&&include(row.feature))selectedChains.add(curve.key);}
    for(const f of referenceMemo.get(source)?.has(referenceKey(set,options))?[]:source.referenceFeatures??source.features.map(r=>r.feature)){
      const curve=curveSource(source,f);
      if(curve?!selectedChains.has(curve.key):!include(f))continue;
      const ra=toPaper3(frame,f.a),rb=toPaper3(frame,f.b),rl=distance(ra,rb);
      if(rl>0||curve)referenceRuns.push({key:JSON.stringify([set.id,f.id,0,1]),set,visibility,part:{feature:f,range:f.range,a:ra,b:rb,length:rl},ends:[f.range[0]===0?f.endpoints[0]:null,f.range[1]===1?f.endpoints[1]:null],breaks:[f.range[0]===0?'source':'clipping',f.range[1]===1?'source':'clipping']});
    }
    for(const record of source.features) {
      const f=record.feature;if(!include(f))continue;
      const requested=set.ranges?.(f)??[[0,1]];
      if(requested.some(r=>r.length!==2||!r.every(Number.isFinite)||r[0]<0||r[1]>1||r[0]>r[1]))throw new Error('line set ranges must be ordered within [0,1]');
      if(requested.length===0)continue; // a per-pen set names few of the scene's features
      const key=JSON.stringify([f.id,visibility]), occupied=claimed.get(key)??[];
      const selected=intersect(record[visibility],requested),ranges=set.overdraw?selected:subtract(selected,occupied);
      if(!set.overdraw)claimed.set(key,unionIntervals3([...occupied,...ranges]));
      for(const [lo,hi] of ranges) {
        const a=toPaper3(frame,lerp3(f.a,f.b,lo)),b=toPaper3(frame,lerp3(f.a,f.b,hi)),length=distance(a,b);
        if(length===0)continue;
        const range:Interval3=[f.range[0]+lo*(f.range[1]-f.range[0]),f.range[0]+hi*(f.range[1]-f.range[0])];
        const boundary=(t:number,side:0|1):StrokeBreak3=>t===side?(f.range[side]===side?'source':'clipping'):record[visibility].some(r=>r[side]===t)?'occlusion':'style';
        runs.push({key:JSON.stringify([set.id,f.id,lo,hi]),set,visibility,part:{feature:f,range,a,b,length},ends:[lo===0&&f.range[0]===0?f.endpoints[0]:null,hi===1&&f.range[1]===1?f.endpoints[1]:null],breaks:[boundary(lo,0),boundary(hi,1)]});
      }
    }
  }
  const lookup=new Map<string,ReferenceEntry>();
  for(const set of sets)for(const [key,entry] of referenceLookup(source,set,referenceRuns.filter(r=>r.set===set),options))lookup.set(key,entry);
  const key=(r:Run)=>JSON.stringify([r.set.id,r.part.feature.id]);
  const output=chainRuns(source,runs,options,(a,b)=>lookup.get(key(a))!.reference===lookup.get(key(b))!.reference);
  return Object.freeze(output.map(run=>{
    const rows=run.parts.map(part=>{
      const entry=lookup.get(JSON.stringify([run.set,part.feature.id]))!;
      const a=entry.a,b=entry.b,dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy;
      const coordinate=(p:Point)=>entry.index+Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d));
      const x=coordinate(part.a),y=coordinate(part.b);
      return {reference:entry.reference,range:[Math.min(x,y),Math.max(x,y)] as Interval3};
    });
    return Object.freeze({...run,reference:rows[0].reference,sourceRanges:Object.freeze(unionSourceRanges3(rows.map(r=>r.range)).map(r=>Object.freeze(r)))});
  }));
}

type ConstructOptions={endpointTolerance?:number;cornerDegrees?:number;minLength?:number;chain?:boolean};
interface ReferenceEntry {reference:StrokeReference3;a:Point;b:Point;index:number}
/** Reference chains of one line set: the complete selected source chains,
 * keyed by set ID and feature ID. A set without a selection covers every
 * feature of the scene, so its chains depend only on the scene, the set ID,
 * the visibility and the chaining options; the view's default drawing builds
 * one such set per pen, and they all share this memo. */
const referenceMemo=new WeakMap<ClassifiedScene3,Map<string,ReadonlyMap<string,ReferenceEntry>>>();
const referenceKey=(set:LineSet3,options:ConstructOptions)=>set.select===undefined?JSON.stringify([set.id,set.visibility??'visible',options.endpointTolerance??1e-8,options.cornerDegrees??180,options.chain??true]):'';
function referenceLookup(source:ClassifiedScene3,set:LineSet3,referenceRuns:Run[],options:ConstructOptions):ReadonlyMap<string,ReferenceEntry> {
  const memoKey=referenceKey(set,options),shared=memoKey!=='';
  if(shared){const hit=referenceMemo.get(source)?.get(memoKey);if(hit)return hit;}
  const references=[
    ...chainRuns(source,referenceRuns.filter(r=>!curveSource(source,r.part.feature)),{...options,minLength:0}),
    ...chainRuns(source,referenceRuns.filter(r=>curveSource(source,r.part.feature)),{endpointTolerance:options.endpointTolerance,cornerDegrees:180,minLength:0,chain:true}),
  ];
  const lookup=new Map<string,ReferenceEntry>();
  for(const r of references) {
    const {reference,indices}=sourceReference(source,r);
    r.parts.forEach((part,i)=>{const index=indices[i];lookup.set(JSON.stringify([r.set,part.feature.id]),{reference,a:reference.points[index],b:reference.points[index+1],index});});
  }
  if(shared){let byKey=referenceMemo.get(source);if(!byKey){byKey=new Map();referenceMemo.set(source,byKey);}byKey.set(memoKey,lookup);}
  return lookup;
}
type BuiltStroke3=Omit<Stroke3,'reference'|'sourceRanges'>;
/** Legacy section/hatch curves retain their historical interpretation. New
 * supported generators supply their own complete chain identity and order. */
// Memoized per feature: the sort comparators and junction checks ask for the
// same feature's source many times, and the key is a JSON encoding.
const curveSources=new WeakMap<Feature3,ReturnType<typeof curveSourceOf>>();
function curveSource(source:ClassifiedScene3,feature:Feature3) {
  let value=curveSources.get(feature);
  if(value===undefined&&!curveSources.has(feature)){value=curveSourceOf(source,feature);curveSources.set(feature,value);}
  return value;
}
function curveSourceOf(source:ClassifiedScene3,feature:Feature3) {
  if(feature.curve||!feature.supportedCurve)return undefined;
  const {graph,segment}=feature.supportedCurve,entry=source.curveGraphs?.[graph],row=entry?.network.segments[segment];
  return entry&&row?{key:JSON.stringify([entry.id,row.chainId]),network:entry.network,segment:row}:undefined;
}
function sourceReference(source:ClassifiedScene3,run:BuiltStroke3):{reference:StrokeReference3;indices:number[]} {
  const first=curveSource(source,run.parts[0].feature);
  if(!first)return {reference:Object.freeze({id:run.id,points:run.points,arclength:run.arclength,length:run.length}),indices:run.parts.map((_,i)=>i)};
  const points:Point[]=[run.parts[0].a],indices:number[]=[];
  const exact=(part:StrokePart3)=>{
    const curve=curveSource(source,part.feature)!;
    const a=decodePoint(curve.network.nodes[curve.segment.a].exact),b=decodePoint(curve.network.nodes[curve.segment.b].exact);
    return part.range[0]<=part.range[1]?[a,b] as const:[b,a] as const;
  };
  let previous=exact(run.parts[0]);
  for(let i=0;i<run.parts.length;i++){
    const current=exact(run.parts[i]);
    const straight=i>0&&collinearExact3(...previous,current[0])&&collinearExact3(...previous,current[1])&&dot3(difference(previous[1],previous[0]),difference(current[1],current[0]))>0n;
    if(straight)points[points.length-1]=run.parts[i].b;else points.push(run.parts[i].b);
    indices.push(points.length-2);previous=current;
  }
  const arclength=[0];for(let i=1;i<points.length;i++)arclength.push(arclength.at(-1)!+distance(points[i-1],points[i]));
  const reference=Object.freeze({id:JSON.stringify(['surface-curve',first.key]),points:Object.freeze(points),arclength:Object.freeze(arclength),length:arclength.at(-1)!});
  return {reference,indices};
}
function chainRuns(source:ClassifiedScene3,runs:Run[],options:ConstructOptions,compatible:(a:Run,b:Run)=>boolean=()=>true):readonly BuiltStroke3[] {
  const tolerance=options.endpointTolerance??1e-8,corner=options.cornerDegrees??180,minLength=options.minLength??0;
  runs.sort((a,b)=>{
    const x=curveSource(source,a.part.feature),y=curveSource(source,b.part.feature);
    if(!x||!y)return x?1:y?-1:compare(a.key,b.key);
    const position=(r:Run,c:NonNullable<typeof x>)=>c.segment.range[0]+r.part.range[0]*(c.segment.range[1]-c.segment.range[0]);
    return compare(a.set.id,b.set.id)||compare(a.visibility,b.visibility)||compare(x.key,y.key)||position(a,x)-position(b,y)||compare(a.key,b.key);
  });
  const junctions=new Map<string,{row:number;end:0|1}[]>();
  runs.forEach((r,row)=>r.ends.forEach((endpoint,end)=>{if(endpoint===null)return;const key=JSON.stringify([r.set.id,r.visibility,endpoint]);const entries=junctions.get(key)??[];entries.push({row,end:end as 0|1});junctions.set(key,entries);}));
  const links=new Map<string,{row:number;end:0|1}>();
  const link=(x:{row:number;end:0|1},y:{row:number;end:0|1})=>{
    const a=runs[x.row],b=runs[y.row];
    const ca=curveSource(source,a.part.feature),cb=curveSource(source,b.part.feature);
    if(ca?.key!==cb?.key||!compatible(a,b)){a.breaks[x.end]='junction';b.breaks[y.end]='junction';return;}
    const p=x.end?a.part.b:a.part.a,q=y.end?b.part.b:b.part.a;
    if(distance(p,q)>tolerance)return;
    const pa=x.end?a.part.a:a.part.b,pb=y.end?b.part.a:b.part.b;
    const cosine=((p[0]-pa[0])*(pb[0]-q[0])+(p[1]-pa[1])*(pb[1]-q[1]))/(a.part.length*b.part.length);
    if(Math.acos(Math.max(-1,Math.min(1,cosine)))*180/Math.PI>corner){a.breaks[x.end]='corner';b.breaks[y.end]='corner';return;}
    links.set(`${x.row}:${x.end}`,y);links.set(`${y.row}:${y.end}`,x);
  };
  for(const entries of options.chain===false?[]:junctions.values()) {
    if(entries.length===2){link(entries[0],entries[1]);continue;}
    if(entries.length<2)continue;
    // More than two runs meet here: a mesh vertex, where a silhouette loop
    // passes through among the other edges of the fan. Runs of the same kind
    // pair off when they are the only two of that kind; the rest break.
    const byKind=new Map<number,{row:number;end:0|1}[]>();
    for(const e of entries){const flags=runs[e.row].part.feature.flags;const rows=byKind.get(flags)??[];rows.push(e);byKind.set(flags,rows);}
    for(const group of byKind.values()){
      if(group.length===2)link(group[0],group[1]);
      else for(const e of group)runs[e.row].breaks[e.end]='junction';
    }
  }
  const used=new Set<number>(),out:BuiltStroke3[]=[];
  const walk=(start:number,entry:0|1)=>{
    const parts:StrokePart3[]=[],keys:string[]=[],first=runs[start];let row=start,end=entry,last=first,exit:0|1=entry,closed=false;
    while(!used.has(row)) {
      used.add(row);last=runs[row];keys.push(last.key);parts.push(end===0?last.part:reversed(last.part));exit=end===0?1:0;
      const next=links.get(`${row}:${exit}`);if(!next)break;
      if(next.row===start){closed=true;break;}row=next.row;end=next.end;
    }
    const arclength=[0];for(const p of parts)arclength.push(arclength.at(-1)!+p.length);
    const length=arclength.at(-1)!;if(length<minLength)return;
    out.push(Object.freeze({id:JSON.stringify(keys),source,set:first.set.id,stroke:first.set.stroke,visibility:first.visibility,parts:Object.freeze(parts.map(p=>Object.freeze({...p,range:Object.freeze([...p.range]) as Interval3,a:Object.freeze([...p.a]) as Point,b:Object.freeze([...p.b]) as Point}))),points:Object.freeze([parts[0].a,...parts.map(p=>p.b)].map(p=>Object.freeze([...p]) as Point)),arclength:Object.freeze(arclength),length,closed,breaks:Object.freeze([first.breaks[entry],last.breaks[exit]]) as readonly [StrokeBreak3,StrokeBreak3]}));
  };
  // Start open chains at deterministic source ends before consuming loops.
  runs.forEach((_,i)=>{if(used.has(i))return;if(!links.has(`${i}:0`))walk(i,0);else if(!links.has(`${i}:1`))walk(i,1);});
  runs.forEach((_,i)=>{if(!used.has(i))walk(i,0);});
  return Object.freeze(out);
}

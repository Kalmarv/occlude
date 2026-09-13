import { groupRows } from '../../groupRows.js';
import { toPaper3 } from '../camera.js';
import type { Feature3 } from '../features/snapshot.js';
import { lerp3 } from '../math.js';
import { unionIntervals3, type Interval3 } from '../visibility/interval.js';
import type { ClassifiedFeature3, ClassifiedScene3 } from '../visibility/scene.js';

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
export interface Stroke3 {
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
  const runs:Run[]=[],claimed=new Map<string,Interval3[]>();
  for(const set of [...sets].sort((a,b)=>(b.priority??0)-(a.priority??0)||compare(a.id,b.id))) {
    const visibility=set.visibility??'visible';
    const selection=set.select instanceof FeatureSelection3?set.select:undefined;
    if(selection && selection.source!==source)throw new Error('line set selection belongs to another classified snapshot');
    const included=selection?new Set(selection.map(row=>row.feature.id)):undefined;
    for(const record of source.features) {
      const f=record.feature;if(included&&!included.has(f.id)||typeof set.select==='function'&&!set.select(f))continue;
      const requested=set.ranges?.(f)??[[0,1]];
      if(requested.some(r=>r.length!==2||!r.every(Number.isFinite)||r[0]<0||r[1]>1||r[0]>r[1]))throw new Error('line set ranges must be ordered within [0,1]');
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
  runs.sort((a,b)=>compare(a.key,b.key));
  const junctions=new Map<string,{row:number;end:0|1}[]>();
  runs.forEach((r,row)=>r.ends.forEach((endpoint,end)=>{if(endpoint===null)return;const key=JSON.stringify([r.set.id,r.visibility,endpoint]);const entries=junctions.get(key)??[];entries.push({row,end:end as 0|1});junctions.set(key,entries);}));
  const links=new Map<string,{row:number;end:0|1}>();
  for(const entries of options.chain===false?[]:junctions.values()) {
    if(entries.length!==2){if(entries.length>2)for(const e of entries)runs[e.row].breaks[e.end]='junction';continue;}
    const [x,y]=entries,a=runs[x.row],b=runs[y.row];
    const p=x.end?a.part.b:a.part.a,q=y.end?b.part.b:b.part.a;
    if(distance(p,q)>tolerance)continue;
    const pa=x.end?a.part.a:a.part.b,pb=y.end?b.part.a:b.part.b;
    const cosine=((p[0]-pa[0])*(pb[0]-q[0])+(p[1]-pa[1])*(pb[1]-q[1]))/(a.part.length*b.part.length);
    if(Math.acos(Math.max(-1,Math.min(1,cosine)))*180/Math.PI>corner){a.breaks[x.end]='corner';b.breaks[y.end]='corner';continue;}
    links.set(`${x.row}:${x.end}`,y);links.set(`${y.row}:${y.end}`,x);
  }
  const used=new Set<number>(),out:Stroke3[]=[];
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

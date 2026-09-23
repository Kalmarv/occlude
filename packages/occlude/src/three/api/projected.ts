import type {ShapeOpts,ShapeValue} from '../../api.js';
import type {Execution} from '../../execution.js';
import {paperToUser} from '../../record.js';
import {FeatureKind3,type Feature3} from '../features/snapshot.js';
import type {ClassifiedScene3} from '../visibility/scene.js';
import type {Interval3} from '../visibility/interval.js';
import {constructStrokes3} from '../strokes/construct.js';
import {sourceStrokeShapes3} from '../strokes/paper.js';
import {toPaper3} from '../camera.js';
import {lerp3} from '../math.js';
import {Collection} from './collection.js';
export type FeatureKind=keyof typeof FeatureKind3;
const kindSets=new Map<number,ReadonlySet<FeatureKind>>();
function kinds(flags:number):ReadonlySet<FeatureKind>{
  const cached=kindSets.get(flags);if(cached)return cached;
  const set=new Set((Object.keys(FeatureKind3) as FeatureKind[]).filter(k=>(flags&FeatureKind3[k])!==0));
  const result:ReadonlySet<FeatureKind>=Object.freeze({size:set.size,has:(k:FeatureKind)=>set.has(k),keys:()=>set.keys(),values:()=>set.values(),entries:()=>set.entries(),[Symbol.iterator]:()=>set[Symbol.iterator](),forEach:(callback:(value:FeatureKind,key:FeatureKind,set:ReadonlySet<FeatureKind>)=>void,thisArg?:unknown)=>set.forEach(v=>callback.call(thisArg,v,v,result))});
  kindSets.set(flags,result);
  return result;
}
export interface ProjectedCurveRow {
  readonly id:string;readonly index:number;
  readonly instance?:Feature3['instance'];
  readonly feature:Feature3;readonly kinds:ReadonlySet<FeatureKind>;
  /** Local clipped source parameters; endpoints are physical paper millimeters. */
  readonly range:Interval3;readonly a:readonly [number,number];readonly b:readonly [number,number];
  readonly attributes:Feature3['attributes'];readonly faceAttributes:Feature3['faceAttributes'];readonly support:Feature3['support'];
}
/** One classified interval. Its source's columns read as properties
 * (`c.rim`), as on every other row; `attributes` is the same record. */
export type ProjectedCurve=ProjectedCurveRow&{readonly [column:string]:unknown};
/** A chain of projected lines in the sketch's drawable units, the value a
 * chain consumer reads from `curves()`. */
export interface ProjectedChain {pts:[number,number][];closed:boolean;indices:number[]}
/** Paper millimetres to the drawable units of the sketch the view is drawn in. */
export type PaperToUser=(x:number,y:number)=>[number,number];
/** Classified intervals with their full source retained through filtering. */
export class ProjectedCurves implements Iterable<ProjectedCurve> {
  readonly __occludeProjectedCurves=true;
  readonly rows:readonly ProjectedCurve[];readonly key:unknown;
  readonly #toUser?:PaperToUser;
  constructor(readonly source:ClassifiedScene3,readonly visibility:'visible'|'hidden',rows?:readonly ProjectedCurve[],key?:unknown,toUser?:PaperToUser){
    this.key=key;this.#toUser=toUser;
    // A row's ID is identity, never content, and most rows are never asked
    // for theirs. A literal getter keeps it own, enumerable and first — a
    // spread of a row still carries the same text — and spells it on demand
    // instead of building one JSON key per classified interval. The record
    // is read by field rather than rest-destructured, which saved an object
    // per feature as well.
    this.rows=Object.freeze(rows?[...rows]:source.features.flatMap((record,index)=>{
      const feature=record.feature;
      return record[visibility].map((range,i)=>Object.freeze({
        get id():string{return JSON.stringify([feature.id,visibility,i]);},
        ...feature.attributes,
        index,feature,...(feature.instance?{instance:feature.instance}:{}),kinds:kinds(feature.flags),range,
        a:Object.freeze(toPaper3(source.frame,lerp3(feature.a,feature.b,range[0]))),
        b:Object.freeze(toPaper3(source.frame,lerp3(feature.a,feature.b,range[1]))),
        attributes:feature.attributes,faceAttributes:feature.faceAttributes,support:feature.support,
      }) as ProjectedCurve);
    }));
    Object.freeze(this);
  }
  get length():number{return this.rows.length;}
  [Symbol.iterator]():IterableIterator<ProjectedCurve>{return this.rows[Symbol.iterator]();}
  map<T>(fn:(row:ProjectedCurve,index:number)=>T):T[]{return this.rows.map(fn);}
  filter(fn:(row:ProjectedCurve,index:number)=>boolean):ProjectedCurves{return new ProjectedCurves(this.source,this.visibility,this.rows.filter(fn),this.key,this.#toUser);}
  /** The lines as chains in drawable units: intervals that meet end to end,
   * two at a point, join into one chain, and a chain that comes back to its
   * start is closed. A chain consumer (`strokes`, the chain verbs) reads
   * these; the ink of `strokes(lines)` keeps its source instead. */
  curves():ProjectedChain[]{
    const toUser=this.#toUser;
    if(!toUser)throw new Error('projected lines: these were classified outside a view, so their drawable frame is unknown — read them inside a view callback');
    return chainRows(this.rows).map(chain=>({pts:chain.points.map(p=>toUser(p[0],p[1])),closed:chain.closed,indices:chain.rows}));
  }
  /** The closed chains, as areas: a silhouette that goes all the way round
   * is an outline `polygon` and `t.within` can read. */
  contours():ProjectedChain[]{return this.curves().filter(c=>c.closed);}
  /** Lines of any of these kinds (boundary, silhouette, crease, wire, section, hatch, intersection, mapped, trace, isoline, suggestive). */
  kind(...names:readonly FeatureKind[]):ProjectedCurves{return this.filter(row=>names.some(name=>row.kinds.has(name)));}
  /** Lines of none of these kinds. */
  except(...names:readonly FeatureKind[]):ProjectedCurves{return this.filter(row=>!names.some(name=>row.kinds.has(name)));}
  groupBy<K>(fn:(row:ProjectedCurve)=>K):readonly (ProjectedCurves&{readonly key:K})[]{const groups=new Map<K,ProjectedCurve[]>();for(const row of this.rows){const k=fn(row);const group=groups.get(k);if(group)group.push(row);else groups.set(k,[row]);}return Object.freeze([...groups].map(([key,rows])=>new ProjectedCurves(this.source,this.visibility,rows,key,this.#toUser) as ProjectedCurves&{readonly key:K}));}
}
export interface ProjectedLines {readonly visible:ProjectedCurves;readonly hidden:ProjectedCurves}
/** The classified lines of a view. `toUser` is the frame the view is drawn
 * in; lines made without one draw, but cannot answer `curves()`. */
export function projectedLines(source:ClassifiedScene3,toUser?:PaperToUser):ProjectedLines{return Object.freeze({visible:new ProjectedCurves(source,'visible',undefined,undefined,toUser),hidden:new ProjectedCurves(source,'hidden',undefined,undefined,toUser)});}
/** Snap a paper point to a key: ends that are the same world point project
 * to the same paper point up to rounding, far below a nib. */
const endKey=(p:readonly [number,number])=>`${Math.round(p[0]*1e6)},${Math.round(p[1]*1e6)}`;
/** Join intervals end to end: an end shared by exactly two intervals is
 * inside a chain; any other end is a chain's end. Rows keep their order in
 * the collection: each chain starts at the first row not yet taken. */
function chainRows(rows:readonly ProjectedCurve[]):{points:(readonly [number,number])[];closed:boolean;rows:number[]}[] {
  const at=new Map<string,number[]>(),ends:[string,string][]=[];
  rows.forEach((row,i)=>{
    const a=endKey(row.a),b=endKey(row.b);ends.push([a,b]);
    if(a===b)return;
    for(const k of [a,b]){const list=at.get(k);if(list)list.push(i);else at.set(k,[i]);}
  });
  const taken=new Uint8Array(rows.length),out:{points:(readonly [number,number])[];closed:boolean;rows:number[]}[]=[];
  // The row across a joint from `i`, when the joint joins exactly two.
  const across=(key:string,i:number):number|undefined=>{const list=at.get(key)!;return list.length===2?list[list[0]===i?1:0]:undefined;};
  const walk=(start:number,from:string):{points:(readonly [number,number])[];rows:number[];end:string}=>{
    const points:(readonly [number,number])[]=[],ids:number[]=[];let i:number|undefined=start,key=from;
    while(i!==undefined&&!taken[i]){
      taken[i]=1;ids.push(i);
      const forward=ends[i][0]===key,next=forward?ends[i][1]:ends[i][0];
      points.push(forward?rows[i].b:rows[i].a);
      key=next;i=across(key,i);
    }
    return {points,rows:ids,end:key};
  };
  // Open chains first, from their ends, so every chain is walked from one end.
  const order=[...rows.keys()].sort((i,j)=>{const e=(k:number)=>at.get(ends[k][0])?.length!==2||at.get(ends[k][1])?.length!==2?0:1;return e(i)-e(j)||i-j;});
  for(const i of order){
    if(taken[i]||ends[i][0]===ends[i][1])continue;
    const [a,b]=ends[i],fromA=at.get(a)!.length!==2,start=fromA||at.get(b)!.length===2?a:b;
    const first=start===a?rows[i].a:rows[i].b;
    const run=walk(i,start);
    out.push({points:[first,...run.points],closed:run.end===start&&at.get(start)!.length===2,rows:run.rows});
  }
  // A closed chain repeats its first point last; a ring lists each point once.
  for(const c of out)if(c.closed)c.points.pop();
  return out.sort((x,y)=>x.rows[0]-y.rows[0]);
}
export type ProjectedStrokeOptions=Omit<ShapeOpts,'strokeSeed'|'strokeRanges'|'preserveStroke'> & {readonly pass?:string};
export interface ProjectedStrokes {readonly __occludeProjectedStrokes:true;readonly curves:ProjectedCurves;readonly opts:ProjectedStrokeOptions}
/** Copy value objects while keeping physical-unit prototypes and pure fields. */
export function captureValue<T>(value:T):T {
  // A selection is already an immutable view of one revision.
  if(!value||typeof value!=='object'||value instanceof Collection)return value;
  const out=Array.isArray(value)?[]:Object.create(Object.getPrototypeOf(value));
  for(const key of Object.keys(value))Object.defineProperty(out,key,{value:captureValue((value as Record<string,unknown>)[key]),enumerable:true});
  return Object.freeze(out) as T;
}
export function projectedStrokes(curves:ProjectedCurves,opts:ProjectedStrokeOptions={}):ProjectedStrokes{return Object.freeze({__occludeProjectedStrokes:true,curves,opts:captureValue(opts)});}
export function isProjectedStrokes(value:unknown):value is ProjectedStrokes{return !!value&&typeof value==='object'&&(value as ProjectedStrokes).__occludeProjectedStrokes===true;}
export function emitProjectedStrokes(exec:Execution,intent:ProjectedStrokes,currentPen:string):ShapeValue[]{
  const {curves,opts}=intent;if(opts.stroke===false)return [];
  const pen=typeof opts.stroke==='string'?opts.stroke:opts.pen??currentPen;
  const selected=new Map<Feature3,Interval3[]>();
  for(const row of curves){const ranges=selected.get(row.feature)??[];ranges.push(row.range);selected.set(row.feature,ranges);}
  // Keep ALL source features in the reference graph; filtering only restricts
  // selected ranges. Otherwise a filter would reset dash phase at its new end.
  const runs=constructStrokes3(curves.source,[{id:'projected',stroke:pen,visibility:curves.visibility,ranges:feature=>selected.get(feature)??[]}]);
  const toUser=paperToUser(exec.frame),{pass,modifiers,...shapeOpts}=opts;
  return sourceStrokeShapes3(runs,p=>toUser(p[0],p[1]),{pass,modifiers}).map(shape=>({...shape,opts:{...shape.opts,...shapeOpts,preserveStroke:true,strokeSeed:shape.opts.strokeSeed,strokeRanges:shape.opts.strokeRanges,stroke:pen}}));
}
/** Every triangle that hides in a view, on the paper in user units and
 * turned one way round, so their nonzero union is the paper the view's solids
 * cover; triangles seen edge-on cover nothing and are left out. */
export function maskContours3(exec:Execution,view:ClassifiedScene3):[number,number][][]{
  const toUser=paperToUser(exec.frame),out:[number,number][][]=[];
  for(const triangle of view.occluders){
    const [a,b,c]=triangle.map(p=>{const q=toPaper3(view.frame,p);return toUser(q[0],q[1]);});
    const area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    if(area>0)out.push([a,b,c]);else if(area<0)out.push([a,c,b]);
  }
  return out;
}

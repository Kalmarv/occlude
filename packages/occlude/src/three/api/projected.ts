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
export type FeatureKind=keyof typeof FeatureKind3;
function kinds(flags:number):ReadonlySet<FeatureKind>{
  const set=new Set((Object.keys(FeatureKind3) as FeatureKind[]).filter(k=>(flags&FeatureKind3[k])!==0));
  const result:ReadonlySet<FeatureKind>=Object.freeze({size:set.size,has:(k:FeatureKind)=>set.has(k),keys:()=>set.keys(),values:()=>set.values(),entries:()=>set.entries(),[Symbol.iterator]:()=>set[Symbol.iterator](),forEach:(callback:(value:FeatureKind,key:FeatureKind,set:ReadonlySet<FeatureKind>)=>void,thisArg?:unknown)=>set.forEach(v=>callback.call(thisArg,v,v,result))});
  return result;
}
export interface ProjectedCurve {
  readonly id:string;readonly index:number;
  readonly instance?:Feature3['instance'];
  readonly feature:Feature3;readonly kinds:ReadonlySet<FeatureKind>;
  /** Local clipped source parameters; endpoints are physical paper millimeters. */
  readonly range:Interval3;readonly a:readonly [number,number];readonly b:readonly [number,number];
  readonly attributes:Feature3['attributes'];readonly faceAttributes:Feature3['faceAttributes'];readonly support:Feature3['support'];
}
/** Classified intervals with their full source retained through filtering. */
export class ProjectedCurves implements Iterable<ProjectedCurve> {
  readonly __occludeProjectedCurves=true;
  readonly rows:readonly ProjectedCurve[];readonly key:unknown;
  constructor(readonly source:ClassifiedScene3,readonly visibility:'visible'|'hidden',rows?:readonly ProjectedCurve[],key?:unknown){
    this.key=key;
    this.rows=Object.freeze(rows?[...rows]:source.features.flatMap(({feature,...ranges},index)=>ranges[visibility].map((range,i)=>Object.freeze({id:JSON.stringify([feature.id,visibility,i]),index,feature,...(feature.instance?{instance:feature.instance}:{}),kinds:kinds(feature.flags),range,a:Object.freeze(toPaper3(source.frame,lerp3(feature.a,feature.b,range[0]))),b:Object.freeze(toPaper3(source.frame,lerp3(feature.a,feature.b,range[1]))),attributes:feature.attributes,faceAttributes:feature.faceAttributes,support:feature.support}))));
    Object.freeze(this);
  }
  get length():number{return this.rows.length;}
  [Symbol.iterator]():IterableIterator<ProjectedCurve>{return this.rows[Symbol.iterator]();}
  map<T>(fn:(row:ProjectedCurve,index:number)=>T):T[]{return this.rows.map(fn);}
  filter(fn:(row:ProjectedCurve,index:number)=>boolean):ProjectedCurves{return new ProjectedCurves(this.source,this.visibility,this.rows.filter(fn),this.key);}
  /** Lines of any of these kinds (boundary, silhouette, crease, wire, section, hatch, intersection, mapped, trace, isoline). */
  kind(...names:readonly FeatureKind[]):ProjectedCurves{return this.filter(row=>names.some(name=>row.kinds.has(name)));}
  /** Lines of none of these kinds. */
  except(...names:readonly FeatureKind[]):ProjectedCurves{return this.filter(row=>!names.some(name=>row.kinds.has(name)));}
  groupBy<K>(fn:(row:ProjectedCurve)=>K):readonly (ProjectedCurves&{readonly key:K})[]{const groups=new Map<K,ProjectedCurve[]>();for(const row of this.rows){const k=fn(row);const group=groups.get(k);if(group)group.push(row);else groups.set(k,[row]);}return Object.freeze([...groups].map(([key,rows])=>new ProjectedCurves(this.source,this.visibility,rows,key) as ProjectedCurves&{readonly key:K}));}
}
export interface ProjectedLines {readonly visible:ProjectedCurves;readonly hidden:ProjectedCurves}
export function projectedLines(source:ClassifiedScene3):ProjectedLines{return Object.freeze({visible:new ProjectedCurves(source,'visible'),hidden:new ProjectedCurves(source,'hidden')});}
export type ProjectedStrokeOptions=Omit<ShapeOpts,'strokeSeed'|'strokeRanges'|'preserveStroke'> & {readonly pass?:string};
export interface ProjectedStrokes {readonly __occludeProjectedStrokes:true;readonly curves:ProjectedCurves;readonly opts:ProjectedStrokeOptions}
/** Copy value objects while keeping physical-unit prototypes and pure fields. */
export function captureValue<T>(value:T):T {
  if(!value||typeof value!=='object')return value;
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

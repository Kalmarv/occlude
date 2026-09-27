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
import {ROW_TYPES,Selection,select,domainKind,isSelectionOf,rowRange,type Domain,type DomainKind,type Types} from '../../selection.js';
import {describe} from '../../views.js';
import {Material,withinMaterial} from '../../material.js';
import type {AreaInput} from '../../boundary.js';
import type {IsoContour} from '../../isolines.js';
import {curvesOf,materialOfChains,type Curve} from '../../curves.js';
export type FeatureKind=keyof typeof FeatureKind3;
const kindSets=new Map<number,ReadonlySet<FeatureKind>>();
function kinds(flags:number):ReadonlySet<FeatureKind>{
  const cached=kindSets.get(flags);if(cached)return cached;
  const set=new Set((Object.keys(FeatureKind3) as FeatureKind[]).filter(k=>(flags&FeatureKind3[k])!==0));
  const result:ReadonlySet<FeatureKind>=Object.freeze({size:set.size,has:(k:FeatureKind)=>set.has(k),keys:()=>set.keys(),values:()=>set.values(),entries:()=>set.entries(),[Symbol.iterator]:()=>set[Symbol.iterator](),forEach:(callback:(value:FeatureKind,key:FeatureKind,set:ReadonlySet<FeatureKind>)=>void,thisArg?:unknown)=>set.forEach(v=>callback.call(thisArg,v,v,result))});
  kindSets.set(flags,result);
  return result;
}
/** @internal What a selection of projected lines answers (see `ROW_TYPES`):
 * the chains and areas they make on the paper, and the kind words. */
export type ProjectedCurveTypes=Types<{
  owner:ClassifiedScene3;curves:Selection<Curve>;contours:()=>IsoContour[];
  kind:(...names:readonly FeatureKind[])=>Selection<ProjectedCurve>;except:(...names:readonly FeatureKind[])=>Selection<ProjectedCurve>;
}>;
export interface ProjectedCurveRow {
  readonly index:number;
  readonly instance?:Feature3['instance'];
  readonly feature:Feature3;readonly kinds:ReadonlySet<FeatureKind>;
  /** Local clipped source parameters; endpoints are physical paper millimeters. */
  readonly range:Interval3;readonly a:readonly [number,number];readonly b:readonly [number,number];
  /** The columns of the faces the line lies on, one record a face. */
  readonly faceColumns:Feature3['faceAttributes'];readonly support:Feature3['support'];
  readonly [ROW_TYPES]?:ProjectedCurveTypes;
}
/** One classified interval. Its source's columns read as properties
 * (`c.rim`), as on every other row. */
export type ProjectedCurve=ProjectedCurveRow&{readonly [column:string]:unknown};
/** Paper millimetres to the drawable units of the sketch the view is drawn in. */
export type PaperToUser=(x:number,y:number)=>[number,number];

// ─── the lines as a selection domain ──────────────────────────────────

/** A number per classification, so the key of a line names nothing in the
 * lines of another view (another camera classifies other intervals). */
const serials=new WeakMap<ClassifiedScene3,number>();
let nextSerial=0;
/** Which domain, and which row, each line row was made in. A line a cut
 * keeps whole is the same row object in the cut, found there by its key. */
const homes=new WeakMap<object,{readonly domain:LineRows;readonly row:number}>();
/**
 * The classified intervals of one visibility of one view: the rows `lines.visible`
 * and `lines.hidden` are selections of, and the rows of a cut of them. The
 * scene is the domain's, never the members': strokes keep every feature of it
 * in the reference graph, so a filter, a group or a cut restricts the ranges
 * drawn and never restarts a dash at a new end.
 */
class LineRows implements Domain<ProjectedCurve> {
  readonly kind:DomainKind=LINES;readonly dense=true;
  #all:readonly number[]|null=null;
  #keys:readonly string[]|null=null;
  #rows:ReadonlyMap<string,number>|null=null;
  /** `names` spells every row's key, in row order, the first time one is asked for. */
  constructor(readonly owner:ClassifiedScene3,readonly visibility:'visible'|'hidden',readonly table:readonly ProjectedCurve[],private readonly names:()=>readonly string[],readonly toUser?:PaperToUser){
    table.forEach((row,r)=>{if(!homes.has(row))homes.set(row,{domain:this,row:r});});
  }
  get size():number{return this.table.length;}
  all():readonly number[]{return (this.#all??=rowRange(this.table.length));}
  valid(r:number):boolean{return Number.isInteger(r)&&r>=0&&r<this.table.length;}
  row(r:number):ProjectedCurve{return this.table[r];}
  /** Who a line is: the view, the visibility, its feature and which of the
   * feature's intervals; a cut piece is its line's key and its piece number. */
  keyOf(r:number):string{return (this.#keys??=this.names())[r];}
  rowOfKey(key:unknown):number{return (this.#rows??=new Map((this.#keys??=this.names()).map((k,r)=>[k,r]))).get(key as string)??-1;}
  locate(v:unknown,who:string):{domain:LineRows;row:number}|null{
    if(v===undefined||v===null)return null;
    const home=typeof v==='object'?homes.get(v):undefined;
    if(home===undefined)throw new Error(`${who}: expected a line of a view, got ${describe(v)}`);
    return home;
  }
  /** Lines of one view and one visibility, and the cuts of them. */
  shares(other:Domain<ProjectedCurve>):boolean{return other instanceof LineRows&&other.owner===this.owner&&other.visibility===this.visibility;}
}
type LineSel=Selection<ProjectedCurve>;
const rowsOf=(sel:LineSel):LineRows=>sel.domain as LineRows;
/** The lines as chains in drawable units: intervals that meet end to end,
 * two at a point, join into one chain, and a chain that comes back to its
 * start is closed. Made on the first read and kept on the selection. */
function chainMaterial(sel:LineSel):Material{
  const box=sel.box as {curves?:Material};
  if(box.curves)return box.curves;
  const toUser=rowsOf(sel).toUser;
  if(!toUser)throw new Error('projected lines: these were classified outside a view, so their drawable frame is unknown — read them inside a view callback');
  return box.curves=materialOfChains(chainRows([...sel]).map(chain=>({pts:chain.points.map(p=>toUser(p[0],p[1])),closed:chain.closed})));
}
const LINES:DomainKind=domainKind('line','lines',{
  /** Lines of any of these kinds (boundary, silhouette, crease, wire, section, hatch, intersection, mapped, trace, isoline, suggestive). */
  kind:{value(this:LineSel,...names:readonly FeatureKind[]):LineSel{return this.filter(row=>names.some(name=>row.kinds.has(name)));}},
  /** Lines of none of these kinds. */
  except:{value(this:LineSel,...names:readonly FeatureKind[]):LineSel{return this.filter(row=>!names.some(name=>row.kinds.has(name)));}},
  /** The chains the members make on the paper, in drawable units. A chain
   * consumer (`strokes`, the chain verbs) reads these; the ink of
   * `strokes(lines)` keeps its source instead. */
  curves:{get(this:LineSel):Selection<Curve>{return curvesOf(chainMaterial(this));}},
  /** The closed chains, as areas: a silhouette that goes all the way round
   * is an outline `polygon` and `t.within` can read. */
  contours:{value(this:LineSel):IsoContour[]{return chainMaterial(this).contours();}},
  /** Refused by name: the lines' own words for where they came from. */
  source:{get(this:LineSel):never{throw new Error('lines.source: a selection has no source — each line says where it came from (c.feature), and the numbers of the view that classified it are lines.stats');}},
},{
  set:'projected lines are classified by the view — they hold no columns to set; a line reads its source\'s',
  adjacent:'lines meet at joints on the paper — lines.curves joins them into chains',
  connected:'lines meet at joints on the paper — lines.curves joins them into chains',
  components:'lines meet at joints on the paper — lines.curves joins them into chains',
  unrelated:'that line belongs to another view or the other visibility — the lines of one view name nothing in another',
});
/** Is `value` a selection of projected lines? */
export function isProjectedCurves(value:unknown):value is Selection<ProjectedCurve>{return isSelectionOf(value,LINES);}
/** The lines of one view, and the numbers of the classification behind them. */
export interface ProjectedLines {readonly visible:Selection<ProjectedCurve>;readonly hidden:Selection<ProjectedCurve>;readonly stats:ClassifiedScene3['stats']}
/** A line's share of the columns its edge distributes: over `range` of
 * the feature, which covers `feature.range` of the edge, it holds that part
 * of the edge's length. Empty when the edge distributes none. */
function shares(feature:Feature3,range:Interval3):Readonly<Record<string,unknown>>{
  const names=feature.distribute;
  if(names===undefined)return {};
  const part=(range[1]-range[0])*(feature.range[1]-feature.range[0]),out:Record<string,unknown>={};
  for(const name of names){
    const v=feature.attributes[name];
    out[name]=typeof v==='number'?v*part:Array.isArray(v)?Object.freeze(v.map(x=>(x as number)*part)):v;
  }
  return out;
}
/** The classified lines of a view. `toUser` is the frame the view is drawn
 * in; lines made without one draw, but cannot answer `curves`. */
export function projectedLines(source:ClassifiedScene3,toUser?:PaperToUser):ProjectedLines{
  const serial=serials.get(source)??nextSerial++;serials.set(source,serial);
  const lines=(visibility:'visible'|'hidden'):Selection<ProjectedCurve>=>{
    const table:ProjectedCurve[]=[];
    // The record is read by field rather than rest-destructured, which saves
    // an object per feature.
    source.features.forEach((record,index)=>{
      const feature=record.feature;
      for(const range of record[visibility])table.push(Object.freeze({
        ...feature.attributes,...shares(feature,range),
        index,feature,...(feature.instance?{instance:feature.instance}:{}),kinds:kinds(feature.flags),range,
        a:Object.freeze(toPaper3(source.frame,lerp3(feature.a,feature.b,range[0]))),
        b:Object.freeze(toPaper3(source.frame,lerp3(feature.a,feature.b,range[1]))),
        faceColumns:feature.faceAttributes,support:feature.support,
      }) as ProjectedCurve);
    });
    // A key is identity, never content, and most lines are never asked for
    // theirs: they are spelled on the first ask, all at once.
    const names=()=>source.features.flatMap(record=>record[visibility].map((_,i)=>`${serial}|${visibility}|${JSON.stringify([record.feature.id,i])}`));
    return select(new LineRows(source,visibility,Object.freeze(table),names,toUser),null);
  };
  return Object.freeze({visible:lines('visible'),hidden:lines('hidden'),stats:source.stats});
}
/**
 * Projected lines cut by an area with the material cut — `t.within` of a
 * material, the same insideness and crossings: a line whose chord lies inside
 * is kept as it is, and a line that crosses the boundary is cut into the
 * pieces inside, each a line of the same feature over part of the old line's
 * range. The scene is kept, as `filter` keeps it, so the ink of a kept piece
 * is the ink of the same stretch uncut. A cut keeps the lines' order, and a
 * line's pieces in order along it; a group keeps its key.
 *
 * Each line is an edge of its own, between two vertices of its own, so the
 * cut's topology — cut points shared across edges, faces closed along the
 * boundary — has nothing to join. A piece is found on the paper chord, and
 * its range is read back through the camera: under perspective a line's
 * paper parameter is a projective function of its source parameter, fixed
 * by the ends and the middle.
 */
export function withinLines(lines:Selection<ProjectedCurve>,area:AreaInput,cut:Pick<NonNullable<Parameters<typeof withinMaterial>[2]>,'inside'|'crossings'>,toUser:PaperToUser):Selection<ProjectedCurve>{
  const d=rowsOf(lines),rows=[...lines],n=rows.length;
  const x=new Float64Array(2*n),y=new Float64Array(2*n),ends=new Uint32Array(2*n),line=new Float64Array(n);
  rows.forEach((row,k)=>{
    [x[2*k],y[2*k]]=toUser(row.a[0],row.a[1]);[x[2*k+1],y[2*k+1]]=toUser(row.b[0],row.b[1]);
    ends[2*k]=2*k;ends[2*k+1]=2*k+1;line[k]=k;
  });
  const kept=withinMaterial(new Material(x,y,{},ends,{edgeAttrs:{line}}),area,cut);
  // The pieces of each line, as chord parameters: an end that is the line's
  // own end is 0 or 1 exactly, a cut end is where it lies along the chord.
  const pieces=rows.map(():[number,number][]=>[]);
  const of=kept.edgeAttrs.line,L=kept.edgeList,X=kept.x,Y=kept.y;
  for(let e=0;e<kept.edgeCount;e++){
    const k=of[e],ax=x[2*k],ay=y[2*k],dx=x[2*k+1]-ax,dy=y[2*k+1]-ay;
    const along=(v:number,own:0|1):number=>X[v]===x[2*k+own]&&Y[v]===y[2*k+own]?own:((X[v]-ax)*dx+(Y[v]-ay)*dy)/(dx*dx+dy*dy);
    pieces[k].push([along(L[2*e],0),along(L[2*e+1],1)]);
  }
  const table:ProjectedCurve[]=[],from:number[]=[],piece:number[]=[];
  rows.forEach((row,k)=>{
    const own=pieces[k];
    if(own.length===1&&own[0][0]===0&&own[0][1]===1){table.push(row);from.push(lines.rowAt(k));piece.push(-1);return;}
    // The chord parameter u of the source parameter's fraction s is
    // u = k·s / (1 + (k − 1)·s), with k fixed by where the source middle lands.
    const [r0,r1]=row.range,f=row.feature;
    const m=toPaper3(d.owner.frame,lerp3(f.a,f.b,(r0+r1)/2));
    const dx=row.b[0]-row.a[0],dy=row.b[1]-row.a[1];
    const um=((m[0]-row.a[0])*dx+(m[1]-row.a[1])*dy)/(dx*dx+dy*dy),q=um/(1-um);
    const sourceAt=(u:number):number=>r0+(r1-r0)*(u===0||u===1||q===1?u:u/(q-(q-1)*u));
    const paper=(u:number):readonly [number,number]=>Object.freeze([row.a[0]+dx*u,row.a[1]+dy*u] as const);
    own.forEach(([u0,u1],i)=>{
      const range=Object.freeze([sourceAt(u0),sourceAt(u1)] as const);
      table.push(Object.freeze({...row,...shares(f,range),range,a:u0===0?row.a:paper(u0),b:u1===1?row.b:paper(u1)}) as ProjectedCurve);
      from.push(lines.rowAt(k));piece.push(i);
    });
  });
  const names=()=>from.map((r,j)=>piece[j]<0?d.keyOf(r):`${d.keyOf(r)}#${piece[j]}`);
  return select(new LineRows(d.owner,d.visibility,Object.freeze(table),names,toUser),null,lines.key);
}
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
/** Lines to draw: the lines, the view that classified them — whose features
 * all anchor the strokes — and the options. */
export interface ProjectedStrokes {readonly __occludeProjectedStrokes:true;readonly curves:Selection<ProjectedCurve>;readonly scene:ClassifiedScene3;readonly opts:ProjectedStrokeOptions}
/** Copy value objects while keeping physical-unit prototypes and pure fields. */
export function captureValue<T>(value:T):T {
  // A selection is already an immutable view of one revision.
  if(!value||typeof value!=='object'||value instanceof Selection)return value;
  const out=Array.isArray(value)?[]:Object.create(Object.getPrototypeOf(value));
  for(const key of Object.keys(value))Object.defineProperty(out,key,{value:captureValue((value as Record<string,unknown>)[key]),enumerable:true});
  return Object.freeze(out) as T;
}
export function projectedStrokes(curves:Selection<ProjectedCurve>,opts:ProjectedStrokeOptions={}):ProjectedStrokes{return Object.freeze({__occludeProjectedStrokes:true,curves,scene:rowsOf(curves).owner,opts:captureValue(opts)});}
export function isProjectedStrokes(value:unknown):value is ProjectedStrokes{return !!value&&typeof value==='object'&&(value as ProjectedStrokes).__occludeProjectedStrokes===true;}
export function emitProjectedStrokes(exec:Execution,intent:ProjectedStrokes,currentPen:string):ShapeValue[]{
  const {curves,scene,opts}=intent;if(opts.stroke===false)return [];
  const pen=typeof opts.stroke==='string'?opts.stroke:opts.pen??currentPen;
  const selected=new Map<Feature3,Interval3[]>();
  for(const row of curves){const ranges=selected.get(row.feature)??[];ranges.push(row.range);selected.set(row.feature,ranges);}
  // Keep ALL source features in the reference graph; filtering only restricts
  // selected ranges. Otherwise a filter would reset dash phase at its new end.
  const runs=constructStrokes3(scene,[{id:'projected',stroke:pen,visibility:rowsOf(curves).visibility,ranges:feature=>selected.get(feature)??[]}]);
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

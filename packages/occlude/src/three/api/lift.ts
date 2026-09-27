import type {Attributes3,Attribute3} from '../geometry/surface.js';
import {chainRecordOf,chainRecordsOf,isCurveRow,type ChainRecord} from '../../curves.js';

/** 2D values read by the 3D doors. A 2D point is a 3D point at z = 0 and a
 * 2D chain is an XY profile; each keeps its id and its columns. The doors
 * read the accessor protocol (`curves` for chains, `points` for rows), so
 * a pure 3D kernel never lowers a shape: a shape is refused by name with the
 * toolkit door to use. */

/** One vertex of a 2D value, as the 3D side keeps it. */
export interface Lifted2 {readonly id:string;readonly x:number;readonly y:number;readonly attributes:Attributes3}

const isShape=(v:unknown)=>!!v&&typeof v==='object'&&'__occludeShape' in v;
function refuseShape(value:unknown,who:string):void {
  if(isShape(value))throw new Error(`${who}: a shape is not geometry until the toolkit lowers it — give t.material(shape) or t.sample(shape, { count })`);
}
/** A 2D id, spelled as a 3D id. */
const id2=(id:unknown,fallback:number)=>id===undefined?`2d:p${fallback}`:`2d:${String(id)}`;
/** A 2D row's columns: its own numeric properties other than the position. */
function columns(row:Record<string,unknown>):Attributes3 {
  const out:Record<string,Attribute3>={};
  for(const [name,value] of Object.entries(row))if(name!=='x'&&name!=='y'&&name!=='index'&&(typeof value==='number'||typeof value==='string'||typeof value==='boolean'))out[name]=value;
  return out;
}
const isPair=(v:unknown):v is readonly [number,number]=>Array.isArray(v)&&v.length===2&&typeof v[0]==='number'&&typeof v[1]==='number';
const isRecord2=(v:unknown):v is {x:number;y:number;z?:undefined}=>!!v&&typeof v==='object'&&!Array.isArray(v)&&typeof (v as {x?:unknown}).x==='number'&&typeof (v as {y?:unknown}).y==='number'&&(v as {z?:unknown}).z===undefined;

/** 3D space is flat. A chain of a curved sketch space has coordinates that
 * are not lengths there, so lifting it would build a solid from a picture
 * of the chain, not from the chain: refused by name. */
function refuseCurved(value:object,who:string):void {
  const owner=isCurveRow(value)?(value as {points:{source?:unknown}}).points.source:value;
  const space=owner&&typeof owner==='object'?(owner as {space?:{kind?:string}}).space:undefined;
  if(space&&space.kind!=='euclidean')throw new Error(`${who}: this chain lives in the sketch's ${space.kind} space, and 3D space is flat — a 3D profile needs flat coordinates: build it with material(points) or with [x, y, z] positions`);
}
/** True when `value` is a 2D chain source: it answers `curves`, or it is
 * one curve row. */
export function isChain2(value:unknown):value is {readonly curves:unknown} {
  return !!value&&typeof value==='object'&&('curves' in value||isCurveRow(value));
}
/** The one chain a 2D value answers with `curves` (or the one curve row
 * it is), its vertices lifted with ids and columns from the geometry's
 * `points` rows. */
export function chain2(value:unknown,who:string):{readonly points:readonly Lifted2[];readonly closed:boolean} {
  refuseShape(value,who);
  if(!isChain2(value))throw new Error(`${who}: expected a chain — a 2D value that answers curves, such as a material, or one curve (m.curves.at(i))`);
  refuseCurved(value,who);
  let chain:ChainRecord,rows:{at?(i:number):unknown}|undefined;
  if(isCurveRow(value)){
    chain=chainRecordOf(value);
    rows=(value.points.source as {points?:{at?(i:number):unknown}}).points;
  }else{
    const chains=chainRecordsOf(value)??[];
    if(chains.length!==1)throw new Error(`${who}: this value has ${chains.length} chains, and a profile is one — pick one: m.curves.at(i) is one curve, or split the material first`);
    chain=chains[0];rows=(value as {points?:{at?(i:number):unknown}}).points;
  }
  const points=chain.pts.map((p,k)=>{
    const index=chain.indices?.[k],row=index!==undefined&&typeof rows?.at==='function'?rows.at(index) as Record<string,unknown>|undefined:undefined;
    return Object.freeze({id:id2(row?.id,index??k),x:p[0],y:p[1],attributes:row?columns(row):{}});
  });
  return {points,closed:chain.closed};
}
/** 2D points lifted to z = 0: a point collection or a selection (anything
 * iterable of `{x, y}` rows), a value that holds one (`points`), or
 * `[x, y]` pairs. Undefined when `value` is not 2D points. */
export function points2(value:unknown,who:string):readonly Lifted2[]|undefined {
  refuseShape(value,who);
  if(!value||typeof value!=='object')return undefined;
  const held=(value as {points?:unknown}).points;
  const source:unknown=Array.isArray(value)?value:held&&typeof held==='object'&&typeof (held as Iterable<unknown>)[Symbol.iterator]==='function'?held:typeof (value as Iterable<unknown>)[Symbol.iterator]==='function'?value:undefined;
  if(source===undefined)return undefined;
  const rows=[...(source as Iterable<unknown>)];
  if(!rows.every(r=>isPair(r)||isRecord2(r)))return undefined;
  return rows.map((r,i)=>isPair(r)?Object.freeze({id:id2(undefined,i),x:r[0],y:r[1],attributes:{}}):Object.freeze({id:id2((r as {id?:unknown}).id,i),x:(r as {x:number}).x,y:(r as {y:number}).y,attributes:columns(r as Record<string,unknown>)}));
}

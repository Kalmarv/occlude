/**
 * `source`: what a 3D row came from, in its natural shape.
 *
 * A derivation (subdivide, extrude, a boolean, dual, sweep, revolve,
 * realize, a scatter on a surface, `along` and `resample` on a curve) keeps
 * the values it read, internally, on the value it answers. Each row it makes
 * carries an internal lineage record: the ids of the rows it came from in
 * those inputs. `row.source` reads that record against the inputs:
 *
 * - one row of one input: that row;
 * - several rows of one domain of one input: a selection of them;
 * - rows of two inputs (a sweep point is a profile point carried to a path
 *   point): a list, one answer per input, in the order the operation takes
 *   them.
 *
 * A row the derivation kept as it was (an uncut face of a boolean, an
 * extrusion's cap) has no lineage record and is its own row in the input.
 * A value no derivation made (a primitive, an import) answers no source.
 *
 * Ids stay internal: a sketch reads rows, never the ids that join them.
 * The inputs ride on the value under a symbol, so a value built from
 * `{ ...this }` (a column write, a move, a transform, `withKey`) keeps them,
 * and the source survives a `set` or a move of the result.
 */

import type {Surface3,Provenance3} from '../geometry/surface.js';

/** What `row.source` answers: a row of an input, a selection of one
 * input's rows, or a list with one of those per input. Read it as the row
 * or selection the operation's reference says it is. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Source3=any;
/** @internal The inputs a derivation read, on the value it answered. */
export const SOURCES:unique symbol=Symbol('sources');
/** @internal What a derivation keeps: its name, which its rows' lineage
 * records carry, and the values it read. */
export interface SourceRecord {readonly operation:string;readonly inputs:readonly object[]}
/** @internal A constructor option: the derivation that made the value. */
export interface Sourced {readonly [SOURCES]?:SourceRecord}
/** @internal The record of one derivation. */
export const derived=(operation:string,...inputs:object[]):SourceRecord=>Object.freeze({operation,inputs:Object.freeze(inputs)});

const registry=new WeakMap<Surface3,SourceRecord>();
/** @internal Keep the record of a derivation beside the surface it made. */
export function recordSources(owner:object,surface:Surface3,record:SourceRecord|undefined):void {
  if(!record||!record.inputs.length)return;
  registry.set(surface,record);
  Object.defineProperty(owner,SOURCES,{value:record,enumerable:true});
}

interface Found {readonly group:string;readonly selection:{rows(rows:Iterable<object>):unknown};readonly row:object}
/** The domains an input answers, and how its row ids are spelled here: a 2D
 * row is lifted to 3D as `2d:<id>` (lift.ts). Read structurally, so this
 * module needs none of the classes it reads. */
function domainsOf(input:object):{readonly names:readonly string[];readonly prefix:string} {
  if('prototype' in input&&'instances' in input)return {names:['instances'],prefix:''};
  if('corners' in input&&'surface' in input)return {names:['points','edges','faces','corners'],prefix:''};
  if('segments' in input&&'surface' in input)return {names:['points','edges'],prefix:''};
  if('network' in input)return {names:['points','edges'],prefix:''};
  if('surface' in input)return {names:['points'],prefix:''};
  return {names:['points'],prefix:'2d:'};
}
const indexes=new WeakMap<object,Map<string,Found>>();
function indexOf(input:object):Map<string,Found> {
  let index=indexes.get(input);
  if(index)return index;
  index=new Map();
  const {names,prefix}=domainsOf(input);
  names.forEach(name=>{
    const selection=(input as Record<string,unknown>)[name] as ({rows(rows:Iterable<object>):unknown}&Iterable<{readonly id?:unknown}>)|undefined;
    if(!selection||typeof (selection as Iterable<unknown>)[Symbol.iterator]!=='function')return;
    const group=`${name}`;
    for(const row of selection){
      const id=row.id===undefined?undefined:`${prefix}${String(row.id)}`;
      if(id!==undefined&&!index!.has(id))index!.set(id,{group,selection,row});
    }
  });
  indexes.set(input,index);
  return index;
}
const answers=new WeakMap<object,unknown>();
/** @internal What a row came from (see the module note), or undefined. */
export function sourceOf(surface:Surface3,row:object,own:{readonly id:string;readonly provenance?:Provenance3}):unknown {
  if(answers.has(row))return answers.get(row);
  const record=registry.get(surface);
  let answer:unknown;
  if(record){
    const inputs=record.inputs;
    const groups:{input:object;group:string;selection:Found['selection'];rows:object[]}[]=[];
    // A lineage record of this derivation names the rows it came from; a
    // row with none, or with an older derivation's, was kept as it was.
    const parents=own.provenance&&own.provenance.operation===record.operation?own.provenance.parents:[own.id];
    const where=own.provenance&&own.provenance.operation===record.operation?own.provenance.inputs:undefined;
    parents.forEach((id,k)=>{
      // A parent named with its input is looked for there only: two inputs
      // may use the same ids.
      for(const input of where?[inputs[where[k]]].filter(Boolean):inputs){
        const found=indexOf(input).get(id);
        if(!found)continue;
        let g=groups.find(x=>x.input===input&&x.group===found.group);
        if(!g){g={input,group:found.group,selection:found.selection,rows:[]};groups.push(g);}
        if(!g.rows.includes(found.row))g.rows.push(found.row);
        break;
      }
    });
    const one=(g:typeof groups[number])=>g.rows.length===1?g.rows[0]:g.selection.rows(g.rows);
    answer=groups.length===0?undefined:groups.length===1?one(groups[0]):Object.freeze(groups.map(one));
  }
  answers.set(row,answer);
  return answer;
}
/** @internal Give a row its `source`, read on first ask. */
export function withSource<T extends object>(row:T,surface:Surface3,own:{readonly id:string;readonly provenance?:Provenance3}):T {
  Object.defineProperty(row,'source',{get(){return sourceOf(surface,row,own);},enumerable:false});
  return row;
}

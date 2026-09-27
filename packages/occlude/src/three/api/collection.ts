import type {Attribute3} from '../geometry/surface.js';
import {attributeName,columnKind,describe3,isPlainRecord,POSITION3,type ColumnWriter} from './columns.js';
import {Selection,select,domainKind,rowRange,type Domain,type DomainKind} from '../../selection.js';

/** The row domains of 3D geometry. */
export type Domain3='point'|'edge'|'face'|'corner'|'instance'|'curve';
const owners=new WeakMap<object,{source:object;domain:Domain3;index:number}>();
const registered=new WeakMap<readonly object[],{source:object;domain:Domain3}>();
const byId=new WeakMap<readonly object[],ReadonlyMap<string,number>>();
/** The collection a revision holds for a domain: `mesh.faces`, `mesh.points`, … */
const accessors:Record<Domain3,string>={point:'points',edge:'edges',face:'faces',corner:'corners',instance:'instances',curve:'curves'};

/** The rows a write names among a selection's: a selection of the same
 * domain (of this revision, or another one read by id), one row (of any
 * revision), or a predicate over the rows as they were before the write. */
export type Where3<Row>=Selection<any>|{readonly id:string;readonly index:number}|{bivariant(row:Row):unknown}['bivariant']|undefined;

/** What a 3D table knows beyond its rows: what `extract()` makes of some
 * of them, how a write lands, which rows neighbour which, and how far a
 * place is from a row. */
export interface Table3Options {
  readonly extract:(rows:readonly number[])=>unknown;
  /** The geometry that holds these rows as stored columns, and lands a
   * write on them; derived rows have none. */
  readonly write?:ColumnWriter;
  readonly neighbours?:(row:number)=>readonly number[];
  readonly near?:(p:unknown,radius:number,who:string)=>{readonly rows:readonly number[];readonly distances:ArrayLike<number>};
}

/**
 * The rows of one domain of one 3D revision, as a selection domain: a
 * frozen table of rows, each carrying its `id`, so a row of another
 * revision of the same domain is found here by id. The model shape every
 * other domain now shares (selection.ts).
 */
export class Table3<Row extends {readonly id:string;readonly index:number}> implements Domain<Row> {
  readonly dense=true;
  readonly neighbours?:(row:number)=>readonly number[];
  readonly near?:Table3Options['near'];
  private allRows:readonly number[]|null=null;
  constructor(readonly kind:DomainKind,readonly source:object,readonly name:Domain3,readonly table:readonly Row[],readonly options:Table3Options){
    const rowOwner=registered.get(table);
    if(rowOwner&&(rowOwner.source!==source||rowOwner.domain!==name))throw new Error('collection rows belong to another source revision or domain');
    if(!rowOwner){
      table.forEach((row,index)=>{
        const owner=owners.get(row);
        if(owner&&(owner.source!==source||owner.domain!==name||owner.index!==index))throw new Error('collection rows belong to another source revision or domain');
        owners.set(row,{source,domain:name,index});
      });
      registered.set(table,{source,domain:name});
    }
    if(options.neighbours)this.neighbours=options.neighbours;
    if(options.near)this.near=options.near;
  }
  get size():number{return this.table.length;}
  all():readonly number[]{return (this.allRows??=rowRange(this.table.length));}
  valid(r:number):boolean{return Number.isInteger(r)&&r>=0&&r<this.table.length;}
  row(r:number):Row{return this.table[r];}
  /** This revision's row index for every id, built once per row table. */
  ids():ReadonlyMap<string,number>{
    let ids=byId.get(this.table);
    if(!ids){ids=new Map(this.table.map((row,i)=>[row.id,i]));byId.set(this.table,ids);}
    return ids;
  }
  /** A row of this revision by position; a row of another revision of the
   * same domain by its id (-1 when gone). A copy, or a row of another
   * domain, is refused by name. */
  rowOf(v:unknown,who:string):number{
    const owner=typeof v==='object'&&v!==null?owners.get(v):undefined;
    if(!owner)throw new Error(`${who}: expected a ${this.name} row, got ${describe3(v)}`);
    if(owner.domain!==this.name)throw new Error(`${who}: expected a ${this.name} row, got a ${owner.domain} row`);
    if(owner.source===this.source)return owner.index;
    return this.ids().get((v as Row).id)??-1;
  }
  resolve(other:Selection<any>,who:string):number[]{
    const d=other.domain;
    if(!(d instanceof Table3)||d.name!==this.name)throw new Error(`${who}: selection set operations require the same domain (${this.name}s, got ${d instanceof Table3?d.name+'s':d.kind.plural})`);
    if(d.source===this.source)return [...other.indices];
    const ids=this.ids(),out:number[]=[];
    for(const row of other as Selection<Row>){const i=ids.get(row.id);if(i!==undefined)out.push(i);}
    return out;
  }
  /** The same domain on another revision: the geometry that holds it (a
   * mesh, curve or point geometry — its `faces`, `edges`, `points`,
   * `corners` or `instances`). */
  on(state:unknown,who:string):Domain<Row>{
    if(state===null||typeof state!=='object')throw new Error(`${who}: expected a geometry or a ${this.name} selection to resolve against, got ${state===null?'null':typeof state}`);
    const name=accessors[this.name];
    if(!(name in state))throw new Error(`${who}: that value has no ${name}; pass the geometry the selection should be read on`);
    const target=(state as Record<string,unknown>)[name];
    if(!(target instanceof Selection))throw new Error(`${who}: that value's ${name} is not a selection`);
    if(!(target.domain instanceof Table3)||target.domain.name!==this.name)throw new Error(`${who}: expected ${this.name}s, got ${target.domain.kind.plural}`);
    return target.domain as Domain<Row>;
  }
}

/** Is `v` a selection of 3D rows — of one domain when `name` is given? */
export function isSelection3(v:unknown,name?:Domain3):v is Selection<any>{
  return v instanceof Selection&&v.domain instanceof Table3&&(name===undefined||v.domain.name===name);
}

type Sel3=Selection<any>&{readonly domain:Table3<any>};

/** The words every 3D kind has: its one write and extraction. */
const TABLE3_WORDS={
  /** Independent geometry of these rows, every column and id kept. */
  extract:{value(this:Sel3):unknown{return this.domain.options.extract(this.indices);}},
  /** The one write: `(column, value, where?, opts?)` or
   * `({ column: value, … }, where?, opts?)`, over these rows or the ones
   * `where` names among them. */
  set:{value(this:Sel3,...args:unknown[]):unknown{return write3(this,args);}},
};

/** A 3D kind: the shared words and its own. */
export function kind3(name:Domain3,words:Record<string,PropertyDescriptor&ThisType<Sel3>>={}):DomainKind{
  return domainKind(name,`${name}s`,{...TABLE3_WORDS,...words});
}

/** A selection of `rows` (null: all, row order) of a 3D domain. */
export function select3<Row extends {readonly id:string;readonly index:number}>(domain:Table3<Row>,rows:readonly number[]|null=null,key?:unknown):Selection<Row>{
  return select(domain as Domain<Row>,rows,key) as Selection<Row>;
}

const domainCache=new WeakMap<object,Map<string,Table3<any>>>();
/** The domain `slot` of a geometry value, made once per value: every
 * selection of it shares one domain, so two reads of `g.points` are the
 * same rows. */
export function domainOf<Row extends {readonly id:string;readonly index:number}>(owner:object,slot:string,make:()=>Table3<Row>):Table3<Row>{
  let slots=domainCache.get(owner);
  if(!slots){slots=new Map();domainCache.set(owner,slots);}
  let d=slots.get(slot);
  if(!d){d=make();slots.set(slot,d);}
  return d as Table3<Row>;
}
/** The words of a selection of plain 3D points: itself as its points. */
export const POINTS3=kind3('point',{points:{get(this:Selection<any>){return this;}}});
/** The words of a selection of plain 3D edges: itself as its edges. */
export const EDGES3=kind3('edge',{edges:{get(this:Selection<any>){return this;}}});

/** Rows once each, in row order: a relation's answer. */
export function rowOrder(rows:Iterable<number>):number[]{return [...new Set(rows)].sort((a,b)=>a-b);}

/**
 * The one write on a 3D selection. A plain record is never a `where`: it
 * is `opts`. Every function reads the rows as they were before the write.
 * A value that is not finite, or no value (`undefined`), leaves that row's
 * column as it was; a `where` that names nothing writes nothing. On points,
 * `x`, `y` and `z` are the position.
 */
function write3(sel:Sel3,args:readonly unknown[]):unknown {
  const d=sel.domain,name3=d.name,table=d.table;
  const who=`${name3}s.set`,writer=d.options.write;
  if(!writer)throw new Error(`${who}: these ${name3} rows are derived, not stored columns; there is nothing to set`);
  let values:Record<string,unknown>,rest:readonly unknown[];
  if(typeof args[0]==='string'){
    if(args.length<2)throw new Error(`${who}: '${args[0]}' needs a value — a value, or a function of the row`);
    values={[args[0]]:args[1]};rest=args.slice(2);
  }else if(isPlainRecord(args[0])&&!owners.has(args[0])){values=args[0];rest=args.slice(1);}
  else throw new Error(`${who}: give a column and a value, or a record { column: value } — got ${describe3(args[0])}`);
  const isOptions=(v:unknown):boolean=>isPlainRecord(v)&&!owners.has(v);
  let where:unknown,given=false,opts:unknown;
  if(rest.length>2)throw new Error(`${who}: takes the values, a where and options — got ${rest.length} more arguments`);
  if(rest.length===1&&isOptions(rest[0]))opts=rest[0];
  else if(rest.length>0){where=rest[0];given=true;opts=rest[1];}
  const names=Object.keys(values);
  for(const name of names){
    if(name3!=='point'||POSITION3[name]===undefined)attributeName(name);
    const v=values[name];
    if(v&&typeof (v as PromiseLike<unknown>).then==='function'){void Promise.resolve(v).catch(()=>{});throw new Error(`${who}: '${name}' is a promise — a value is synchronous`);}
  }
  const transfer=transferOf(who,opts,typeof args[0]==='string'?names[0]:undefined,names);
  // The rows to write: the members, or those `where` names among them.
  let rows:number[]=[...sel.indices];
  if(given){
    if(typeof where==='function'){const pick=where as (row:unknown)=>unknown;rows=rows.filter(i=>pick(table[i]));}
    else{const named=new Set(whereRows(sel,where,who));rows=rows.filter(i=>named.has(i));}
  }
  const written:number[]=[],records:Record<string,Attribute3>[]=[];
  const writtenOf=new Map<string,Set<number>>(names.map(n=>[n,new Set<number>()]));
  for(const i of rows){
    const row=table[i],record:Record<string,Attribute3>={};let any=false;
    for(const name of names){
      const field=values[name],v=typeof field==='function'?(field as (row:unknown)=>unknown)(row):field;
      const value=columnValue(v,name,who,name3==='point'&&POSITION3[name]!==undefined);
      if(value===undefined)continue;
      record[name]=value;any=true;writtenOf.get(name)!.add(i);
    }
    if(any){written.push(i);records.push(Object.freeze(record));}
  }
  // A column keeps one kind on every row that holds it.
  for(const name of names){
    if(name3==='point'&&POSITION3[name]!==undefined)continue;
    const mine=writtenOf.get(name)!;let kind:string|undefined;
    const check=(value:unknown,where:string):void=>{const k=columnKind(value);if(kind===undefined)kind=k;else if(k!==kind)throw new Error(`${who}: '${name}' would hold ${kind} and ${k} (${where}); a column keeps one kind on every row — write every row to change it`);};
    records.forEach((r,k)=>{if(Object.hasOwn(r,name))check(r[name],`${name3} ${written[k]}`);});
    if(kind===undefined)continue;
    table.forEach((row,i)=>{
      if(mine.has(i))return;
      const held=(row as unknown as {attributes?:Readonly<Record<string,unknown>>}).attributes?.[name];
      if(held!==undefined)check(held,`${name3} ${i}, not written`);
    });
  }
  return writer({who,rows:Object.freeze(written),values:Object.freeze(records),transfer});
}
/** The rows a non-predicate `where` names in this revision: a selection of
 * this domain (by position, or by id from another revision), or one row.
 * Nothing names nothing; a row that is gone names nothing. */
function whereRows(sel:Sel3,where:unknown,who:string):readonly number[]{
  if(where===undefined||where===null)return [];
  if(where instanceof Selection){
    const d=where.domain;
    if(!(d instanceof Table3)||d.name!==sel.domain.name)throw new Error(`${who}: where is a ${d instanceof Table3?d.name:d.kind.name} selection; this writes ${sel.domain.name}s`);
    return where.domain===sel.domain?where.indices:sel.domain.resolve(where,who);
  }
  const owner=typeof where==='object'?owners.get(where):undefined;
  if(!owner)throw new Error(`${who}: a where is a ${sel.domain.name} selection, one ${sel.domain.name} row, or a predicate — got ${describe3(where)}`);
  if(owner.domain!==sel.domain.name)throw new Error(`${who}: where is a ${owner.domain} row; this writes ${sel.domain.name}s`);
  const r=sel.domain.rowOf(where,who);
  return r<0?[]:[r];
}

/** A value a write lands: a number, string, boolean or numeric vector.
 * Nothing, or a number that is not finite, is no value (the row keeps what
 * it held); any other thing is a mistake and is refused by name. */
function columnValue(v:unknown,name:string,who:string,position:boolean):Attribute3|undefined {
  if(v===undefined)return undefined;
  if(v&&typeof (v as PromiseLike<unknown>).then==='function'){void Promise.resolve(v).catch(()=>{});throw new Error(`${who}: '${name}' answered a promise — a value is synchronous`);}
  if(typeof v==='number')return Number.isFinite(v)?v:undefined;
  if(position)throw new Error(`${who}: '${name}' is a position and takes a number — got ${describe3(v)}`);
  if(typeof v==='string'||typeof v==='boolean')return v;
  if(Array.isArray(v)){
    if(!v.every(c=>typeof c==='number'))throw new Error(`${who}: '${name}' is a vector of numbers — got an array holding ${describe3(v.find(c=>typeof c!=='number'))}`);
    return v.every(Number.isFinite)?Object.freeze([...v]) as readonly number[]:undefined;
  }
  throw new Error(`${who}: the value of '${name}' is a number, a string, a boolean or a numeric vector — got ${describe3(v)}`);
}
/** The policies a write's options declare, by column. */
function transferOf(who:string,opts:unknown,single:string|undefined,names:readonly string[]):Readonly<Record<string,string>> {
  if(opts===undefined)return {};
  if(!isPlainRecord(opts))throw new Error(`${who}: options are a record { transfer } — got ${describe3(opts)}`);
  for(const k of Object.keys(opts))if(k!=='transfer')throw new Error(`${who}: a plain record is the options { transfer }, and '${k}' is not an option${k==='fallback'?' (a 3D face column has no fallback)':''}; a where is a selection, one row of the geometry, or a predicate`);
  const t=opts.transfer;
  if(t===undefined)return {};
  if(single!==undefined){
    if(typeof t!=='string')throw new Error(`${who}: transfer is the policy of '${single}', a word — got ${describe3(t)}`);
    return {[single]:t};
  }
  if(!isPlainRecord(t))throw new Error(`${who}: the record form names each column's policy, transfer: { name: policy } — got ${describe3(t)}`);
  for(const [name,policy] of Object.entries(t)){
    if(!names.includes(name))throw new Error(`${who}: transfer names '${name}', which is not being set`);
    if(typeof policy!=='string')throw new Error(`${who}: the transfer of '${name}' is a word — got ${describe3(policy)}`);
  }
  return {...t} as Record<string,string>;
}

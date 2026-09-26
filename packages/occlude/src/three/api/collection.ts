import type {Attribute3} from '../geometry/surface.js';
import {attributeName,columnKind,describe3,isPlainRecord,POSITION3,type ColumnWriter} from './columns.js';
type Domain = 'point'|'edge'|'face'|'corner'|'instance';
const owners = new WeakMap<object, {source:object; domain:Domain; index:number}>();
const registered = new WeakMap<readonly object[], {source:object; domain:Domain}>();
const byId = new WeakMap<readonly object[], ReadonlyMap<string,number>>();
/** The collection a revision holds for a domain: `mesh.faces`, `mesh.points`, … */
const accessors:Record<Domain,string> = {point:'points',edge:'edges',face:'faces',corner:'corners',instance:'instances'};

/** The rows a write names among a collection's: a selection of the same
 * domain (of this revision, or another one read by id), one row (of any
 * revision), or a predicate over the rows as they were before the write. */
export type Where3<Row>=Collection<{readonly id:string;readonly index:number},unknown>|{readonly id:string;readonly index:number}|{bivariant(row:Row):unknown}['bivariant']|undefined;

/** Domain collections retain one immutable source revision. Geometry-specific
 * extractors decide whether extraction produces points, curves or a mesh. */
export class Collection<Row extends {readonly id:string;readonly index:number}, Extracted> implements Iterable<Row> {
  readonly indices: readonly number[];
  readonly key: unknown;
  constructor(
    readonly source: object,
    readonly domain: Domain,
    private readonly table: readonly Row[],
    private readonly extractor: (indices:readonly number[])=>Extracted,
    indices:readonly number[]=table.map((_,i)=>i),
    key?:unknown,
    /** The geometry that holds these rows as stored columns, and lands a
     * write on them; derived rows have none. */
    private readonly writer?:ColumnWriter,
  ) {
    if(indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=table.length))throw new Error(`invalid ${domain} selection index`);
    const rowOwner=registered.get(table);
    if(rowOwner&&(rowOwner.source!==source||rowOwner.domain!==domain))throw new Error('collection rows belong to another source revision or domain');
    if(!rowOwner){
      table.forEach((row,index)=>{
        const owner=owners.get(row);
        if(owner&&(owner.source!==source||owner.domain!==domain||owner.index!==index))throw new Error('collection rows belong to another source revision or domain');
        owners.set(row,{source,domain,index});
      });
      registered.set(table,{source,domain});
    }
    this.indices=Object.freeze([...new Set(indices)].sort((a,b)=>a-b));this.key=key;Object.freeze(this);
  }
  protected derive(indices:readonly number[],key:unknown=this.key):this {return new (this.constructor as typeof Collection)(this.source,this.domain,this.table,this.extractor,indices,key,this.writer) as this;}
  get length():number{return this.indices.length;}
  *[Symbol.iterator]():IterableIterator<Row>{for(const i of this.indices)yield this.table[i];}
  at(index:number):Row|undefined {
    const i=index<0?this.indices.length+index:index;
    return this.indices[i]===undefined?undefined:this.table[this.indices[i]];
  }
  map<T>(field:(row:Row,index:number)=>T):T[]{return this.indices.map((i,j)=>field(this.table[i],j));}
  find(predicate:(row:Row,index:number)=>unknown):Row|undefined {
    for(let j=0;j<this.indices.length;j++){const row=this.table[this.indices[j]];if(predicate(row,j))return row;}
    return undefined;
  }
  some(predicate:(row:Row,index:number)=>unknown):boolean{return this.find(predicate)!==undefined;}
  every(predicate:(row:Row,index:number)=>unknown):boolean{return !this.some((row,index)=>!predicate(row,index));}
  /** Membership needs an actual owned row, not a copied object. A row of this
   * revision is a member by position; a row of another revision of the same
   * domain is a member when this selection holds a row with its id. */
  has(row:Row):boolean {
    const owner=typeof row==='object'&&row!==null?owners.get(row):undefined;
    if(!owner)throw new Error(`selection.has: expected a ${this.domain} row`);
    if(owner.domain!==this.domain)throw new Error(`selection.has: expected ${this.domain}, received ${owner.domain}`);
    if(owner.source===this.source)return this.indices.includes(owner.index);
    const index=this.ids().get(row.id);
    return index!==undefined&&this.indices.includes(index);
  }
  /** This revision's row index for every id, built once per row table. */
  private ids():ReadonlyMap<string,number>{
    let ids=byId.get(this.table);
    if(!ids){ids=new Map(this.table.map((row,i)=>[row.id,i]));byId.set(this.table,ids);}
    return ids;
  }
  /** The indices, in this revision, of the rows `other` holds — by position
   * on the same revision, by id on another one; a row that is gone is left out. */
  private resolve(other:Collection<Row,Extracted>):number[]{
    if(other.source===this.source)return [...other.indices];
    const ids=this.ids(),out:number[]=[];
    for(const row of other){const i=ids.get(row.id);if(i!==undefined)out.push(i);}
    return out;
  }
  /** This selection re-read on another revision, by row id: the rows that are
   * gone are dropped, the group key is kept. `state` is the geometry that
   * holds the revision (a mesh, curve or point geometry — its `faces`,
   * `edges`, `points`, `corners` or `instances`), or a selection of that
   * revision to resolve among. */
  in(state:object):this{
    const what=`${this.domain}s.in`;
    let target:unknown=state;
    if(!(state instanceof Collection)){
      if(state===null||typeof state!=='object')throw new Error(`${what}: expected a geometry or a ${this.domain} selection to resolve against, got ${state===null?'null':typeof state}`);
      const name=accessors[this.domain];
      if(!(name in state))throw new Error(`${what}: that value has no ${name}; pass the geometry the selection should be read on`);
      target=(state as Record<string,unknown>)[name];
    }
    if(!(target instanceof Collection))throw new Error(`${what}: that value's ${accessors[this.domain]} is not a selection`);
    if(target.domain!==this.domain)throw new Error(`${what}: expected ${this.domain}s, got ${target.domain}s`);
    const other=target as Collection<Row,Extracted>,held=new Set(other.resolve(this));
    return other.derive(other.indices.filter(i=>held.has(i)),this.key) as this;
  }
  /** The selection holding those SOURCE rows — never positions within this
   * selection: an index, a row, or a list of either, as `sel.rows` does in
   * 2D. A row is resolved the way `has` resolves one: a row of another
   * revision by its id; a row of another domain, or one whose id is gone
   * from this revision, is refused by name. */
  rows(rows:number|Row|Iterable<number|Row>):this {
    const what=`${this.domain}s.rows`;
    const one=(r:number|Row):number=>{
      if(typeof r==='number'){
        if(!Number.isSafeInteger(r)||r<0||r>=this.table.length)throw new Error(`${what}: no ${this.domain} ${r} in this revision (${this.table.length} rows)`);
        return r;
      }
      const owner=typeof r==='object'&&r!==null?owners.get(r):undefined;
      if(!owner)throw new Error(`${what}: expected a ${this.domain} row or index, got ${r===null?'null':typeof r}`);
      if(owner.domain!==this.domain)throw new Error(`${what}: expected a ${this.domain} row, got a ${owner.domain} row`);
      if(owner.source===this.source)return owner.index;
      const index=this.ids().get((r as Row).id);
      if(index===undefined)throw new Error(`${what}: that ${this.domain} row (id ${(r as Row).id}) is gone from this revision`);
      return index;
    };
    if(typeof rows==='number'||(typeof rows==='object'&&rows!==null&&owners.has(rows)))return this.derive([one(rows as number|Row)]);
    if(rows==null||typeof (rows as Iterable<unknown>)[Symbol.iterator]!=='function')throw new Error(`${what}: expected a ${this.domain} row, an index, or a list of them`);
    return this.derive(Array.from(rows as Iterable<number|Row>,one));
  }
  /** The other operand's rows in this revision: a selection of an earlier or
   * later revision is resolved by id (`other.in(this revision)`); only a
   * different domain is refused. */
  private operand(other:Collection<Row,Extracted>,op:string):number[]{
    if(!(other instanceof Collection))throw new Error(`${this.domain}s.${op}: expected a ${this.domain} selection`);
    if(other.domain!==this.domain)throw new Error(`${this.domain}s.${op}: selection set operations require the same domain (${this.domain}s, got ${other.domain}s)`);
    return this.resolve(other);
  }
  union(other:Collection<Row,Extracted>):this{
    return this.derive([...this.indices,...this.operand(other,'union')]);
  }
  intersect(other:Collection<Row,Extracted>):this{
    const selected=new Set(this.operand(other,'intersect'));
    return this.derive(this.indices.filter(i=>selected.has(i)));
  }
  subtract(other:Collection<Row,Extracted>):this{
    const selected=new Set(this.operand(other,'subtract'));
    return this.derive(this.indices.filter(i=>!selected.has(i)));
  }
  /** Complement is relative to the complete source domain, not a group. */
  complement():this{
    const selected=new Set(this.indices);
    return this.derive(this.table.map((_,i)=>i).filter(i=>!selected.has(i)));
  }
  filter(predicate:(row:Row,index:number)=>unknown):this{
    return this.derive(this.indices.filter((i,j)=>predicate(this.table[i],j)),this.key);
  }
  groupBy<Key>(field:(row:Row)=>Key):readonly (this&{readonly key:Key})[]{
    const groups=new Map<Key,number[]>();
    for(const i of this.indices){const key=field(this.table[i]);const list=groups.get(key);if(list)list.push(i);else groups.set(key,[i]);}
    return Object.freeze([...groups].map(([key,indices])=>this.derive(indices,key) as this&{readonly key:Key}));
  }
  extract():Extracted{return this.extractor(this.indices);}
  /** The one write, for the collections that hold stored columns (their
   * typed `set` calls it): `(column, value, where?, opts?)` or
   * `({ column: value, … }, where?, opts?)`, over this selection's rows or
   * the ones `where` names among them — a selection of this domain (of this
   * revision or another, read by id), one row, or a predicate. A plain
   * record is never a `where`: it is `opts`. Every function reads the rows
   * as they were before the write. A value that is not finite, or no value
   * (`undefined`), leaves that row's column as it was; a `where` that names
   * nothing writes nothing. On points, `x`, `y` and `z` are the position. */
  protected write(args:readonly unknown[]):unknown {
    const who=`${this.domain}s.set`,writer=this.writer;
    if(!writer)throw new Error(`${who}: these ${this.domain} rows are derived, not stored columns; there is nothing to set`);
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
      if(this.domain!=='point'||POSITION3[name]===undefined)attributeName(name);
      const v=values[name];
      if(v&&typeof (v as PromiseLike<unknown>).then==='function'){void Promise.resolve(v).catch(()=>{});throw new Error(`${who}: '${name}' is a promise — a value is synchronous`);}
    }
    const transfer=transferOf(who,opts,typeof args[0]==='string'?names[0]:undefined,names);
    // The rows to write: the members, or those `where` names among them.
    let rows:number[]=[...this.indices];
    if(given){
      const held=new Set(this.indices);
      if(typeof where==='function'){const pick=where as (row:Row)=>unknown;rows=rows.filter(i=>pick(this.table[i]));}
      else rows=this.whereRows(where,who).filter(i=>held.has(i));
    }
    const written:number[]=[],records:Record<string,Attribute3>[]=[];
    const writtenOf=new Map<string,Set<number>>(names.map(n=>[n,new Set<number>()]));
    for(const i of rows){
      const row=this.table[i],record:Record<string,Attribute3>={};let any=false;
      for(const name of names){
        const field=values[name],v=typeof field==='function'?(field as (row:Row)=>unknown)(row):field;
        const value=columnValue(v,name,who,this.domain==='point'&&POSITION3[name]!==undefined);
        if(value===undefined)continue;
        record[name]=value;any=true;writtenOf.get(name)!.add(i);
      }
      if(any){written.push(i);records.push(Object.freeze(record));}
    }
    // A column keeps one kind on every row that holds it.
    for(const name of names){
      if(this.domain==='point'&&POSITION3[name]!==undefined)continue;
      const mine=writtenOf.get(name)!;let kind:string|undefined;
      const check=(value:unknown,where:string):void=>{const k=columnKind(value);if(kind===undefined)kind=k;else if(k!==kind)throw new Error(`${who}: '${name}' would hold ${kind} and ${k} (${where}); a column keeps one kind on every row — write every row to change it`);};
      records.forEach((r,k)=>{if(Object.hasOwn(r,name))check(r[name],`${this.domain} ${written[k]}`);});
      if(kind===undefined)continue;
      this.table.forEach((row,i)=>{
        if(mine.has(i))return;
        const held=(row as unknown as {attributes?:Readonly<Record<string,unknown>>}).attributes?.[name];
        if(held!==undefined)check(held,`${this.domain} ${i}, not written`);
      });
    }
    return writer({who,rows:Object.freeze(written),values:Object.freeze(records),transfer});
  }
  /** The rows a non-predicate `where` names in this revision: a selection
   * of this domain (by position, or by id from another revision), or one
   * row. Nothing names nothing; a row that is gone names nothing. */
  private whereRows(where:unknown,who:string):number[]{
    if(where===undefined||where===null)return [];
    if(where instanceof Collection){
      if(where.domain!==this.domain)throw new Error(`${who}: where is a ${where.domain} selection; this writes ${this.domain}s`);
      return this.resolve(where as Collection<Row,Extracted>);
    }
    const owner=typeof where==='object'?owners.get(where):undefined;
    if(!owner)throw new Error(`${who}: a where is a ${this.domain} selection, one ${this.domain} row, or a predicate — got ${describe3(where)}`);
    if(owner.domain!==this.domain)throw new Error(`${who}: where is a ${owner.domain} row; this writes ${this.domain}s`);
    if(owner.source===this.source)return [owner.index];
    const index=this.ids().get((where as Row).id);
    return index===undefined?[]:[index];
  }

  /** A column that is not numeric is the wrong column and still throws; a row
   * whose value is not finite is left out of the reduction. */
  private numbers(name:string):number[]{return this.map(row=>{const v=(row as unknown as Record<string,unknown>)[name];if(typeof v!=='number')throw new Error(`'${name}' is not a finite number on every ${this.domain}`);return v;}).filter(Number.isFinite);}
  /** Numeric reductions over an attribute; the mean of nothing is NaN. */
  sum(name:string):number{return this.numbers(name).reduce((a,b)=>a+b,0);}
  mean(name:string):number{const v=this.numbers(name);return v.reduce((a,b)=>a+b,0)/v.length;}
  max(name:string):number{return this.numbers(name).reduce((a,b)=>Math.max(a,b),-Infinity);}
  min(name:string):number{return this.numbers(name).reduce((a,b)=>Math.min(a,b),Infinity);}
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


type Domain = 'point'|'edge'|'face'|'corner'|'instance';
const owners = new WeakMap<object, {source:object; domain:Domain; index:number}>();
const registered = new WeakMap<readonly object[], {source:object; domain:Domain}>();
const byId = new WeakMap<readonly object[], ReadonlyMap<string,number>>();
/** The collection a revision holds for a domain: `mesh.faces`, `mesh.points`, … */
const accessors:Record<Domain,string> = {point:'points',edge:'edges',face:'faces',corner:'corners',instance:'instances'};

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
  protected derive(indices:readonly number[],key:unknown=this.key):this {return new Collection(this.source,this.domain,this.table,this.extractor,indices,key) as this;}
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
  /** A column that is not numeric is the wrong column and still throws; a row
   * whose value is not finite is left out of the reduction. */
  private numbers(name:string):number[]{return this.map(row=>{const v=(row as unknown as Record<string,unknown>)[name];if(typeof v!=='number')throw new Error(`'${name}' is not a finite number on every ${this.domain}`);return v;}).filter(Number.isFinite);}
  /** Numeric reductions over an attribute; the mean of nothing is NaN. */
  sum(name:string):number{return this.numbers(name).reduce((a,b)=>a+b,0);}
  mean(name:string):number{const v=this.numbers(name);return v.reduce((a,b)=>a+b,0)/v.length;}
  max(name:string):number{return this.numbers(name).reduce((a,b)=>Math.max(a,b),-Infinity);}
  min(name:string):number{return this.numbers(name).reduce((a,b)=>Math.min(a,b),Infinity);}
}

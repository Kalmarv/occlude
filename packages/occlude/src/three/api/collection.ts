type Domain = 'point'|'edge'|'face'|'corner'|'instance';
const owners = new WeakMap<object, {source:object; domain:Domain; index:number}>();
const registered = new WeakMap<readonly object[], {source:object; domain:Domain}>();

/** Domain collections retain one immutable source revision. Geometry-specific
 * extractors decide whether extraction produces points, curves or a mesh. */
export class Collection<Row extends {readonly id:string;readonly index:number}, Extracted> implements Iterable<Row> {
  readonly indices: readonly number[];
  readonly key: unknown;
  constructor(
    readonly source: object,
    readonly domain: Domain,
    private readonly rows: readonly Row[],
    private readonly extractor: (indices:readonly number[])=>Extracted,
    indices:readonly number[]=rows.map((_,i)=>i),
    key?:unknown,
  ) {
    if(indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=rows.length))throw new Error(`invalid ${domain} selection index`);
    const rowOwner=registered.get(rows);
    if(rowOwner&&(rowOwner.source!==source||rowOwner.domain!==domain))throw new Error('collection rows belong to another source revision or domain');
    if(!rowOwner){
      rows.forEach((row,index)=>{
        const owner=owners.get(row);
        if(owner&&(owner.source!==source||owner.domain!==domain||owner.index!==index))throw new Error('collection rows belong to another source revision or domain');
        owners.set(row,{source,domain,index});
      });
      registered.set(rows,{source,domain});
    }
    this.indices=Object.freeze([...new Set(indices)].sort((a,b)=>a-b));this.key=key;Object.freeze(this);
  }
  protected derive(indices:readonly number[],key:unknown=this.key):this {return new Collection(this.source,this.domain,this.rows,this.extractor,indices,key) as this;}
  get length():number{return this.indices.length;}
  *[Symbol.iterator]():IterableIterator<Row>{for(const i of this.indices)yield this.rows[i];}
  at(index:number):Row|undefined {
    const i=index<0?this.indices.length+index:index;
    return this.indices[i]===undefined?undefined:this.rows[this.indices[i]];
  }
  map<T>(field:(row:Row,index:number)=>T):T[]{return this.indices.map((i,j)=>field(this.rows[i],j));}
  find(predicate:(row:Row,index:number)=>boolean):Row|undefined {
    for(let j=0;j<this.indices.length;j++){const row=this.rows[this.indices[j]];if(predicate(row,j))return row;}
    return undefined;
  }
  some(predicate:(row:Row,index:number)=>boolean):boolean{return this.find(predicate)!==undefined;}
  every(predicate:(row:Row,index:number)=>boolean):boolean{return !this.some((row,index)=>!predicate(row,index));}
  /** Membership needs an actual owned row, not a matching ID or copied object. */
  has(row:Row):boolean {
    const owner=owners.get(row);
    if(!owner)throw new Error(`selection.has: expected a ${this.domain} row`);
    if(owner.domain!==this.domain)throw new Error(`selection.has: expected ${this.domain}, received ${owner.domain}`);
    return owner.source===this.source&&this.indices.includes(owner.index);
  }
  private same(other:Collection<Row,Extracted>):void {
    if(!(other instanceof Collection)||other.domain!==this.domain)throw new Error('selection set operations require the same domain');
    if(other.source!==this.source)throw new Error('selection set operations require the same source revision');
  }
  union(other:Collection<Row,Extracted>):this{
    this.same(other);return this.derive([...this.indices,...other.indices]);
  }
  intersect(other:Collection<Row,Extracted>):this{
    this.same(other);const selected=new Set(other.indices);
    return this.derive(this.indices.filter(i=>selected.has(i)));
  }
  subtract(other:Collection<Row,Extracted>):this{
    this.same(other);const selected=new Set(other.indices);
    return this.derive(this.indices.filter(i=>!selected.has(i)));
  }
  /** Complement is relative to the complete source domain, not a group. */
  complement():this{
    const selected=new Set(this.indices);
    return this.derive(this.rows.map((_,i)=>i).filter(i=>!selected.has(i)));
  }
  filter(predicate:(row:Row,index:number)=>boolean):this{
    return this.derive(this.indices.filter((i,j)=>predicate(this.rows[i],j)),this.key);
  }
  groupBy<Key>(field:(row:Row)=>Key):readonly (this&{readonly key:Key})[]{
    const groups=new Map<Key,number[]>();
    for(const i of this.indices){const key=field(this.rows[i]);const list=groups.get(key);if(list)list.push(i);else groups.set(key,[i]);}
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

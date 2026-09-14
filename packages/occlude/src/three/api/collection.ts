/** Domain collections retain one immutable source revision. Geometry-specific
 * extractors decide whether extraction produces points, curves or a mesh. */
export class Collection<Row extends {readonly id:string;readonly index:number}, Extracted> implements Iterable<Row> {
  readonly indices: readonly number[];
  readonly key: unknown;
  constructor(
    readonly source: object,
    readonly domain: 'point'|'edge'|'face'|'instance',
    private readonly rows: readonly Row[],
    private readonly extractor: (indices:readonly number[])=>Extracted,
    indices:readonly number[]=rows.map((_,i)=>i),
    key?:unknown,
  ) {
    if(indices.some(i=>!Number.isSafeInteger(i)||i<0||i>=rows.length))throw new Error(`invalid ${domain} selection index`);
    this.indices=Object.freeze([...new Set(indices)].sort((a,b)=>a-b));this.key=key;Object.freeze(this);
  }
  get length():number{return this.indices.length;}
  *[Symbol.iterator]():IterableIterator<Row>{for(const i of this.indices)yield this.rows[i];}
  at(index:number):Row|undefined {
    const i=index<0?this.indices.length+index:index;
    return this.indices[i]===undefined?undefined:this.rows[this.indices[i]];
  }
  map<T>(field:(row:Row,index:number)=>T):T[]{return this.indices.map((i,j)=>field(this.rows[i],j));}
  filter(predicate:(row:Row,index:number)=>boolean):Collection<Row,Extracted>{
    return new Collection(this.source,this.domain,this.rows,this.extractor,this.indices.filter((i,j)=>predicate(this.rows[i],j)),this.key);
  }
  groupBy<Key>(field:(row:Row)=>Key):readonly (Collection<Row,Extracted>&{readonly key:Key})[]{
    const groups=new Map<Key,number[]>();
    for(const i of this.indices){const key=field(this.rows[i]);const list=groups.get(key);if(list)list.push(i);else groups.set(key,[i]);}
    return Object.freeze([...groups].map(([key,indices])=>new Collection(this.source,this.domain,this.rows,this.extractor,indices,key) as Collection<Row,Extracted>&{readonly key:Key}));
  }
  extract():Extracted{return this.extractor(this.indices);}
}

import type {Attribute3,Attributes3} from '../geometry/surface.js';

/** A value, or a function of the row that answers one. */
export type Field<Row,Value> = Value | ((row:Row)=>Value);
export type AttributeFields<Row,A extends Attributes3> = {readonly [K in keyof A]:Field<Row,A[K]>};
export function evaluate<R,V>(field:Field<R,V>,row:R):V{return typeof field==='function'?(field as (row:R)=>V)(row):field;}

const reserved=new Set(['id','index','x','y','z','attributes','provenance','vertices','normal','center','centroid','area','a','b','length','source','sample','points','edges','faces','adjacent','corners','face','point','localIndex']);
export function attributeName(name:string):void {if(!name||reserved.has(name)||name==='__proto__'||name==='constructor'||name==='prototype')throw new Error(`reserved or empty geometry attribute name: ${name}`);}
export function attributeValue(value:Attribute3):Attribute3 {
  if(typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value)&&value.every(Number.isFinite))return Object.freeze([...value]);
  throw new Error('geometry attribute must be a string, boolean, finite number or finite numeric array');
}

/** How a point column moves when a mesh is refined: numbers and vectors
 * `'interpolate'` (the default), a category `'nearest'`. */
export type Transfer3='interpolate'|'nearest';
/** The trailing record of a `set` on a domain whose columns carry a
 * transfer policy (mesh points and corners). It DECLARES the policy of the
 * column the call names, as `transfer`; the record form names each column,
 * `transfer: { name: policy }`. Setting a value keeps the declared policy. */
export interface SetOptions3 {readonly transfer?:Transfer3}
export interface SetManyOptions3 {readonly transfer?:Readonly<Record<string,Transfer3>>}
/** The kind a written value gives its column: a value you set is one a
 * later write may change, so a literal widens to its kind. */
export type Widen3<V> = V extends number ? number : V extends string ? string : V extends boolean ? boolean : V extends readonly number[] ? {readonly [I in keyof V]:number} : V;
export type Widened3<A> = {[K in keyof A]:Widen3<A[K]>};
/** The point columns after a write on points: `x`, `y` and `z` are the
 * position, which every point row already answers, so they add no column. */
export type PointColumns3<P,Name extends PropertyKey,V> = Name extends 'x'|'y'|'z' ? P : Omit<P,Name>&Record<Name,Widen3<V>>;
export type PointFields3<P,A> = Omit<P,keyof A>&Widened3<Omit<A,'x'|'y'|'z'>>;

/** @internal One `set`, read and evaluated: the rows it writes (row order),
 * each row's new values (a value that was not finite is left out, so its
 * row keeps what it held), and the transfer policies it declares. */
export interface ColumnWrite {
  readonly who:string;
  readonly rows:readonly number[];
  readonly values:readonly Readonly<Record<string,Attribute3>>[];
  readonly transfer:Readonly<Record<string,string>>;
}
/** @internal The geometry a write lands on answers the new geometry. */
export type ColumnWriter=(write:ColumnWrite)=>unknown;

/** The position columns of a point row: a `set` on points may write them. */
export const POSITION3:Readonly<Record<string,0|1|2>>=Object.freeze({x:0,y:1,z:2});

/** The kind a column value has: a column holds one kind on every row. */
export function columnKind(value:unknown):string {
  if(Array.isArray(value))return `a vector of ${value.length}`;
  return typeof value==='number'?'a number':typeof value==='string'?'a string':typeof value==='boolean'?'a boolean':typeof value;
}
export const isPlainRecord=(v:unknown):v is Record<string,unknown>=>{
  if(typeof v!=='object'||v===null||Array.isArray(v))return false;
  const proto=Object.getPrototypeOf(v);
  return proto===Object.prototype||proto===null;
};
export const describe3=(v:unknown):string=>v===null?'null':Array.isArray(v)?`an array of ${v.length}`:typeof v==='object'?`${(v as object).constructor?.name??'an object'}`:typeof v==='string'?`'${v}'`:String(v);

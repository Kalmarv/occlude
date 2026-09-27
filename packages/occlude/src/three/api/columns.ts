import type {Attribute3} from '../geometry/model.js';

/** A value, or a function of the row that answers one. */
export type Field<Row,Value> = Value | ((row:Row)=>Value);
export function evaluate<R,V>(field:Field<R,V>,row:R):V{return typeof field==='function'?(field as (row:R)=>V)(row):field;}

/** A value a kernel's column may hold: a string, a boolean, a finite
 * number or a list of finite numbers. */
export function attributeValue(value:Attribute3):Attribute3 {
  if(typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value)&&value.every(Number.isFinite))return Object.freeze([...value]);
  throw new Error('geometry attribute must be a string, boolean, finite number or finite numeric array');
}

export const describe3=(v:unknown):string=>v===null?'null':Array.isArray(v)?`an array of ${v.length}`:typeof v==='object'?`${(v as object).constructor?.name??'an object'}`:typeof v==='string'?`'${v}'`:String(v);

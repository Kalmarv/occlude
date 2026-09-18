/** The best-effort render policy in one place. A degenerate input — a size or
 * spacing that is not positive, a count below its minimum, one sample the
 * field could not answer, a setting outside its range — yields an empty or
 * skipped result for that piece, and the rest of the sketch keeps drawing.
 * Missing options, wrong types, ownership invariants and budgets still throw. */

/** True when any size, radius, spacing or step draws nothing. */
export const emptySize=(...values:readonly number[]):boolean=>values.some(n=>!(Number.isFinite(n)&&n>0));
/** True when a count draws nothing. A non-integer is a type mistake, not a degenerate value. */
export function emptyCount(value:number,min:number,name:string):boolean {
  if(!Number.isSafeInteger(value))throw new Error(`${name} must be an integer >= ${min}`);
  return value<min;
}
/** One sample's value, or the fallback when the field returned no usable number. */
export function sampleValue<T>(value:unknown,fallback:T):number|T {
  return typeof value==='number'&&Number.isFinite(value)?value:fallback;
}
/** An out-of-range setting clamps and a non-finite one falls back; anything
 * that is not a number at all is still a type mistake. */
export function clampSetting(value:number|undefined,low:number,high:number,fallback:number,name:string):number {
  if(value===undefined)return fallback;
  if(typeof value!=='number')throw new Error(`${name} must be a number between ${low} and ${high}`);
  return Number.isFinite(value)?Math.min(high,Math.max(low,value)):fallback;
}

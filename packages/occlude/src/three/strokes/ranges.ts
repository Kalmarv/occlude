import type { Interval3 } from '../visibility/interval.js';
/** Source traversal coordinates span the whole polyline, not just [0,1]. */
export function unionSourceRanges3(ranges:readonly Interval3[]):[number,number][] {
  const out:[number,number][]=[];
  for(const [a,b] of [...ranges].sort((a,b)=>a[0]-b[0]||a[1]-b[1])) {
    if(a>=b)continue;
    const last=out.at(-1);
    if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);
  }
  return out;
}

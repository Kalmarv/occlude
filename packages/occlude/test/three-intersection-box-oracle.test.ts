import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {mesh} from 'occlude/3d';
import {surfaceBinding3} from '../src/three/curves/network.js';
import {intersections3} from '../src/three/curves/intersections.js';

type Fixture={id:string;a:number[][];b:number[][];expected:{segments:string[][][];points:string[][]}};
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/intersection-boxes.json',import.meta.url),'utf8')) as Fixture[];
const faces=[[3,2,1,0],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]] as const;
const make=(rows:number[][])=>{
 const p=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
 return surfaceBinding3(mesh(p.map(sign=>sign.map((s,i)=>rows[i][s>0?1:0]) as [number,number,number]),faces).surface);
};
const rat=(value:string):[bigint,bigint]=>{const [n,d]=value.split('/');return [BigInt(n),BigInt(d??1)]};
const cmp=(a:string,b:string)=>{const [an,ad]=rat(a),[bn,bd]=rat(b),v=an*bd-bn*ad;return v<0n?-1:v>0n?1:0;};
const canonical=(value:string)=>{let [n,d]=rat(value);if(d<0n){n=-n;d=-d;}const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a<0n?-a:a;const g=gcd(n,d);return `${n/g}${d/g===1n?'':`/${d/g}`}`;};
const point=(row:string[])=>row.map(canonical);
const runtimePoint=(encoded:readonly string[])=>{const w=encoded[3];return encoded.slice(0,3).map(v=>canonical(`${v}/${w}`));};
const coverage=(segments:readonly {a:string[];b:string[]}[])=>{
 const lines=new Map<string,[string,string][]>();
 for(const {a,b} of segments){
  const axes=a.map((v,i)=>v!==b[i]?i:-1).filter(i=>i>=0);expect(axes).toHaveLength(1);
  const axis=axes[0],fixed=a.map((v,i)=>i===axis?'':v).join(','),ends=[a[axis],b[axis]].sort(cmp),key=`${axis}:${fixed}`;(lines.get(key)??(lines.set(key,[]),lines.get(key)!)).push(ends as [string,string]);
 }
 const result:[string,string[][]][]=[];
 for(const [key,parts] of lines){const merged:string[][]=[];for(const part of parts.sort((a,b)=>cmp(a[0],b[0]))){const last=merged.at(-1);if(last&&cmp(part[0],last[1])<=0){if(cmp(last[1],part[1])<0)last[1]=part[1];}else merged.push([part[0],part[1]]);}result.push([key,merged]);}
 return result.sort((a,b)=>a[0].localeCompare(b[0]));
};
describe('axis aligned intersection Fraction oracle',()=>{
 it('matches exact geometric segment and isolated point coverage',()=>{
  expect(fixtures).toHaveLength(40);
  for(const fixture of fixtures){
   const result=intersections3(make(fixture.a),make(fixture.b)).value.network;
   const segments=result.segments.map(row=>({a:runtimePoint(result.nodes[row.a].exact),b:runtimePoint(result.nodes[row.b].exact)}));
   const expectedSegments=fixture.expected.segments.map(row=>({a:point(row[0]),b:point(row[1])}));
   expect(coverage(segments),fixture.id).toEqual(coverage(expectedSegments));
   const degree=new Map<string,number>();for(const row of segments)for(const p of [row.a,row.b]){const key=p.join(',');degree.set(key,(degree.get(key)??0)+1);}
   const actualPoints=result.nodes.filter(node=>!degree.has(runtimePoint(node.exact).join(','))).map(node=>runtimePoint(node.exact)).sort((a,b)=>a.join(',').localeCompare(b.join(',')));
   const expectedPoints=fixture.expected.points.map(point).sort((a,b)=>a.join(',').localeCompare(b.join(',')));
   expect(actualPoints,fixture.id).toEqual(expectedPoints);
  }
 });
});

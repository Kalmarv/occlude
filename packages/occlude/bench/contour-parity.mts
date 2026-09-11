import {flattenPrim} from '../src/prims.js';
// Inspect native/WASM run topology from exactly the same dumped inputs.
// Run contour_bench first to write native-plan.f64 in each dump directory.
import {readFileSync} from 'node:fs';
import * as core from 'occlude-core';
import {initOcclude,decodePlanBuffer,evalPrim,type Prim,type WasmModule} from '../src/index.js';
await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));
const wasm=core as unknown as WasmModule;
function geometryDifference(a:Prim[],b:Prim[]){
 const key=(p:Prim)=>{const pts=[0,0.25,0.5,0.75,1].map(t=>evalPrim(p,t).map(x=>Math.round(x*1e6)).join(','));const forward=pts.join(';'),reverse=pts.reverse().join(';');return forward<reverse?forward:reverse};
 const keys=new Set(b.map(key));const changed=a.filter(p=>!keys.has(key(p)));
 const segs:[number,number,number,number][]=[];const grid=new Map<string,number[]>();
 for(const p of b){const points=flattenPrim(p,0.001);for(let i=1;i<points.length;i++){const [x,y]=points[i-1],[u,v]=points[i];const id=segs.length;segs.push([x,y,u,v]);for(let gx=Math.floor(Math.min(x,u));gx<=Math.floor(Math.max(x,u));gx++)for(let gy=Math.floor(Math.min(y,v));gy<=Math.floor(Math.max(y,v));gy++){const k=gx+','+gy;const cell=grid.get(k)??[];cell.push(id);grid.set(k,cell)}}}
 let maxDistance=0;
 for(const p of changed)for(const t of [0,0.25,0.5,0.75,1]){const [x,y]=evalPrim(p,t);let nearest=Infinity;for(let gx=Math.floor(x)-1;gx<=Math.floor(x)+1;gx++)for(let gy=Math.floor(y)-1;gy<=Math.floor(y)+1;gy++)for(const id of grid.get(gx+','+gy)??[]){const [a,b,c,d]=segs[id],dx=c-a,dy=d-b,q=Math.max(0,Math.min(1,((x-a)*dx+(y-b)*dy)/(dx*dx+dy*dy)));nearest=Math.min(nearest,Math.hypot(x-a-q*dx,y-b-q*dy))}maxDistance=Math.max(maxDistance,nearest)}
 return {unmatchedPrimitives:changed.length,maxSampledCenterlineDistanceMm:maxDistance};
}
function coverage(prims:Prim[]) {
 const segments:[number,number,number,number][]=[];const grid=new Map<string,number[]>();const cell=0.5;
 for(const p of prims){const pts=flattenPrim(p,0.001);for(let i=1;i<pts.length;i++){const [x,y]=pts[i-1],[u,v]=pts[i];const id=segments.length;segments.push([x,y,u,v]);for(let gx=Math.floor(Math.min(x,u)/cell);gx<=Math.floor(Math.max(x,u)/cell);gx++)for(let gy=Math.floor(Math.min(y,v)/cell);gy<=Math.floor(Math.max(y,v)/cell);gy++){const k=gx+','+gy;const list=grid.get(k)??[];list.push(id);grid.set(k,list)}}}
 let maximum=0,samples=0,uncovered=0;const worst:{x:number,y:number,d:number}[]=[];
 for(let ix=169;ix<=1931;ix++)for(let iy=604;iy<=2366;iy++){
  const x=ix/10,y=iy/10,qx=Math.abs(x-105)-71.4,qy=Math.abs(y-148.5)-71.4;
  const sdf=Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-16.8;
  if(sdf> -0.225)continue;
  let insideHole=false;for(let j=0;j<16;j++)if(Math.hypot(x-(42+(j%4)*42),y-(85.5+Math.floor(j/4)*42))<10.725){insideHole=true;break}
  if(insideHole)continue;
  let distance=Infinity;
  for(let gx=Math.floor(x/cell)-1;gx<=Math.floor(x/cell)+1;gx++)for(let gy=Math.floor(y/cell)-1;gy<=Math.floor(y/cell)+1;gy++)for(const i of grid.get(gx+','+gy)??[]){const [a,b,c,d]=segments[i],dx=c-a,dy=d-b;const t=Math.max(0,Math.min(1,((x-a)*dx+(y-b)*dy)/(dx*dx+dy*dy)));distance=Math.min(distance,Math.hypot(x-a-t*dx,y-b-t*dy))}
  samples++;maximum=Math.max(maximum,distance);if(distance>0.236){uncovered++;worst.push({x,y,d:distance})}
 }
 worst.sort((a,b)=>b.d-a.d);
 return {worst:worst.slice(0,12),samples,maximumCenterlineDistanceMm:maximum,uncovered,gridMm:0.1,nibMm:0.45,toleranceMm:0.011};
}
for(const dir of process.argv.slice(2)){
 const f64=(name:string)=>{const b=readFileSync(`${dir}/${name}.f64`);return new Float64Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength))};
 const u32=(name:string)=>{const b=readFileSync(`${dir}/${name}.u32`);return new Uint32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength))};
 const meta=JSON.parse(readFileSync(`${dir}/meta.json`,'utf8')),pens=readFileSync(`${dir}/pens.json`,'utf8');
 const prepared=wasm.wasm_prepare(f64('prims'),u32('contours'),u32('shapes_u32'),f64('shapes_f64'),f64('mods'),f64('fields'),f64('field_uses'),u32('domain_list'),u32('clip_list'),u32('clips_u32'),pens,new Float64Array(meta.paper),meta.seed,meta.coarsen,0);
 const result=wasm.wasm_finish(prepared,u32('fills_index'),u32('fill_chains'),f64('fill_prims'),f64('fill_dots'));
 const buffer=wasm.wasm_plan(result.prims,result.frags,pens,200000,-1);
 const native=f64('native-plan'),a=decodePlanBuffer(native),b=decodePlanBuffer(buffer);
 let maxParameterDelta=0;
 if(native.length===buffer.length)for(let i=0;i<buffer.length;i++)maxParameterDelta=Math.max(maxParameterDelta,Math.abs(native[i]-buffer[i]));
 const geometry=native.length===buffer.length&&maxParameterDelta===0?undefined:{nativeToWasm:geometryDifference(a.flatMap(c=>c.prims),b.flatMap(c=>c.prims)),wasmToNative:geometryDifference(b.flatMap(c=>c.prims),a.flatMap(c=>c.prims))};
 const coverageEvidence=dir.includes('holes')?{native:coverage(a.flatMap(c=>c.prims)),wasm:coverage(b.flatMap(c=>c.prims))}:undefined;
 console.log(JSON.stringify({dir,geometry,coverage:coverageEvidence,nativeRuns:a.length,wasmRuns:b.length,nativePrimitives:a.reduce((n,c)=>n+c.prims.length,0),wasmPrimitives:b.reduce((n,c)=>n+c.prims.length,0),sameLayout:native.length===buffer.length,maxParameterDelta:native.length===buffer.length?maxParameterDelta:null}));
 result.free?.();
}

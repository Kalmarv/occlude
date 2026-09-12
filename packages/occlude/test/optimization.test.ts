import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import init, * as core from '../../../crates/occlude-core/pkg/occlude_core.js';
import { compileSketch, encodeScene, renderEncoded, setPaperHint, sketch, rect, circle, mask, clip, fill, decimate,
  decodePlanBuffer, encodePlanBuffer, evalPrim, type Tree, type WasmModule } from '../src/index.js';
beforeAll(async()=>{await init(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));});
const paper={w:100,h:100};
const rows=()=>rect(10,10,80,80,{stroke:false,fill:()=>[
  {type:'line',x1:20,y1:50,x2:49,y2:50},{type:'line',x1:51,y1:50,x2:80,y2:50},
]});
function run(tree:Tree,gap=3){
  setPaperHint(100,100);compileSketch(sketch({aspect:'square',seed:42},()=>tree));
  const s=encodeScene({paper:{paper}}); const raw=renderEncoded(core as unknown as WasmModule,s);
  const source=core.wasm_plan(raw.prims,raw.frags,s.pensJson,0,0);
  const p=core.wasm_prepare(s.prims,s.contours,s.shapesU32,s.shapesF64,s.mods,s.fieldData,s.fieldUses,s.domainList,s.clipList,s.clipsU32,s.pensJson,s.paperArr,s.seed,s.coarsen,0);
  try{
    const result=p.optimize_plan(source,raw.prims,raw.frags,0.01,2,30,gap,1000);
    try{return {source,buffer:result.plan,after:result.after,stats:result.stats,pensJson:s.pensJson};}finally{result.free();}
  }finally{p.free();}
}
it('joins known same-shape ends and refuses a hole over the entire connector',()=>{
  expect(run(rows()).stats[2]).toBe(1);
  const blocked=run([rows(),mask(rect(49.6,49,0.8,2))]);
  expect(blocked.stats[2]).toBe(0);
  expect(decodePlanBuffer(blocked.buffer)).toHaveLength(2);
  // A tiny off-midpoint blocker catches endpoint/midpoint-only certificates.
  expect(run([rows(),mask(rect(49.2,49,0.1,2))]).stats[2]).toBe(0);
});
it('honors nested clips, clipped occluders, post modifiers, pens and protected contour runs',()=>{
  expect(run([rows(),clip(rect(40,60,20,20),mask(rect(49,20,2,60)))]).stats[2]).toBe(1);
  expect(run(clip(rect(10,10,39.5,80),rows())).stats[2]).toBe(0);
  expect(run(decimate(0,rows())).stats[2]).toBe(0);
  const native=run(circle(50,50,25,{stroke:false,fill:fill('contour',{spacing:1,connectors:false})}),3);
  expect(native.stats[2]).toBe(0);
  expect(run([rows(),rect(0,0,1,1,{pen:'pigma-05-black'})]).stats[2]).toBe(1);
});
it('preserves source bytes, deterministic output, decoded continuity and export parity',()=>{
  const a=run(rows()),b=run(rows());
  expect(a.buffer).toEqual(b.buffer);expect(a.source).toEqual(b.source);
  const chains=decodePlanBuffer(a.buffer);expect(chains).toHaveLength(1);
  expect(encodePlanBuffer(chains)).toEqual(a.buffer);
  for(const c of chains)for(let i=1;i<c.prims.length;i++){
    const p=evalPrim(c.prims[i-1],1),q=evalPrim(c.prims[i],0);expect(Math.hypot(p[0]-q[0],p[1]-q[1])).toBeLessThan(1e-8);
  }
  expect(core.wasm_plan_svg(a.buffer,a.pensJson,100,100,undefined,-1,0,1)).toContain('<path');
  expect(core.wasm_plan_png(a.buffer,a.pensJson,100,100,1,undefined,0,1).length).toBeGreaterThan(100);
  expect(core.wasm_plan_toolpath(a.buffer,0.005,0,1).length).toBeGreaterThan(5);
});
it('fits a dense circular polyline and retains dots and exact existing curves',()=>{
  const ps=Array.from({length:101},(_,i)=>[50+20*Math.cos(i/100*1.5),50+20*Math.sin(i/100*1.5)]);
  const buffer=encodePlanBuffer([{index:0,pen:0,dot:false,prims:ps.slice(1).map((p,i)=>({t:'line',x0:ps[i][0],y0:ps[i][1],x1:p[0],y1:p[1]}))},
    {index:1,pen:0,dot:true,prims:[{t:'line',x0:5,y0:5,x1:5,y1:5}]}]);
  const result=core.wasm_optimize_plan(buffer,0.01,2,30,0);
  try{
    const out=decodePlanBuffer(result.plan);
    expect(out[0].prims.length).toBeLessThan(5);expect(out[0].prims[0].t).toBe('arc');expect(out[1].dot).toBe(true);
    expect(out[1].prims).toEqual(decodePlanBuffer(buffer)[1].prims);
  }finally{result.free();}
});

import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import * as core from '../../../crates/occlude-core/pkg/occlude_core.js';
import { initOcclude, sketchAsync, compileSketchAsync, render, lineArt3, box3, constructStrokes3, pen, mm, dash, decodePlanBuffer, evalPrim, stroke, sketch, smooth, type Stroke3 } from '../src/index.js';
import { compileSketch, encodeScene, renderEncoded, type WasmModule } from '../src/index.js';
import { pensToJson } from '../src/render.js';
beforeAll(async()=>{await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));});
const config={margin:0,aspect:'square' as const,pens:{ink:pen({width:mm(.2)})}};

it('anchors a multi-segment 3D wire through a box occluder and actual planned SVG',async()=>{
  let runs:readonly Stroke3[]=[];
  const execution=await compileSketchAsync(sketchAsync(config,async t=>{
    const classified=await t.classify3(lineArt3({camera:{kind:'orthographic',span:10,eye:[0,0,5],target:[0,0,0],up:[0,1,0],near:.1,far:10},objects:[{id:'box',surface:box3([1,1,1]),lineSource:false}],wires:[{id:'wire',points:[[-4,0,0],[0,0,0],[4,0,0]]}],lineSets:[]}));
    runs=constructStrokes3(classified,[{id:'visible',stroke:'ink'}]);
    const reversed=constructStrokes3({...classified,features:[...classified.features].reverse()},[{id:'visible',stroke:'ink'}]);
    expect(reversed.map(r=>[r.reference,r.sourceRanges])).toEqual(runs.map(r=>[r.reference,r.sourceRanges]));
    return t.strokes3(runs,{modifiers:[dash(mm(7),mm(4))]});
  }),{paper:{w:100,h:100}});
  expect(runs).toHaveLength(2);expect(runs[0].reference).toBe(runs[1].reference);
  expect(runs.flatMap(r=>r.sourceRanges.flat()).map(x=>Math.round(x*1e9)/1e9)).toEqual([0,.875,1.125,2]);
  const result=render(execution);
  const pens=pensToJson(result.pens);
  const plan=core.wasm_plan(result.raw.prims,result.raw.frags,pens,200000,.01);
  const chains=decodePlanBuffer(plan);
  const spans=chains.map(chain=>{
    const xs=chain.prims.flatMap(p=>[evalPrim(p,0)[0],evalPrim(p,1)[0]]);
    return [Math.min(...xs),Math.max(...xs)].map(x=>Math.round(x*1e6)/1e6);
  }).sort((a,b)=>a[0]-b[0]);
  expect(spans).toEqual([[10,17],[21,28],[32,39],[43,45],[55,61],[65,72],[76,83],[87,90]]);
  const svg=core.wasm_plan_svg(plan,pens,100,100,undefined,-1,0,1);
  expect(svg).toContain('<path');expect(svg).not.toContain('NaN');
});

it('rejects invalid source intervals; a pre-stage modifier takes the seen pieces',()=>{
  const run=(ranges:readonly (readonly [number,number])[],modifiers:NonNullable<Parameters<typeof stroke>[1]>['modifiers']=[])=>render(sketch(config,()=>stroke([[10,50],[90,50]],{stroke:'ink',strokeRanges:ranges,modifiers})),{paper:{w:100,h:100}});
  expect(()=>run([[.5,.4]])).toThrow('sorted disjoint');
  expect(()=>run([[0,2]])).toThrow('sorted disjoint');
  // A pre-stage modifier no longer refuses: the seen piece is cut out and
  // the modifier takes it as a plain polyline.
  expect(run([[0,1]],[smooth(1)]).raw.frags.length).toBeGreaterThan(0);
  expect(run([]).raw.frags.length).toBe(0);
});


it('retains ordinary scene encoding and decodes both shape-record strides',()=>{
  const scene=encodeScene(compileSketch(sketch(config,()=>stroke([[10,50],[90,50]],{stroke:'ink'})),{paper:{w:100,h:100}}));
  expect(scene.shapesF64.length).toBe(scene.shapesU32.length/12*3);
  const expanded:number[]=[];
  for(let i=0;i<scene.shapesF64.length;i+=3)expanded.push(...scene.shapesF64.slice(i,i+3),-1,0);
  const old=renderEncoded(core as unknown as WasmModule,scene);
  const next=renderEncoded(core as unknown as WasmModule,{...scene,shapesF64:new Float64Array(expanded)});
  expect(next.prims).toEqual(old.prims);expect(next.frags).toEqual(old.frags);
});

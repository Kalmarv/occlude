import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import * as core from '../../../crates/occlude-core/pkg/occlude_core.js';
import { initOcclude, sketchAsync, compileSketchAsync, render, lineArt3, constructStrokes3, pen, mm, decimate, wobble, decodePlanBuffer, evalPrim, type WasmModule } from '../src/index.js';
import { pensToJson } from '../src/render.js';
beforeAll(async()=>{await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));});

const execute=async(reverse:boolean, options:{omit?:boolean;pass?:string;wobbleFirst?:boolean;seed?:number}={})=>{
    const run=await compileSketchAsync(sketchAsync({seed:options.seed??42,margin:0,pens:{ink:pen({width:mm(.2)})}},async t=>{
      const classified=await t.classify3(lineArt3({camera:{kind:'orthographic',span:10,eye:[0,0,5],target:[0,0,0],up:[0,1,0],near:.1,far:10},wires:Array.from({length:20},(_,i)=>({id:`wire-${i}`,points:[[-4,-4+i*.4,0],[4,-4+i*.4,0]] as [number,number,number][]})),lineSets:[]}));
      const strokes=constructStrokes3(classified,[{id:'outline',stroke:'ink',select:f=>!options.omit||f.objectId!=='wire-0'}]);
      return t.strokes3(reverse?[...strokes].reverse():strokes,{pass:options.pass,modifiers:[...(options.wobbleFirst?[wobble({amount:mm(.2),wavelength:mm(6)})]:[]),decimate(.5)]});
    }),{paper:{w:100,h:100}});
    const out=render(run),plan=core.wasm_plan(out.raw.prims,out.raw.frags,pensToJson(out.pens),200000,.01);
    return decodePlanBuffer(plan).flatMap(chain=>chain.prims.map(p=>[evalPrim(p,0),evalPrim(p,1)].map(x=>x.map(v=>Math.round(v*1e6)/1e6)).sort((a,b)=>a[0]-b[0]||a[1]-b[1]))).map(p=>JSON.stringify(p)).sort();
  };
it('keeps per-source decimation when selected stroke rows are reordered',async()=>{
  const original=await execute(false);expect(original.length).toBeGreaterThan(0);expect(original.length).toBeLessThan(20);
  expect(await execute(true)).toEqual(original);
});

it('keeps unrelated sources when a selection removes an earlier shape row',async()=>{
  const original=await execute(false);
  expect(await execute(false,{omit:true})).toEqual(original.filter(s=>JSON.parse(s)[0][1]!==90));
});
it('keys ordered wobble/decimation and explicit passes independently of emitted rows',async()=>{
  const original=await execute(false,{wobbleFirst:true,pass:'ink-a'});
  expect(await execute(true,{wobbleFirst:true,pass:'ink-a'})).toEqual(original);
  expect(await execute(false,{wobbleFirst:true,pass:'ink-b'})).not.toEqual(original);
  expect(await execute(false,{wobbleFirst:true,pass:'ink-a',seed:43})).not.toEqual(original);
});

it('validates the source seed on both sides of the ABI and retains legacy source records',async()=>{
  const {sketch,stroke,compileSketch,encodeScene,renderEncoded}=await import('../src/index.js');
  const make=(strokeSeed:number)=>encodeScene(compileSketch(sketch({pens:{ink:pen({width:mm(.2)})}},()=>stroke([[10,10],[90,10]],{stroke:'ink',strokeRanges:[[0,1]],strokeSeed})),{paper:{w:100,h:100}}));
  expect(()=>make(-2)).toThrow('u32');expect(()=>make(2**32)).toThrow('u32');
  const scene=make(123);expect(scene.shapesF64).toHaveLength(6);
  for(const key of [-2,2**32,.5,NaN]){
    const values=scene.shapesF64.slice();values[5]=key;
    expect(()=>renderEncoded(core as unknown as WasmModule,{...scene,shapesF64:values})).toThrow('u32');
  }
  const values=scene.shapesF64.slice();values[5]=-1;
  const legacy=renderEncoded(core as unknown as WasmModule,{...scene,shapesF64:values.slice(0,5)});
  const extended=renderEncoded(core as unknown as WasmModule,{...scene,shapesF64:values});
  expect(extended.prims).toEqual(legacy.prims);expect(extended.frags).toEqual(legacy.frags);
});

/** Served Studio runner for the six workloads: each twice (cold, warm), capturing the worker's modeling stats and render reply timings on the real adapter. */
import {chromium} from 'playwright';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {workloads} from '../../occlude/bench/three/workloads.mjs';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273',out=process.env.OCCLUDE_API_EVIDENCE??'../occlude/bench/three/results',stamp=process.env.OCCLUDE_STAMP??'bae1191-surface-final';
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
const rows=[],errors=[];
try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.count=(window.count??0)+1;window.replyAt=performance.now();}});}};},workloads[0].src);
 await page.goto(base);await page.waitForFunction(s=>document.querySelector('#status-build')?.textContent.includes(s),stamp);
 await page.waitForFunction(()=>window.reply&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:120000});
 let adapter;
 for(const {name,src} of workloads){
  const runs=[];
  for(const pass of ['cold','warm']){
   const prior=await page.evaluate(()=>window.count);
   // A trailing comment makes the source differ per pass, so the worker re-runs the sketch without reusing a coalesced render.
   await page.evaluate(([s,tag])=>{window.startAt=performance.now();window.__occlude.editor.setValue(s+`\n// ${tag}`);},[src,pass]);
   await page.waitForFunction(n=>window.count>n&&document.querySelector('#status-msg').textContent==='ok',prior,{timeout:120000});
   const r=await page.evaluate(()=>({wallMs:window.replyAt-window.startAt,three:window.reply.three,renderMs:window.reply.renderMs,stats:Array.from(window.reply.stats)}));
   adapter??=r.three?.adapter;
   runs.push({pass,wallMs:Math.round(r.wallMs),renderMs:Math.round(r.renderMs),modeling:r.three?.modeling?.map(m=>({operation:m.operation,backend:m.backend,dispatches:m.dispatches,transferBytes:m.transferBytes,wallMs:Math.round(m.timings?.wallMs??0),hatch:m.hatch&&{traces:m.hatch.traces,segments:m.hatch.segments,tone:m.hatch.tone},mapping:m.mapping&&{outputSegments:m.mapping.outputSegments},intersections:m.intersections&&{outputSegments:m.intersections.outputSegments}})),scenes:r.three?.scenes?.map(s=>({candidates:s.candidates,dispatches:s.dispatches,refinements:s.refinements,wallMs:Math.round(s.wallMs),gpuMs:s.gpuMs}))});
   console.log(name,pass,JSON.stringify(runs.at(-1)));
  }
  rows.push({name,runs});
 }
 assert.deepEqual(errors,[]);
 await writeFile(out+'/gpu.json',JSON.stringify({base,stamp,adapter,hardware:'NVIDIA GeForce RTX 2060, Chrome via Xvfb :93, WebGPU Vulkan',rows,errors},null,2)+'\n');console.log('done');
}catch(e){await writeFile(out+'/gpu-failure.json',JSON.stringify({rows,errors,error:String(e)},null,2));throw e;}finally{await browser.close();}

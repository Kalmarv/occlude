/** Served Studio check of the eight new surface-drawing examples (three#19..26). */
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273',out=process.env.OCCLUDE_API_EVIDENCE??'../../development/3d/surface-drawing/live',stamp=process.env.OCCLUDE_STAMP??'bae1191-surface-drawing';
const sources=[...(await readFile('../../docs/three.md','utf8')).matchAll(/```ts live[^\n]*\n([\s\S]*?)```/g)].map(m=>m[1]);
const examples=(process.env.OCCLUDE_EXAMPLES??'19,20,21,22,23,24,25,26,27').split(',').map(Number);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
const results=[],errors=[];
try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.count=(window.count??0)+1;}});}};},sources[examples[0]]);
 await page.goto(base);await page.waitForFunction(s=>document.querySelector('#status-build')?.textContent.includes(s),stamp);console.log(await page.locator('#status-build').textContent());
 for(const [iteration,i] of examples.entries()){
  const started=Date.now();
  if(iteration){const prior=await page.evaluate(()=>window.count);await page.evaluate(s=>window.__occlude.editor.setValue(s),sources[i]);await page.waitForFunction(n=>window.count>n&&document.querySelector('#status-msg').textContent==='ok',prior,{timeout:90000});}
  else await page.waitForFunction(()=>window.reply&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:90000});
  const result=await page.evaluate(async()=>({stats:window.reply.three,diagnostics:await window.__occlude.editor.diagnostics(),svg:await window.__occlude.drawing.svg(undefined,-1)}));
  assert.deepEqual(result.diagnostics,[],`three#${i} diagnostics`);assert.equal(result.stats.adapter.isFallbackAdapter,false);assert(result.svg.includes('<path'),`three#${i} has paths`);
  results.push({example:`three#${i}`,ms:Date.now()-started,modeling:result.stats.modeling?.map(m=>({operation:m.operation,backend:m.backend,dispatches:m.dispatches,transferBytes:m.transferBytes,wallMs:m.timings?.wallMs,hatch:m.hatch&&{traces:m.hatch.traces,segments:m.hatch.segments,tone:m.hatch.tone},mapping:m.mapping&&{outputSegments:m.mapping.outputSegments}})),svgBytes:result.svg.length});
  await page.screenshot({path:`${out}/example-${i}.png`});await writeFile(`${out}/example-${i}.svg`,result.svg);
  console.log(JSON.stringify(results.at(-1)));
 }
 assert.deepEqual(errors,[]);await writeFile(out+'/report.json',JSON.stringify({passed:true,base,stamp,adapter:results[0]?.stats,examples:results.length,results,errors},null,2)+'\n');console.log(JSON.stringify({passed:true,examples:results.length}));
}catch(e){await writeFile(out+'/failure.json',JSON.stringify({results,errors,error:String(e)},null,2));throw e;}finally{await browser.close();}

/** Check the stored-coordinate deformation example through the ordinary Studio worker. */
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273',out=process.env.OCCLUDE_API_EVIDENCE??'../../development/3d/surface-uv/live';
const sources=[...(await readFile('../../docs/three.md','utf8')).matchAll(/```ts live[^\n]*\n([\s\S]*?)```/g)].map(m=>m[1]);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
const results=[],errors=[];
try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const timer=window.setTimeout;window.renderTimers=[];window.setTimeout=function(fn,ms,...args){if(ms===60000||ms===20000)window.renderTimers.push(ms);return timer(fn,ms,...args);};const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.count=(window.count??0)+1;}});}};},sources[26]);
 await page.goto(base);await page.waitForFunction(()=>document.querySelector('#status-build')?.textContent.includes('bce6f2b-surface-uv'));console.log(await page.locator('#status-build').textContent());
 for(const [iteration,i] of [26].entries()){
  if(iteration){const prior=await page.evaluate(()=>window.count);await page.evaluate(s=>window.__occlude.editor.setValue(s),sources[i]);await page.waitForFunction(n=>window.count>n&&document.querySelector('#status-msg').textContent==='ok',prior,{timeout:60000});}
  else await page.waitForFunction(()=>window.reply&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:60000});
  const result=await page.evaluate(async()=>({stats:window.reply.three,diagnostics:await window.__occlude.editor.diagnostics(),svg:await window.__occlude.drawing.svg(undefined,-1)}));
  assert.deepEqual(result.diagnostics,[],`three#${i}`);assert.equal(result.stats.adapter.isFallbackAdapter,false);assert(result.svg.includes('<path'));
  results.push({example:`three#${i}`,stats:result.stats,diagnostics:result.diagnostics,svgBytes:result.svg.length});if(i===26){await page.screenshot({path:out+'/example-'+i+'.png'});await writeFile(out+'/example-'+i+'.svg',result.svg);await writeFile(out+'/example-'+i+'.ts',sources[i]);}
 }
 assert.deepEqual(errors,[]);await page.screenshot({path:out+'/last-example.png'});await writeFile(out+'/report.json',JSON.stringify({passed:true,base,examples:results.length,results,errors},null,2)+'\n');console.log(JSON.stringify({passed:true,examples:results.length}));
}catch(e){await writeFile(out+'/failure.json',JSON.stringify({results,errors,error:String(e)},null,2));throw e;}finally{await browser.close();}

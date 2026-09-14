/** Served Studio check of progressive drafts: stage order, replacement, no draft after the final reply. */
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273',out=process.env.OCCLUDE_API_EVIDENCE??'../../development/3d/progressive/live',stamp=process.env.OCCLUDE_STAMP??'progressive';
const sources=[...(await readFile('../../docs/three.md','utf8')).matchAll(/```ts live[^\n]*\n([\s\S]*?)```/g)].map(m=>m[1]);
const examples=(process.env.OCCLUDE_EXAMPLES??'23,27').split(',').map(Number);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
const results=[],errors=[];
try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{const d=e.data;if(d.type==='draft'){(window.drafts??=[]).push({id:d.id,revision:d.revision,stage:d.stage,scene:d.scene,progress:d.progress,segments:d.segments?d.segments.length/4:undefined,frags:d.frags?d.frags.length:undefined,at:performance.now()});}if(d.type==='render'){window.reply=d;window.count=(window.count??0)+1;window.finalAt=performance.now();}});}};},sources[examples[0]]);
 await page.goto(base);await page.waitForFunction(s=>document.querySelector('#status-build')?.textContent.includes(s),stamp);console.log(await page.locator('#status-build').textContent());
 for(const [iteration,i] of examples.entries()){
  await page.evaluate(()=>{window.drafts=[];});
  if(iteration){const prior=await page.evaluate(()=>window.count);await page.evaluate(s=>window.__occlude.editor.setValue(s),sources[i]);await page.waitForFunction(n=>window.count>n&&document.querySelector('#status-msg').textContent==='ok',prior,{timeout:90000});}
  else await page.waitForFunction(()=>window.reply&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:90000});
  const info=await page.evaluate(()=>({drafts:window.drafts,finalAt:window.finalAt,replyId:window.reply.id,status:document.querySelector('#status-msg').textContent}));
  const mine=info.drafts.filter(d=>d.id===info.replyId);
  assert(mine.length>=4,`three#${i}: expected staged drafts, got ${JSON.stringify(mine)}`);
  assert.deepEqual(mine.map(d=>d.revision),mine.map((_,k)=>k+1),'revisions rise by one');
  const stages=mine.map(d=>d.stage);
  assert(stages.indexOf('source')<stages.indexOf('classified')&&stages.indexOf('classified')<stages.indexOf('finished'),`stage order ${stages}`);
  assert(mine.every(d=>d.at<=info.finalAt),'drafts precede the final reply');
  assert(mine.find(d=>d.stage==='classified').segments<=mine.find(d=>d.stage==='source').segments,'visible lines are not more than source lines');
  const modeling=mine.filter(d=>d.stage==='modeling');
  if(i===23)assert(modeling.length>0&&modeling.every(d=>d.progress.operation==='hatch'),'hatch progress events');
  results.push({example:`three#${i}`,stages:[...new Set(stages)],modelingEvents:modeling.length,lastProgress:modeling.at(-1)?.progress,segments:mine.map(d=>d.segments??d.frags??null),firstLinesMs:Math.round(mine.find(d=>d.segments)?.at-mine[0].at),finalMs:Math.round(info.finalAt-mine[0].at)});
  console.log(JSON.stringify(results.at(-1)));
  await page.screenshot({path:`${out}/example-${i}-final.png`});
 }
 // A render over an existing result: capture the draft layer mid-flight.
 await page.evaluate(()=>{window.drafts=[];});
 const prior=await page.evaluate(()=>window.count);
 await page.evaluate(s=>window.__occlude.editor.setValue(s.replace('seed: 42','seed: 7')),sources[examples[0]]);
 await page.waitForFunction(()=>(window.drafts??[]).some(d=>d.stage==='classified'),{},{timeout:90000});
 await page.screenshot({path:`${out}/mid-render.png`});
 await page.waitForFunction(n=>window.count>n&&document.querySelector('#status-msg').textContent==='ok',prior,{timeout:90000});
 assert.deepEqual(errors,[]);
 await writeFile(out+'/report.json',JSON.stringify({passed:true,base,stamp,results,errors},null,2)+'\n');console.log(JSON.stringify({passed:true,examples:results.length}));
}catch(e){await writeFile(out+'/failure.json',JSON.stringify({results,errors,error:String(e)},null,2));throw e;}finally{await browser.close();}

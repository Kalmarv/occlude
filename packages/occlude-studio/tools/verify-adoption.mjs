import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const output=resolve(process.env.OCCLUDE_GPU_EVIDENCE??'../../development/3d/playwright-adoption');
await mkdir(output,{recursive:true});
const source=width=>`import {sketch,box3,lineArt3,paper,pen,mm} from 'occlude';
export default sketch({seed:42,paper:paper({width:mm(200),height:mm(200)}),pens:{ink:pen({width:mm(.3),color:'#18202A'})}},()=>lineArt3({camera:{kind:'orthographic',span:5,eye:[4,-6,4],target:[0,0,0],near:.1,far:30},objects:[{id:'cube',surface:box3([${width},1,1])}],lineSets:[{id:'edges',stroke:'ink'}]}));`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
let page;
try{
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>{errors.push(String(e));console.error(String(e));});
  page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
  await page.addInitScript(source=>{
    localStorage.setItem('occlude.sketch',source);
    window.requests=[];window.held=null;window.holdNextRender=false;window.renderReplies=[];
    const OriginalWorker=window.Worker;
    window.Worker=class extends OriginalWorker{
      set onmessage(handler){super.onmessage=e=>{
        if(e.data.type==='render')window.renderReplies.push({id:e.data.id,hash:e.data.planHash,three:e.data.three});
        if(e.data.type==='render'&&window.holdNextRender){window.holdNextRender=false;window.held={id:e.data.id,release:()=>handler(e)};return;}
        handler(e);
      };}
      postMessage(message,...rest){window.requests.push({type:message.type,id:message.id});return super.postMessage(message,...rest);}
    };
  },source(1));
  await page.goto(base);
  await page.waitForFunction(()=>window.__occlude?.drawing.plan&&window.renderReplies.length,{},{timeout:60000});
  console.log('initial drawing ready');
  const original=await page.evaluate(async()=>({hash:window.__occlude.drawing.plan.planHash,svg:await window.__occlude.drawing.svg(undefined,-1),reply:window.renderReplies.at(-1)}));
  assert.equal(original.reply.three.adapter.isFallbackAdapter,false);
  const scenarios=[];
  for(const mode of ['render','camera']){
    if(mode==='render')await page.evaluate(source=>{window.held=null;window.holdNextRender=true;window.__occlude.editor.replaceValue(source);},source(2));
    else{
      await page.evaluate(source=>window.__occlude.editor.replaceValue(source),source(1));
      await page.waitForFunction(hash=>document.querySelector('#status-msg').textContent==='ok'&&window.__occlude.drawing.plan.planHash===hash,original.hash,{timeout:60000});
      await page.getByRole('button',{name:'3D',exact:true}).click();
      const canvas=page.locator('#construction-canvas');await page.waitForFunction(()=>!!document.querySelector('#construction-canvas').dataset.revision);
      const r=await canvas.boundingBox();
      await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+60,r.y+r.height/2+15,{steps:5});await page.mouse.up();
      await page.evaluate(()=>{window.held=null;window.holdNextRender=true;});
      await page.getByRole('button',{name:'Commit view',exact:true}).click();
    }
    console.log('waiting for held '+mode+' reply');
    await page.waitForFunction(()=>window.held,{},{timeout:60000});
    const held=await page.evaluate(async()=>({id:window.held.id,hash:window.__occlude.drawing.plan.planHash,svg:await window.__occlude.drawing.svg(undefined,-1)}));
    assert.equal(held.hash,original.hash);assert.equal(held.svg,original.svg,'staged work must leave committed exports usable');
    await page.evaluate(()=>window.__occlude.editor.replaceValue('throw new Error("replacement failure");'));
    await page.waitForTimeout(250); // replacement compilation is debounced by 150 ms
    await page.evaluate(()=>window.held.release());
    await page.waitForFunction(()=>document.querySelector('#status-msg').textContent.includes('replacement failure'),{},{timeout:60000});
    const after=await page.evaluate(async()=>({hash:window.__occlude.drawing.plan.planHash,svg:await window.__occlude.drawing.svg(undefined,-1),requests:window.requests,status:document.querySelector('#status-msg').textContent}));
    assert.equal(after.hash,original.hash);assert.equal(after.svg,original.svg);
    assert(after.requests.some(m=>m.type==='discard-render'&&m.id===held.id));
    assert(!after.requests.some(m=>m.type==='accept-render'&&m.id===held.id));
    scenarios.push({mode,heldId:held.id,hash:after.hash,status:after.status,discarded:true,svgPreserved:true});
  }
  assert.deepEqual(errors,[]);
  const toggle=page.getByRole('button',{name:'3D',exact:true});
  if(await toggle.getAttribute('aria-pressed')==='true')await toggle.click();
  await page.screenshot({path:resolve(output,'previous-result.png'),fullPage:true});
  await writeFile(resolve(output,'report.json'),JSON.stringify({passed:true,base,browser:browser.version(),adapter:original.reply.three.adapter,scenarios,errors},null,2)+'\n');
  console.log(JSON.stringify({passed:true,scenarios}));
}catch(error){
  if(page){console.error(await page.evaluate(()=>({status:document.querySelector('#status-msg')?.textContent,requests:window.requests,replies:window.renderReplies,editor:window.__occlude?.editor.getValue()})));await page.screenshot({path:resolve(output,'failure.png'),fullPage:true});}
  throw error;
}finally{await browser.close();}

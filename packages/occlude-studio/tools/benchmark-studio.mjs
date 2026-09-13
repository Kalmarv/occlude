import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273',output=resolve(process.env.OCCLUDE_GPU_EVIDENCE??'../../development/3d/benchmark-retained');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.addInitScript(()=>{
    window.renders=[];const Original=window.Worker;
    window.Worker=class extends Original{constructor(...args){super(...args);this.addEventListener('message',event=>{if(event.data.type==='render')window.renders.push(event.data);});}};
  });
  await page.goto(base);await page.waitForFunction(()=>window.__occlude?.editor);
  await page.evaluate(()=>window.__occlude.editor.setValue(`import { sketch, grid3, lineArt3, paper, pen, mm } from 'occlude';
export default sketch({ seed:42, paper:paper({width:mm(200),height:mm(200)}), margin:0, pens:{ink:pen({width:mm(.2),color:'#18202A'})}},()=>{
  const surface=grid3(100,100,[12,12]);
  for(const p of surface.points){const [x,y]=p.position;p.position=[x,y,.15*Math.sin(x*2)*Math.cos(y*2)];}
  return lineArt3({objects:[{id:'grid',surface}],camera:{kind:'orthographic',span:16,eye:[8,-10,12],target:[0,0,0],near:.1,far:50},lineSets:[{id:'all',stroke:'ink'}]});
});`));
  await page.waitForFunction(()=>window.renders.at(-1)?.construction?.[0]?.triangles===20000,{},{timeout:60000});
  await page.getByRole('button',{name:'3D',exact:true}).click();
  const canvas=page.locator('#construction-canvas');await page.waitForFunction(()=>!!document.querySelector('#construction-canvas')?.dataset.revision);
  const bounds=await canvas.boundingBox();assert(bounds);
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();
  const result=await page.evaluate(async({x,y})=>{
    const canvas=document.querySelector('#construction-canvas'),times=[],initial=window.renders.length,hash=window.renders.at(-1).planHash;
    const observer=new MutationObserver(()=>times.push(performance.now()));observer.observe(canvas,{attributes:true,attributeFilter:['data-revision']});
    const start=performance.now();
    await new Promise(resolve=>{let i=0;const tick=()=>{canvas.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,clientX:x+Math.sin(i*.08)*80,clientY:y+Math.sin(i*.03)*20,bubbles:true}));if(++i<120)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
    const elapsed=performance.now()-start;observer.disconnect();
    return {elapsedMs:elapsed,presentedFrames:times.length,presentedFps:times.length*1000/elapsed,frameTimesMs:times.slice(1).map((t,i)=>t-times[i]),unchangedPlan:hash===window.renders.at(-1).planHash,renderRequestsDuringOrbit:window.renders.length-initial,triangles:window.renders.at(-1).construction[0].triangles,adapter:window.renders.at(-1).three.adapter};
  },{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2});
  await page.mouse.up();
  assert(result.unchangedPlan);assert.equal(result.renderRequestsDuringOrbit,0);assert.equal(result.adapter.isFallbackAdapter,false);assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(output,'studio-orbit.png'),fullPage:true});
  await writeFile(resolve(output,'studio-orbit.json'),JSON.stringify({base,browser:browser.version(),...result,errors},null,2));
  console.log(JSON.stringify(result));
}finally{await browser.close();}

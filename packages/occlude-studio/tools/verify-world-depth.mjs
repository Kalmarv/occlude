/** Main Studio hardware probes: one-ULP depths and clipped ray hits. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273',out=process.env.OCCLUDE_API_EVIDENCE??'../../development/3d/paper-world-depth/probes';
await mkdir(out,{recursive:true});
const cases=[];
for(const z of [-.8000000000000002,-.8,-.7999999999999999])cases.push({id:`ulp-${z}`,points:[[-1,-1,z],[1,-1,z],[0,1,z]],wire:[[-2,0,-.8],[2,0,-.8]],camera:{kind:'orthographic',span:5,eye:[0,0,-5],target:[0,0,0],up:[0,1,0],near:.1,far:10},expected:z<-.8?[[.375,.625]]:[]});
for(const kind of ['orthographic','perspective'])for(const near of [.1,2,2.9])cases.push({id:`${kind}-near-${near}`,points:[[-1,-1,-1],[1,-1,-3],[0,1,-2]],wire:[[-2,0,-4],[2,0,-4]],camera:{kind,...(kind==='orthographic'?{span:5}:{fovDegrees:50}),eye:[0,0,0],target:[0,0,-1],up:[0,1,0],near,far:5},expected:near===2.9?[]:[near===2?[.5,kind==='orthographic'?.625:.7]:kind==='orthographic'?[.375,.625]:[1/6,.7]]});
const source=r=>`import {sketch,strokes} from 'occlude';
import {mesh,polyline,view} from 'occlude/3d';
export default sketch({seed:42},()=>view([mesh(${JSON.stringify(r.points)},[[0,1,2]]).withKey('triangle'),polyline(${JSON.stringify(r.wire)}).withKey('wire')],{camera:${JSON.stringify(r.camera)}},lines=>{console.info('world-depth:'+JSON.stringify(lines.hidden.filter(c=>c.feature.objectId==='wire').map(c=>c.range)));return strokes(lines.visible);}));`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
const results=[],errors=[];
try{
 const page=await browser.newPage();let actual;
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.text().startsWith('world-depth:'))actual=JSON.parse(m.text().slice(12));});
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.count=(window.count??0)+1;}});}};},source(cases[0]));
 await page.goto(base);
 for(let i=0;i<cases.length;i++){
  if(i){const n=await page.evaluate(()=>window.count);actual=undefined;await page.evaluate(s=>window.__occlude.editor.setValue(s),source(cases[i]));await page.waitForFunction(n=>window.count>n&&document.querySelector('#status-msg').textContent==='ok',n,{timeout:60000});}
  else await page.waitForFunction(()=>window.reply&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:60000});
  const stats=await page.evaluate(()=>window.reply.three);assert.equal(stats.adapter.isFallbackAdapter,false);assert.deepEqual(await page.evaluate(()=>window.__occlude.editor.diagnostics()),[]);
  const expected=cases[i].expected;results.push({...cases[i],actual,stats});
  assert(actual);assert.equal(actual.length,expected.length,cases[i].id);expected.forEach((span,j)=>span.forEach((v,k)=>assert(Math.abs(v-actual[j][k])<1e-5,cases[i].id)));
 }
 assert.deepEqual(errors,[]);await writeFile(out+'/report.json',JSON.stringify({passed:true,base,results,errors},null,2)+'\n');console.log(JSON.stringify({passed:true,cases:results.length}));
}catch(e){await writeFile(out+'/failure.json',JSON.stringify({results,errors,error:String(e)},null,2));throw e;}finally{await browser.close();}

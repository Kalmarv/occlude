/** Main Studio: rational source incidence and clipped GPU refinement. */
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273',out=process.env.OCCLUDE_API_EVIDENCE??'../../development/3d/supported-curves/rational';
await mkdir(out,{recursive:true});
const cases=[{z:0,near:.1},{z:Number.EPSILON,near:.1},{z:0,near:6.52},{z:Number.EPSILON,near:6.52}];
const source=r=>`import {sketch,strokes} from 'occlude';
import {mesh,view,orthographic} from 'occlude/3d';
import {SurfaceCurves,surfaceBinding3,surfaceCurveNetwork3} from 'occlude/3d/advanced';
export default sketch({seed:42},()=>{
 const a=mesh([[1,0,0],[0,1,0],[0,0,1]],[[0,1,2]]),b=mesh([[0,0,0],[1,1,0],[0,0,1]],[[0,1,2]]);
 const c=mesh([[1,0,${r.z}],[0,1,${r.z}],[0,0,${1+r.z}]],[[0,1,2]]);
 const curves=new SurfaceCurves(surfaceCurveNetwork3({sources:[{id:'a',binding:surfaceBinding3(a.surface)},{id:'b',binding:surfaceBinding3(b.surface)}],nodes:[{id:'p',point:[1n,1n,1n,3n]},{id:'q',point:[2n,2n,1n,5n]}],segments:[{id:'seam',kind:'intersection',a:'p',b:'q',supports:[{source:0,triangle:0},{source:1,triangle:0}]}]})).withKey('seam');
 return view([a,b,c,curves],{camera:orthographic({eye:[3,4,5],target:[0,0,0],span:2,near:${r.near},far:10})},lines=>{
  console.info('rational:'+JSON.stringify({frame:lines.visible.source.frame,hidden:lines.hidden.filter(c=>c.kinds.has('intersection')).map(c=>c.range),visible:lines.visible.filter(c=>c.kinds.has('intersection')).map(c=>c.range),features:lines.visible.source.features.filter(r=>r.feature.flags===128).map(r=>({range:r.feature.range,basis:r.feature.basis}))}));
  return strokes(lines.visible);
 });
});`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
const results=[],errors=[];
try{
 const page=await browser.newPage();let actual;
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.text().startsWith('rational:'))actual=JSON.parse(m.text().slice(9));});
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.count=(window.count??0)+1;}});}};},source(cases[0]));
 await page.goto(base);await page.waitForFunction(()=>document.querySelector('#status-build')?.textContent.includes('e9e4e60-supported-curves'));
 for(let i=0;i<cases.length;i++){
  if(i){const n=await page.evaluate(()=>window.count);actual=undefined;await page.evaluate(s=>window.__occlude.editor.setValue(s),source(cases[i]));await page.waitForFunction(n=>window.count>n&&document.querySelector('#status-msg').textContent==='ok',n,{timeout:60000});}
  else await page.waitForFunction(()=>window.reply&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:60000});
  const stats=await page.evaluate(()=>window.reply.three);assert.equal(stats.adapter.isFallbackAdapter,false);assert.deepEqual(await page.evaluate(()=>window.__occlude.editor.diagnostics()),[]);
  assert(actual);assert.equal(actual.features.length,1);
  const oracle=spawnSync('python3',['../../development/3d/supported-curves/rational-oracle.py'],{input:JSON.stringify({z:cases[i].z,frame:actual.frame,basis:actual.features[0].basis}),encoding:'utf8'});
  assert.equal(oracle.status,0,oracle.stderr);const expected=JSON.parse(oracle.stdout);results.push({...cases[i],actual,expected,stats});
  assert.deepEqual(actual.hidden,expected.hidden);assert.deepEqual(actual.visible,expected.visible);
  if(cases[i].near>1)assert(actual.features[0].range[0]>0&&actual.features[0].range[0]<1);
  assert(actual.features[0].basis.every(terms=>terms.every(t=>t.exactWorld)));
 }
 assert.deepEqual(errors,[]);await writeFile(out+'/report.json',JSON.stringify({passed:true,base,results,errors},null,2)+'\n');console.log(JSON.stringify({passed:true,cases:results.length}));
}catch(e){await writeFile(out+'/failure.json',JSON.stringify({results,errors,error:String(e)},null,2));throw e;}finally{await browser.close();}

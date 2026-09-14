/** Served main Studio phase accounting, independent query oracles and retained camera. */
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const output=process.env.OCCLUDE_API_EVIDENCE??'../../development/3d/phase-accounting/served';
const source=await readFile('../../development/3d/phase-accounting/workload.ts','utf8');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
let page;
try{
 page=await browser.newPage({viewport:{width:1440,height:1000}});let models=0;const proofs=[],errors=[];
 page.on('console',m=>{if(m.text()==='phase-model')models++;if(m.text().startsWith('phase-proof:'))proofs.push(JSON.parse(m.text().slice(12)));});page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.count=(window.count??0)+1;}});}};},source);
 const ready=()=>page.waitForFunction(()=>window.reply&&window.__occlude?.drawing.plan&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:90000});
 const capture=()=>page.evaluate(async()=>({hash:window.reply.planHash,stats:window.reply.three,svg:await window.__occlude.drawing.svg('#fff',-1)}));
 const keys=['captureMs','queueMs','setupMs','packingMs','uploadSubmitMs','dispatchSubmitMs','readbackWaitMs','readbackCopyMs','refinementMs','candidateMs','finalizeMs','validationWaitMs','cpuMs'];
 const valid=t=>{assert(t);for(const key of [...keys,'wallMs','unattributedMs']){assert(Number.isFinite(t[key]),key);assert(t[key]>=-1e-6,`${key} must not hide double counting: ${t[key]}`);}assert(Math.abs(keys.reduce((sum,key)=>sum+t[key],t.unattributedMs)-t.wallMs)<1e-6);};
 await page.goto(base);await ready();const first=await capture();
 assert.deepEqual(await page.evaluate(()=>window.__occlude.editor.diagnostics()),[]);
 assert.equal(first.stats.adapter.isFallbackAdapter,false);assert.equal(models,1);assert.equal(proofs.length,1);
 const proof=proofs[0];assert.equal(proof.points,289);for(const key of ['hitProof','rayProof','segmentProof','deformProof','agreement'])assert(proof[key],key);assert.equal(proof.empty,0);
 const [deform,zero,cold,warm,rays,segments,empty]=first.stats.modeling;
 assert.equal(first.stats.modeling.length,7);assert.equal(deform.dispatches,12);assert.equal(zero.dispatches,0);
 assert.equal(cold.targetCacheHit,false);assert(cold.targetUploadBytes>0);
 for(const row of [warm,rays,segments,empty]){assert.equal(row.targetCacheHit,true);assert.equal(row.targetUploadBytes,0);}
 assert.equal(empty.dispatches,0);assert.equal(empty.transferBytes,0);
 for(const row of [...first.stats.modeling,...first.stats.scenes])valid(row.timings);
 for(const row of [zero,empty])for(const key of ['packingMs','uploadSubmitMs','dispatchSubmitMs','readbackWaitMs','readbackCopyMs'])assert.equal(row.timings[key],0);
 assert(warm.timings.queueMs>0,'concurrent second batch must record host queue delay');
 assert(deform.timings.readbackWaitMs>0);assert(first.stats.scenes[0].timings.captureMs>0);
 valid(proof.cpu.timings);assert.equal(proof.cpu.timings.uploadSubmitMs,0);assert.equal(proof.cpu.timings.readbackWaitMs,0);
 assert(proof.gpuCallMs>=proof.gpu.timings.wallMs);assert(proof.viewCaptureMs>=0&&proof.cpuSnapshotMs>=0);
 await page.screenshot({path:output+'/drawing.png'});await writeFile(output+'/drawing.svg',first.svg);
 await page.getByRole('button',{name:'3D',exact:true}).click();await page.getByLabel('Projection',{exact:true}).selectOption('perspective');
 assert.equal((await capture()).svg,first.svg);
 await page.getByRole('button',{name:'Commit view',exact:true}).click();
 await page.waitForFunction(hash=>window.reply.planHash!==hash&&document.querySelector('.construction-pick')?.textContent?.startsWith('View committed.'),first.hash,{timeout:90000});
 const committed=await capture();assert.equal(models,1);for(const row of committed.stats.scenes)valid(row.timings);
 await page.reload();await ready();const repeated=await capture();assert.equal(repeated.svg,first.svg);assert.equal(repeated.hash,first.hash);assert.equal(models,2);
 assert.deepEqual(errors,[]);
 await writeFile(output+'/report.json',JSON.stringify({passed:true,base,first,committedStats:committed.stats,repeatedHash:repeated.hash,proofs,models,errors},null,2));
 console.log('GPU phase sums, queue/cache behavior, zero-work paths, CPU reference, analytic queries and stable ink passed.');
}catch(error){if(page)await page.screenshot({path:output+'/failure.png'});throw error;}finally{await browser.close();}

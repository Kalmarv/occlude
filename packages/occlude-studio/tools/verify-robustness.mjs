import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const directory=resolve(process.env.OCCLUDE_GPU_EVIDENCE??'../../development/3d/robustness');
await mkdir(directory,{recursive:true});
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try{
  const page=await browser.newPage();
  await page.goto(`${base}/three.html`);await page.waitForFunction(()=>window.threeLabApi?.createBenchmarkWorker);
  const report=await page.evaluate(()=>new Promise((resolve,reject)=>{
    const worker=window.threeLabApi.createBenchmarkWorker();
    const timeout=setTimeout(()=>{worker.terminate();reject(new Error('robustness worker timed out'));},60000);
    worker.onerror=e=>{clearTimeout(timeout);reject(new Error(e.message));};
    worker.onmessage=e=>{if(e.data.type==='result'){clearTimeout(timeout);resolve(e.data.report);}else if(e.data.type==='error'){clearTimeout(timeout);reject(new Error(e.data.message));}};
    worker.postMessage({type:'robustness'});
  }));
  assert.equal(report.adapter.isFallbackAdapter,false);assert(report.passed);
  assert.equal(report.boundaries.length,4);assert.equal(report.interleaved.length,8);
  assert.equal(report.remainingExplicitBuffers,0);
  assert(report.failedGenerationRejected && report.cancelledExecutionRejected && report.priorExportUnchanged);
  await writeFile(resolve(directory,'report.json'),JSON.stringify({base,browser:browser.version(),...report},null,2)+'\n');
  console.log(JSON.stringify({passed:true,adapter:report.adapter,boundaries:report.boundaries.length,interleaved:report.interleaved.length}));
}finally{await browser.close();}

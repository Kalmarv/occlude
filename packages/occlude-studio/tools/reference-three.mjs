import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const directory=resolve('../../development/3d/reference');
const fixtures=JSON.parse(await readFile(resolve(directory,'fixtures.json'),'utf8'));
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try{
  const page=await browser.newPage();
  await page.goto(`${base}/three.html`);await page.waitForFunction(()=>window.threeLabApi?.createBenchmarkWorker);
  const report=await page.evaluate(fixtures=>new Promise((resolve,reject)=>{
    const worker=window.threeLabApi.createBenchmarkWorker();
    const timeout=setTimeout(()=>{worker.terminate();reject(new Error('reference worker timed out'));},60000);
    worker.onerror=e=>{clearTimeout(timeout);reject(new Error(e.message));};
    worker.onmessage=e=>{if(e.data.type==='result'){clearTimeout(timeout);resolve(e.data.report);}else if(e.data.type==='error'){clearTimeout(timeout);reject(new Error(e.data.message));}};
    worker.postMessage({type:'reference',fixtures});
  }),fixtures);
  assert.equal(report.adapter.isFallbackAdapter,false);assert.equal(report.cases.length,fixtures.reduce((n,c)=>n+c.visibility.length,0));
  assert(report.cases.some(c=>c.stats.dispatches>0));
  await writeFile(resolve(directory,'gpu.json'),JSON.stringify({base,browser:browser.version(),...report},null,2)+'\n');
  console.log(JSON.stringify({passed:true,adapter:report.adapter,cases:report.cases.length}));
}finally{await browser.close();}

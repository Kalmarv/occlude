import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const output=resolve(process.env.OCCLUDE_GPU_EVIDENCE??'../../development/3d/benchmark');
await mkdir(output,{recursive:true});
let hardware='unavailable';try{hardware=execFileSync('nvidia-smi',['--query-gpu=name,driver_version,memory.total','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim();}catch{}
const launchStart=performance.now();
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
const browserLaunchMs=performance.now()-launchStart;
try{
  const page=await browser.newPage();
  await page.exposeFunction('benchmarkProgress',message=>console.log(message));
  await page.exposeFunction('benchmarkSvg',(name,svg)=>writeFile(resolve(output,`${name}.svg`),svg));
  await page.goto(`${base}/three.html`);await page.waitForFunction(()=>window.threeLabApi?.createBenchmarkWorker);
  const report=await page.evaluate(()=>new Promise((resolve,reject)=>{
    const worker=window.threeLabApi.createBenchmarkWorker();
    worker.onerror=e=>reject(new Error(e.message));
    worker.onmessage=e=>{const m=e.data;if(m.type==='result')resolve(m.report);else if(m.type==='error')reject(new Error(m.message));else if(m.type==='svg')void window.benchmarkSvg(m.name,m.svg);else void window.benchmarkProgress(m.type==='case'?JSON.stringify(m.entry):m.message);};
    worker.postMessage({});
  }));
  assert(report.passed);assert.equal(report.adapter.isFallbackAdapter,false);
  assert(report.cases.some(c=>c.triangles>=10000&&c.features>=10000));
  await writeFile(resolve(output,'report.json'),JSON.stringify({base,browser:browser.version(),hardware,browserLaunchMs,...report},null,2));
  console.log(JSON.stringify({passed:true,orbit:report.orbit,overlap:report.overlap}));
}finally{await browser.close();}

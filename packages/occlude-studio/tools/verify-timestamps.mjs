/** Direct hardware check of timed/untimed classification and bounded readback. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const output=resolve(process.env.OCCLUDE_GPU_EVIDENCE??'../../development/3d/timestamps');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`${base}/three.html`);await page.waitForFunction(()=>window.threeLabApi?.GpuIntervals3);
  const report=await page.evaluate(async()=>{
    const {GpuIntervals3}=window.threeLabApi;
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    const supported=adapter.features.has('timestamp-query'),cases=[];
    const pairs=Array.from({length:129},()=>({a:[-2,0,-2],b:[2,0,-2],volume:{planes:[[1,0,0,1],[-1,0,0,1],[0,1,0,1],[0,0,-1,-1]]}}));
    for(const options of [{timestamps:true,memoryBudgetBytes:1024},{timestamps:false,memoryBudgetBytes:1024},{timestamps:true,memoryBudgetBytes:128},{timestamps:true,memoryBudgetBytes:1024,hideFeature:true}]){
      const gpu=options.hideFeature ? {requestAdapter:async()=>({features:new Set([...adapter.features].filter(f=>f!=='timestamp-query')),info:adapter.info,requestDevice:adapter.requestDevice.bind(adapter)})} : navigator.gpu;
      const session=await GpuIntervals3.create(gpu,{requireHardware:true,...options});
      try {
        const empty=await session.classify([]),first=await session.classify(pairs),second=await session.classify(pairs);
        cases.push({options,enabled:session.timestampsEnabled,empty,first,second});
      } finally {await session.dispose();}
    }
    return {supported,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},cases};
  });
  assert.equal(report.adapter.isFallbackAdapter,false);
  for(const c of report.cases){
    const expected=report.supported&&!c.options.hideFeature&&c.options.timestamps&&c.options.memoryBudgetBytes>=160;
    assert.equal(c.enabled,expected);assert.equal(c.empty.gpuMs,expected?0:undefined);
    for(const r of [c.first,c.second]){
      assert(r.dispatches>1);assert(r.residentBytes<=c.options.memoryBudgetBytes);
      assert.equal(r.transferBytes,129*112+(expected?r.dispatches*16:0));
      assert.equal(r.intervals.length,129);
      for(const range of r.intervals){assert(Math.abs(range[0]-.25)<1e-6);assert(Math.abs(range[1]-.75)<1e-6);}
      if(expected){assert(Number.isFinite(r.gpuMs)&&r.gpuMs>=0);assert(r.gpuMs<=r.wallMs+1);}else assert.equal(r.gpuMs,undefined);
    }
  }
  assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'report.json'),JSON.stringify({passed:true,base,browser:browser.version(),...report,errors},null,2));
  console.log(JSON.stringify({passed:true,supported:report.supported,cases:report.cases.map(c=>({enabled:c.enabled,dispatches:c.first.dispatches,gpuMs:c.first.gpuMs,wallMs:c.first.wallMs,residentBytes:c.first.residentBytes}))}));
} finally {await browser.close();}

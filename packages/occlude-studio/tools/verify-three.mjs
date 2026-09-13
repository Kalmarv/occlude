/** Real-browser GPU gate. Hardware is required unless --software is explicit.
 * Linux NVIDIA: xvfb-run -a node tools/verify-three.mjs
 * Start the isolated dev service first. No production stores or plotter access. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const software = process.argv.includes('--software');
const output = resolve(process.env.OCCLUDE_GPU_EVIDENCE ?? (software ? '../../development/3d/playwright-m1-software' : '../../development/3d/playwright-m1'));
await mkdir(output, { recursive: true });
const args = ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader'] : ['--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'])];
const browser = await chromium.launch({ executablePath: process.env.OCCLUDE_CHROME ?? '/usr/bin/google-chrome', headless: software, env: { ...process.env, ...(software ? {} : { VK_DRIVER_FILES: process.env.VK_DRIVER_FILES ?? '/usr/share/vulkan/icd.d/nvidia_icd.json' }) }, args });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, recordVideo: { dir: output } });
const page = await context.newPage();
const errors = [];
await page.addInitScript(() => {
  window.mainAdapterRequests = 0;
  if (navigator.gpu) {
    const request = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = (...args) => { window.mainAdapterRequests++; return request(...args); };
  }
});
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

try {
  await page.goto(`${process.env.OCCLUDE_GPU_URL ?? 'http://127.0.0.1:5273'}/three.html`);
  await page.waitForFunction(() => !!window.threeEvidence || document.querySelector('#status').textContent.includes('Error'), {}, { timeout: 60000 });
  const orthographic = await page.evaluate(() => window.threeEvidence);
  assert(orthographic?.passed, await page.locator('#status').innerText());
  assert.equal(orthographic.adapter.isFallbackAdapter, software, 'adapter class must match the requested verification lane');
  assert.equal(orthographic.worker, true, 'viewport and compute must run in the construction worker');
  assert.equal(orthographic.gpu.refinements, 0, 'ordinary fixture must exercise GPU geometry rather than CPU refinement');
  assert.equal(orthographic.gpu.dispatches, 1);
  assert(orthographic.svgPaths > 0);
  await page.screenshot({ path: resolve(output, 'orthographic.png'), fullPage: true });
  await page.selectOption('#projection', 'perspective');
  await page.click('#run');
  await page.waitForFunction(() => window.threeEvidence?.projection === 'perspective' || document.querySelector('#status').textContent.includes('Error'));
  assert.equal(await page.evaluate(() => window.threeEvidence?.projection), 'perspective', await page.locator('#status').innerText());
  const perspective = await page.evaluate(() => window.threeEvidence);
  assert.equal(perspective.gpu.dispatches, 1);
  await page.screenshot({ path: resolve(output, 'perspective.png'), fullPage: true });
  const downloadPromise = page.waitForEvent('download'); await page.click('#download');
  const download = await downloadPromise; await download.saveAs(resolve(output, 'visibility.svg'));
  assert.equal(await page.evaluate(() => window.mainAdapterRequests), 0, 'normal laboratory UI must not acquire a main-thread GPU device');
  const batch = await page.evaluate(async ({ requireHardware }) => {
    const { GpuIntervals3, occlusionVolume3, hiddenInterval3 } = window.threeLabApi;
    const session = await GpuIntervals3.create(navigator.gpu, { memoryBudgetBytes: 128 * 17, requireHardware });
    try {
      const pairs = [];
      const triangle = [[-1,-1,-2],[1,-1,-2],[0,1,-2]];
      for (let j=0;j<128;j++) {
        const a=[-3,Math.sin(j)*2,-0.5-j%4], b=[3,Math.cos(j)*2,-3-j/3];
        pairs.push({a,b,volume:occlusionVolume3(triangle,j%2===0)});
      }
      const cpuStart = performance.now();
      const reference = pairs.map(p=>hiddenInterval3(p.a,p.b,p.volume));
      const cpuMs = performance.now() - cpuStart;
      const result = await session.classify(pairs);
      for (let i=0;i<pairs.length;i++) {
        const a=reference[i], b=result.intervals[i];
        if ((a===null)!==(b===null) || (a && a.some((v,j)=>Math.abs(v-b[j])>1e-5))) throw new Error(`GPU/CPU mismatch at pair ${i}`);
      }
      const empty = await session.classify([]);
      if (empty.dispatches!==0) throw new Error('empty job dispatched GPU work');
      const controller=new AbortController();controller.abort();
      let cancelled=false;
      try { await session.classify(pairs,{signal:controller.signal}); } catch(e) { cancelled=e.name==='AbortError'; }
      if(!cancelled) throw new Error('aborted job was adopted');
      const owned = structuredClone(pairs.slice(0,1)); 
      const pending=session.classify(owned);owned[0].a[0]=1e9;
      const snapshot=await pending;
      if(JSON.stringify(snapshot.intervals[0])!==JSON.stringify(result.intervals[0])) throw new Error('submission did not capture inputs');
      const coplanar = await session.classify([{a:[-.1,0,-2],b:[.1,0,-2],volume:occlusionVolume3(triangle,false)}]);
      if(coplanar.refinements!==1 || coplanar.intervals[0]!==null) throw new Error('uncertain coplanar case was not refined');
      session.device.destroy(); await session.device.lost;
      let lossRejected=false;try { await session.classify(pairs); } catch { lossRejected=true; }
      if(!lossRejected) throw new Error('lost device job was adopted');
      return {pairs:pairs.length,cpuMs,dispatches:result.dispatches,refinements:result.refinements,wallMs:result.wallMs,transferBytes:result.transferBytes,residentBytes:result.residentBytes,cancelled,snapshotOwned:true,coplanarRefined:true,lossRejected};
    } finally { await session.dispose(); }
  }, { requireHardware: !software });
  const workerLifecycle = await page.evaluate(async ({ requireHardware }) => {
    const { ThreeWorkerClient, cameraFrame3, occlusionVolume3 } = window.threeLabApi;
    const makeCanvas = () => { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; return canvas; };
    const makeInput = revision => {
      const triangle = [[-1,-1,-2],[1,-1,-2],[0,1,-2]], a=[-2,0,-4], b=[2,0,-4];
      return { frame: cameraFrame3({kind:'orthographic',span:4,eye:[0,0,0],target:[0,0,-1],up:[0,1,0],near:.1,far:20},{x:0,y:0,width:150,height:100}), triangles:[triangle],wires:[[a,b]],pairs:[{a,b,volume:occlusionVolume3(triangle,false)}],geometryRevision:1,cameraRevision:revision };
    };
    const client = new ThreeWorkerClient(makeCanvas(), { requireHardware });
    try {
      const first=client.render(makeInput(1)).then(()=> 'adopted', e=>e.name);
      const skipped=client.render(makeInput(2)).then(()=> 'adopted', e=>e.name);
      const input=makeInput(3); const latest=client.render(input); input.pairs[0].a[0]=-1000;
      const [a,b,result]=await Promise.all([first,skipped,latest]);
      if(a!=='AbortError'||b!=='AbortError'||result.cameraRevision!==3) throw new Error('superseded worker view was adopted');
      if(Math.abs(result.gpu.intervals[0][0]-.375)>1e-5) throw new Error('worker submission did not own its input snapshot');
      const abort = new AbortController(); const pending=client.render(makeInput(4),abort.signal).then(()=>false,e=>e.name==='AbortError');abort.abort();
      if(!await pending) throw new Error('worker cancellation was adopted');
      const invalid=structuredClone(makeInput(5));invalid.pairs[0].volume.planes.pop();
      let failed=false;try { await client.render(invalid); } catch { failed=true; }
      if(!failed) throw new Error('invalid worker input succeeded');
      const recovered=await client.render(makeInput(6));
      if(recovered.cameraRevision!==6) throw new Error('worker did not recover after failed generation');
      await client.dispose();
      const restarted=new ThreeWorkerClient(makeCanvas(),{requireHardware});
      try { const final=await restarted.render(makeInput(7)); if(final.cameraRevision!==7) throw new Error('worker restart failed'); }
      finally { await restarted.dispose(); }
      return {worker:true,superseded:2,snapshotOwned:true,cancelled:true,failedGenerationRecovered:true,restarted:true};
    } finally { await client.dispose(); }
  }, { requireHardware: !software });
  const previousRevision = await page.evaluate(() => window.threeEvidence.cameraRevision);
  await page.click('#restart');
  await page.waitForFunction(revision => window.threeEvidence?.cameraRevision > revision, previousRevision);
  assert.equal(await page.evaluate(() => window.threeEvidence.worker), true);
  await page.screenshot({ path: resolve(output, 'worker-restarted.png'), fullPage: true });
  await page.selectOption('#scene','box');
  await page.waitForFunction(()=>window.threeEvidence?.scene==='box');
  const box=await page.evaluate(()=>window.threeEvidence);
  assert.equal(box.features,12); assert.equal(box.selected,12);
  assert.equal(box.visibleRuns,9); assert.equal(box.hiddenRuns,3);
  const meshDownloadPromise=page.waitForEvent('download');await page.click('#download');
  await (await meshDownloadPromise).saveAs(resolve(output,'box.svg'));
  // Measure paper dash segments, allowing the existing 0.005 mm finishing
  // grid, then verify protected dashes remain separate planner paths.
  const dashLengths=await page.locator('#vectors [data-pen="hidden"] path').evaluateAll(paths=>paths.flatMap(p=>{
    const d=p.getAttribute('d');
    if(/[a-kno-z]/i.test(d))throw new Error('unexpected non-linear dash path');
    const points=[...d.matchAll(/[ML]([\d.-]+) ([\d.-]+)/g)].map(m=>[Number(m[1]),Number(m[2])]);
    return points.slice(1).map((p,i)=>Math.hypot(p[0]-points[i][0],p[1]-points[i][1]));
  }));
  assert(dashLengths.length>0 && dashLengths.every(n=>n<=2.008), `perspective dash segments exceed 2 mm finishing tolerance: ${JSON.stringify(dashLengths)}`);
  assert(dashLengths.some(n=>Math.abs(n-2)<.008), 'full dashes must measure 2 mm');
  assert(await page.locator('#vectors [data-pen="hidden"] path').evaluateAll(paths=>paths.every(p=>p.getTotalLength()<=2.008)), 'protected dashes must stay separate through the WASM planner');
  await page.screenshot({path:resolve(output,'box.png'),fullPage:true});
  await page.selectOption('#features','silhouette');
  const silhouettes=await page.evaluate(()=>window.threeEvidence);
  assert.equal(silhouettes.selected,6);assert.equal(silhouettes.constructedStrokes,1);assert.equal(silhouettes.adoptedMeshDispatches,box.adoptedMeshDispatches);assert(silhouettes.visibilityReused);
  await page.selectOption('#features','marked');
  assert.equal(await page.evaluate(()=>window.threeEvidence.selected),1);
  await page.selectOption('#features','all');
  const cameraBefore=await page.evaluate(()=>window.threeEvidence.cameraRevision);
  await page.locator('#orbit').fill('115');await page.locator('#orbit').dispatchEvent('change');
  await page.waitForFunction(revision=>window.threeEvidence.cameraRevision>revision,cameraBefore);
  await page.selectOption('#scene','overlap');
  await page.waitForFunction(()=>window.threeEvidence?.scene==='overlap');
  const overlap=await page.evaluate(()=>window.threeEvidence);assert.equal(overlap.features,25);
  await page.screenshot({path:resolve(output,'overlap.png'),fullPage:true});
  const mesh=await page.evaluate(async({requireHardware})=>{
    const {GpuIntervals3,box3,cameraFrame3,featureSnapshot3,classifySceneCpu3,classifySceneGpu3}=window.threeLabApi;
    const frame=cameraFrame3({kind:'perspective',fovDegrees:60,eye:[4,-6,4],target:[0,0,0],near:.1,far:100},{x:0,y:0,width:150,height:100});
    const objects=Array.from({length:20},(_,i)=>({id:`mesh${i}`,surface:box3([.1+i/20,1,1],[Math.sin(i),Math.cos(i),i/10])}));
    const snapshot=featureSnapshot3(objects,[],frame);const cpu=classifySceneCpu3(snapshot);
    const session=await GpuIntervals3.create(navigator.gpu,{requireHardware});
    try {
      const gpu=await classifySceneGpu3(snapshot,session,{pairCapacity:127});
      cpu.features.forEach((f,i)=>{
        const g=gpu.features[i];
        if(f.hidden.length!==g.hidden.length || f.visible.length!==g.visible.length)throw new Error(`mesh visibility topology mismatch at ${i}`);
        for(let j=0;j<f.hidden.length;j++)if(f.hidden[j].some((v,k)=>Math.abs(v-g.hidden[j][k])>1e-5))throw new Error(`mesh interval mismatch at ${i}`);
      });
      return {features:snapshot.features.length,triangles:snapshot.triangles.length,cpu:cpu.stats,gpu:gpu.stats};
    }finally{await session.dispose();}
  },{requireHardware:!software});
  // A missing browser favicon is not an application/shader error.
  const applicationErrors = errors.filter(e => !e.includes('404 (Not Found)'));
  assert.deepEqual(applicationErrors, []);
  const report = { browser: browser.version(), args, software, orthographic, perspective, batch, workerLifecycle, box, dashLengths, overlap, mesh, applicationErrors };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)+'\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error({ status: await page.locator('#status').innerText().catch(() => ''), errors });
  throw error;
} finally { await context.close(); await browser.close(); }

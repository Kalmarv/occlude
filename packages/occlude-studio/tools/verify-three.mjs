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
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

try {
  await page.goto(`${process.env.OCCLUDE_GPU_URL ?? 'http://127.0.0.1:5273'}/three.html`);
  await page.waitForFunction(() => !!window.threeEvidence || document.querySelector('#status').textContent.includes('Error'), {}, { timeout: 60000 });
  const orthographic = await page.evaluate(() => window.threeEvidence);
  assert(orthographic?.passed, await page.locator('#status').innerText());
  assert.equal(orthographic.adapter.isFallbackAdapter, software, 'adapter class must match the requested verification lane');
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
  // A missing browser favicon is not an application/shader error.
  const applicationErrors = errors.filter(e => !e.includes('404 (Not Found)'));
  assert.deepEqual(applicationErrors, []);
  const report = { browser: browser.version(), args, software, orthographic, perspective, batch, applicationErrors };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)+'\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error({ status: await page.locator('#status').innerText().catch(() => ''), errors });
  throw error;
} finally { await context.close(); await browser.close(); }

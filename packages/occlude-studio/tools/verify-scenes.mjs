/** Public lineArt3 sketches through the actual Studio render worker. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.OCCLUDE_GPU_URL ?? 'http://127.0.0.1:5273';
const output = resolve(process.env.OCCLUDE_GPU_EVIDENCE ?? '../../development/3d/playwright-hatch');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: false,
  env: { ...process.env, VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/nvidia_icd.json' },
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--disable-vulkan-surface', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const networkFailures = [];
  page.on('response', response => { if (response.status() >= 400) networkFailures.push({ url: response.url(), status: response.status() }); });
  const errors = []; page.on('pageerror', e => { errors.push(String(e)); console.error(String(e)); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.addInitScript(() => {
    window.sceneReports = [];
    window.adapterRequests = 0;
    if (navigator.gpu) {
      const request = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = (...args) => { window.adapterRequests++; return request(...args); };
    }
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          if (event.data.type === 'render' && event.data.three) { window.sceneWorker = this; window.sceneReply = event.data; window.sceneReports.push({ ...event.data.three, primitives: event.data.prims.length, fragments: event.data.frags.length }); }
        });
      }
    };
  });
  await page.goto(`${base}/docs.html#/three`);
  await page.locator('.live-example').first().waitFor().catch(async error => { await writeFile(resolve(output, 'failure.html'), await page.content()); await page.screenshot({ path: resolve(output, 'failure.png') }); throw error; });
  const examples = page.locator('.live-example');
  assert.equal(await examples.count(), 8);
  for (let i = 0; i < 8; i++) {
    const example = examples.nth(i);
    await example.scrollIntoViewIfNeeded();
    await page.waitForFunction(index => { const out = document.querySelectorAll('.live-example')[index]; return out?.querySelector('canvas.live-canvas, .live-error'); }, i, { timeout: 60000 });
    assert.equal(await example.locator('.live-error').count(), 0, await example.innerText());
    await example.locator('canvas.live-canvas').waitFor();
    assert.equal(await example.locator('.live-error').count(), 0);
    await example.screenshot({ path: resolve(output, `scene-${i}.png`) });
  }
  const reports = await page.evaluate(() => window.sceneReports);
  assert.equal(reports.length, 8);
  for (const report of reports) {
    assert.equal(report.adapter.isFallbackAdapter, false);
    assert(report.primitives > 0 && report.fragments > 0);
    assert(report.scenes.every(scene => scene.dispatches > 0 && scene.candidates > 0));
  }
  assert.equal(await page.evaluate(() => window.adapterRequests), 0);
  assert.deepEqual(errors, []);
  assert.equal(reports[4].scenes.length, 1, 'multiple styles must share one classification');
  assert.equal(reports[5].scenes.length, 1, 'ordered modifier examples must share one classification');
  assert.equal(reports[6].scenes.length, 1, 'sections and edges share a classification');
  assert.equal(reports[7].scenes.length, 1, 'hatch, crosshatch, sections and edges share a classification');
  assert.deepEqual(reports[7].modeling.map(job=>[job.operation,job.backend,job.dispatches]),[['deform','gpu',8],['query','gpu',1]]);
  assert.deepEqual(reports[2].modeling.map(job => [job.operation, job.backend]), [['deform', 'gpu'], ['query', 'gpu']]);
  assert.equal(reports[2].modeling[0].dispatches, 16);
  assert.equal(reports[2].modeling[1].dispatches, 1);
  await examples.last().getByRole('button', { name: 'open in studio' }).click();
  await page.waitForFunction(() => window.sceneReports?.length > 0, {}, { timeout: 60000 });
  const studio = await page.evaluate(() => window.sceneReports[0]);
  assert.equal(studio.adapter.isFallbackAdapter, false);
  assert(studio.scenes[0].dispatches > 0);
  const svg = await page.evaluate(async () => {
    const worker = window.sceneWorker, reply = window.sceneReply, id = 900000001;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error('SVG export timed out')); }, 10000);
      const listener = event => {
        if (event.data.id !== id) return;
        clearTimeout(timeout); worker.removeEventListener('message', listener);
        if (event.data.type === 'error') reject(new Error(event.data.message)); else resolve(event.data.svg);
      };
      worker.addEventListener('message', listener);
      worker.postMessage({ type: 'plan-svg', id, planHash: reply.planHash, from: 0, to: reply.plan[1], width: reply.paper.w, height: reply.paper.h, onlyPen: -1 });
    });
  });
  if (process.env.OCCLUDE_CONSTRUCTION_CHECK === '1') {
    await page.evaluate(() => {
      window.constructionReplies=[];window.constructionRequests=[];
      window.sceneWorker.addEventListener('message',e=>{if(e.data.type==='construction')window.constructionReplies.push({revision:e.data.revision,pick:e.data.pick,bitmap:!!e.data.bitmap});});
      const post=window.sceneWorker.postMessage.bind(window.sceneWorker);
      window.sceneWorker.postMessage=(msg,...rest)=>{window.constructionRequests.push({type:msg.type,camera:msg.camera});return post(msg,...rest);};
    });
    const before=await page.evaluate(()=>({hash:window.sceneReply.planHash,renders:window.sceneReports.length}));
    await page.getByRole('button',{name:'3D',exact:true}).click();
    const canvas=page.locator('#construction-canvas');
    await page.waitForFunction(()=>!!document.querySelector('#construction-canvas')?.dataset.revision);
    const initial=await canvas.getAttribute('data-revision');
    const rect=await canvas.boundingBox();assert(rect);
    await page.mouse.move(rect.x+rect.width*.5,rect.y+rect.height*.5);
    await page.mouse.down();await page.mouse.move(rect.x+rect.width*.5+70,rect.y+rect.height*.5+25,{steps:10});await page.mouse.up();
    await page.waitForFunction(rev=>document.querySelector('#construction-canvas')?.dataset.revision!==rev,initial);
    const orbit=await canvas.getAttribute('data-revision');
    await page.mouse.wheel(0,-180);
    await page.waitForFunction(rev=>document.querySelector('#construction-canvas')?.dataset.revision!==rev,orbit);
    await page.getByRole('button',{name:'Reset camera',exact:true}).click();
    let found=false;
    for(const [x,y] of [[.5,.5],[.4,.6],[.6,.6],[.5,.7]]){
      const n=await page.evaluate(()=>window.constructionReplies.filter(r=>'pick' in r).length);
      await canvas.click({position:{x:rect.width*x,y:rect.height*y}});
      await page.waitForFunction(n=>window.constructionReplies.filter(r=>'pick' in r).length>n,n);
      if(await page.locator('.construction-pick').innerText().then(t=>t.includes('relief /'))){found=true;break;}
    }
    assert(found,'construction picking must identify a modeled face');
    const stale=await page.evaluate(async()=>{
      const worker=window.sceneWorker,id=900000003,camera=window.constructionRequests.find(r=>r.camera).camera;
      return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('stale request timeout')),10000);const listener=e=>{if(e.data.id!==id)return;clearTimeout(timeout);worker.removeEventListener('message',listener);resolve(e.data);};worker.addEventListener('message',listener);worker.postMessage({type:'construction',id,executionId:-1,scene:0,camera,width:100,height:100,revision:-1});});
    });
    assert.equal(stale.type,'error');assert.match(stale.message,/stale construction/);
    const after=await page.evaluate(()=>({hash:window.sceneReply.planHash,renders:window.sceneReports.length,requests:window.constructionRequests,replies:window.constructionReplies}));
    assert.equal(after.hash,before.hash);assert.equal(after.renders,before.renders);
    assert(after.requests.every(r=>r.type==='construction'),'camera interaction must not execute or classify the sketch');
    assert(after.replies.some(r=>r.bitmap));assert(after.replies.some(r=>r.pick?.objectId==='relief'));
    await page.screenshot({path:resolve(output,'construction.png'),fullPage:true});
    await writeFile(resolve(output,'construction.json'),JSON.stringify({passed:true,before,after},null,2));
    await page.getByRole('button',{name:'3D',exact:true}).click();
    const exported=await page.evaluate(async()=>{
      const worker=window.sceneWorker,reply=window.sceneReply,id=900000002;
      return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('export timeout')),10000);const listener=e=>{if(e.data.id!==id)return;worker.removeEventListener('message',listener);clearTimeout(timeout);resolve(e.data.svg);};worker.addEventListener('message',listener);worker.postMessage({type:'plan-svg',id,planHash:reply.planHash,from:0,to:reply.plan[1],width:reply.paper.w,height:reply.paper.h,onlyPen:-1});});
    });
    assert.equal(exported,svg,'orbit must preserve the committed SVG byte for byte');
  }
  assert(svg.includes('<path'));
  assert(/a84932/i.test(svg), 'named accent pen must survive Studio SVG export');
  await writeFile(resolve(output, 'studio.svg'), svg);
  await page.screenshot({ path: resolve(output, 'studio.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, base, reports, studio, svgBytes: svg.length, errors, networkFailures }, null, 2));
  console.log(JSON.stringify({ passed: true, reports }));
} finally { await browser.close(); }

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
  let modelGenerations = 0;
  const errors = []; page.on('pageerror', e => { errors.push(String(e)); console.error(String(e)); });
  page.on('console', message => { if(message.text()==='camera-model-generation')modelGenerations++; if (message.type() === 'error') console.error(message.text()); });
  await page.addInitScript(({cameraCheck}) => {
    window.sceneReports = [];
    window.workerRequests = [];
    window.adapterRequests = 0;
    if (navigator.gpu) {
      const request = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = (...args) => { window.adapterRequests++; return request(...args); };
    }
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      postMessage(message,...rest) {
        if(cameraCheck && message.type==='render' && message.js.includes('hatched-towers')) {
          message={...message,js:message.js.replace(/let surface\s*=/,'console.info("camera-model-generation"); let surface =')};
        }
        if(typeof message.type==='string')window.workerRequests.push(message.type);
        if(message.type==='plan-load'||message.type==='render')window.planWorker=this;
        return super.postMessage(message,...rest);
      }
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          if (event.data.type === 'render' && event.data.three) { window.sceneWorker = this; window.sceneReply = event.data; window.sceneReports.push({ ...event.data.three, primitives: event.data.prims.length, fragments: event.data.frags.length }); }
        });
      }
    };
  }, {cameraCheck:process.env.OCCLUDE_CAMERA_CHECK==='1'});
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
  if (process.env.OCCLUDE_CAMERA_CHECK === '1') {
    const before=await page.evaluate(()=>({hash:window.sceneReply.planHash,execution:window.sceneReply.executionId,camera:window.sceneReply.construction[0].camera,modeling:window.sceneReply.three.modeling,requests:window.workerRequests.filter(t=>t==='render').length}));
    const generationCount=modelGenerations;
    assert(generationCount>0,'the procedural model must be instrumented');
    await page.evaluate(()=>{
      window.cameraRpc=(message,cancel=false)=>new Promise((resolve,reject)=>{
        const worker=window.sceneWorker,id=900001000+(window.cameraRpcId=(window.cameraRpcId||0)+1);
        const listener=e=>{if(e.data.id!==id)return;clearTimeout(timer);worker.removeEventListener('message',listener);resolve(e.data);};
        const timer=setTimeout(()=>{worker.removeEventListener('message',listener);reject(new Error('camera RPC timeout'));},15000);
        worker.addEventListener('message',listener);worker.postMessage({...message,id});if(cancel)worker.postMessage({type:'cancel-camera',id});
      });
    });
    const originalCapture=await page.evaluate(()=>window.cameraRpc({type:'plan-three',planHash:window.sceneReply.planHash}));
    await page.getByRole('button',{name:'3D',exact:true}).click();
    const canvas=page.locator('#construction-canvas'),bounds=await canvas.boundingBox();assert(bounds);
    const revision=await canvas.getAttribute('data-revision');
    await page.mouse.move(bounds.x+bounds.width*.5,bounds.y+bounds.height*.5);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.5+100,bounds.y+bounds.height*.5+30,{steps:10});await page.mouse.up();
    await page.waitForFunction(r=>document.querySelector('#construction-canvas')?.dataset.revision!==r,revision);
    await page.getByRole('button',{name:'Commit view',exact:true}).click();
    await page.waitForFunction(hash=>window.__occlude.drawing.plan?.planHash!==hash && document.querySelector('.construction-pick')?.textContent?.startsWith('View committed.'),before.hash,{timeout:60000});
    const after=await page.evaluate(()=>({hash:window.sceneReply.planHash,execution:window.sceneReply.executionId,camera:window.sceneReply.construction[0].camera,modeling:window.sceneReply.three.modeling,requests:window.workerRequests.filter(t=>t==='render').length}));
    assert.notEqual(after.hash,before.hash);assert.notEqual(after.execution,before.execution);assert.notDeepEqual(after.camera,before.camera);
    assert.equal(after.requests,before.requests);assert.equal(modelGenerations,generationCount);assert.deepEqual(after.modeling,before.modeling);
    const captured=await page.evaluate(()=>window.cameraRpc({type:'plan-three',planHash:window.sceneReply.planHash}));
    assert.deepEqual(captured.three.scenes[0].objects,originalCapture.three.scenes[0].objects);
    assert.deepEqual(captured.three.scenes[0].frame.camera,after.camera);
    const invalid=await page.evaluate(()=>window.cameraRpc({type:'render-camera',executionId:window.sceneReply.executionId,planHash:window.sceneReply.planHash,scene:0,camera:{...window.sceneReply.construction[0].camera,near:-1}}));
    assert.equal(invalid.type,'error');
    const stale=await page.evaluate(before=>window.cameraRpc({type:'render-camera',executionId:before.execution,planHash:before.hash,scene:0,camera:before.camera}),before);
    assert.equal(stale.type,'error');assert.match(stale.message,/stale camera/);
    const cancelled=await page.evaluate(before=>window.cameraRpc({type:'render-camera',executionId:window.sceneReply.executionId,planHash:window.sceneReply.planHash,scene:0,camera:before.camera},true),before);
    assert.equal(cancelled.type,'error');assert.equal(cancelled.cancelled,true);
    const exported=await page.evaluate(()=>{const r=window.sceneReply;return window.cameraRpc({type:'plan-svg',planHash:r.planHash,from:0,to:r.plan[1],width:r.paper.w,height:r.paper.h,onlyPen:-1});});
    assert.equal(exported.type,'plan-svg');assert(exported.svg.includes('<path'));assert.notEqual(exported.svg,svg);
    await page.getByRole('button',{name:'3D',exact:true}).click();
    await page.screenshot({path:resolve(output,'camera-commit.png'),fullPage:true});
    await writeFile(resolve(output,'camera-commit.svg'),exported.svg);
    await writeFile(resolve(output,'camera-commit.json'),JSON.stringify({passed:true,before,after,modelGenerations:generationCount,invalid:invalid.message,stale:stale.message,cancelled:cancelled.cancelled},null,2));
  }
  if (process.env.OCCLUDE_PERSISTENCE_CHECK === '1') {
    const madePromise=page.waitForResponse(r=>r.url()===`${base}/api/results`&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Save result',exact:true}).click();
    const made=await madePromise;assert.equal(made.status(),201,await made.text());
    const {id}=await made.json();
    try {
      const saved=await (await page.request.get(`${base}/api/results/${id}`)).json();
      assert.equal(saved.three.schemaVersion,1);assert.equal(saved.three.scenes.length,1);
      assert.equal(saved.three.adapter.isFallbackAdapter,false);
      assert(saved.three.scenes[0].objects[0].surface.points.length>0);
      assert(saved.three.scenes[0].generated.some(g=>g.curve.kind==='hatch'));
      assert(saved.three.scenes[0].generated.some(g=>g.curve.kind==='section'));
      assert.equal(saved.paper.color.length,7);
      const committedCamera=await page.evaluate(()=>window.sceneReply.construction[0].camera);
      assert.deepEqual(saved.three.scenes[0].frame.camera,committedCamera);
      await page.getByRole('button',{name:'3D',exact:true}).click();
      const viewport=page.locator('#construction-canvas'),bounds=await viewport.boundingBox();assert(bounds);
      const revision=await viewport.getAttribute('data-revision');
      await page.mouse.move(bounds.x+bounds.width*.5,bounds.y+bounds.height*.5);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.5+90,bounds.y+bounds.height*.5,{steps:6});await page.mouse.up();
      await page.waitForFunction(r=>document.querySelector('#construction-canvas')?.dataset.revision!==r,revision);
      if(process.env.OCCLUDE_CONSTRUCTION_CHECK==='1')assert.notDeepEqual(await page.evaluate(()=>window.constructionRequests.filter(r=>r.camera).at(-1).camera),committedCamera);
      const frozenSvg=await (await page.request.get(`${base}/api/results/${id}/svg`)).text();
      const planBytes=await (await page.request.get(`${base}/api/results/${id}/plan`)).body();
      // Supply changed libraries to the reopened application. The persistent
      // result itself goes through the actual isolated server store.
      const changedPens=saved.pens.map(p=>({...p,width:p.width*2,color:'#00FF00',feed:p.feed/2,penDelay:p.penDelay+100}));
      const changedPapers=[{name:'Changed paper',w:80,h:90,color:'#FF00FF'}];
      await page.route('**/api/pens',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(changedPens)}));
      await page.route('**/api/papers',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(changedPapers)}));
      await page.evaluate(()=>{
        localStorage.setItem('occlude.sketch','throw new Error("saved result must never execute this source")');
        const settings=JSON.parse(localStorage.getItem('occlude.settings')||'{}');settings.paperColor='#FF00FF';localStorage.setItem('occlude.settings',JSON.stringify(settings));
      });
      await page.goto(`${base}/?result=${id}`);
      await page.waitForFunction(()=>document.querySelector('#status-msg')?.textContent?.includes('frozen — source not executed'),{},{timeout:30000});
      const reopened=await page.evaluate(async()=>{
        const app=window.__occlude,plan=app.drawing.plan,result=app.result();
        return {hash:plan.planHash,pens:result.pens,paper:result.paper,svg:await app.drawing.svg(result.paper.color,-1),requests:window.workerRequests,adapterRequests:window.adapterRequests,renders:window.sceneReports.length};
      });
      assert.equal(reopened.hash,saved.planHash);assert.deepEqual(reopened.pens,saved.pens);assert.deepEqual(reopened.paper,saved.paper);
      assert.equal(reopened.svg,frozenSvg);assert.equal(reopened.adapterRequests,0);assert.equal(reopened.renders,0);assert(!reopened.requests.includes('render'));
      const restoredCapture=await page.evaluate(async()=>{
        const worker=window.planWorker,id=900000004,planHash=window.__occlude.drawing.plan.planHash;
        return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('capture timeout')),10000);const listener=e=>{if(e.data.id!==id)return;clearTimeout(timeout);worker.removeEventListener('message',listener);resolve(e.data.three);};worker.addEventListener('message',listener);worker.postMessage({type:'plan-three',id,planHash});});
      });
      assert.deepEqual(restoredCapture,saved.three);
      const again=await (await page.request.get(`${base}/api/results/${id}/plan`)).body();assert.deepEqual(again,planBytes);
      await page.screenshot({path:resolve(output,'reopened.png'),fullPage:true});
      await writeFile(resolve(output,'persistence.json'),JSON.stringify({passed:true,id,captureRestored:true,previewCameraChanged:true,committedCamera:saved.three.scenes[0].frame.camera,planHash:saved.planHash,planBytes:planBytes.length,svgBytes:frozenSvg.length,capturedScenes:saved.three.scenes.length,points:saved.three.scenes[0].objects[0].surface.points.length,generated:saved.three.scenes[0].generated.length,requests:reopened.requests,adapterRequests:reopened.adapterRequests,changedPens,changedPapers},null,2));
    } finally {
      const deleted=await page.request.delete(`${base}/api/results/${id}`);assert.equal(deleted.status(),200);
    }
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: true, base, reports, studio, svgBytes: svg.length, errors, networkFailures }, null, 2));
  console.log(JSON.stringify({ passed: true, reports }));
} finally { await browser.close(); }

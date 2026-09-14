/** Main Studio acceptance: selective hatch/hidden ink, physical clipping, retained camera. */
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const output=process.env.OCCLUDE_API_EVIDENCE??'../../development/3d/paper-api';
await mkdir(output,{recursive:true});
const original=await readFile('../../development/3d/api-examples/paper-composition.ts','utf8');
const source=original.replace('const relief=',"console.info('paper-model'); const relief=")
  .replace('},lines=>[',`},lines=>{
    const hatch=[...lines.visible,...lines.hidden].filter(c=>c.kinds.has('hatch'));
    console.info('paper-lines:'+JSON.stringify({visible:lines.visible.length,hidden:lines.hidden.filter(c=>c.kinds.has('crease')).length,hatch:hatch.length,supported:hatch.every(c=>c.support.length>0&&c.faceAttributes.some(a=>a.decorate===true))}));
    return [`).replace('  ])),mask','  ];})),mask');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
let page;
try{
 page=await browser.newPage({viewport:{width:1500,height:1100}});
 let models=0;const interpretations=[],errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.text()==='paper-model')models++;if(m.text().startsWith('paper-lines:'))interpretations.push(JSON.parse(m.text().slice(12)));});
 await page.addInitScript(source=>{
   if(!sessionStorage.getItem('paper-api')){localStorage.setItem('occlude.sketch',source);sessionStorage.setItem('paper-api','1');}
   const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.renderCount=(window.renderCount??0)+1;}});}};
 },source);
 const ready=()=>page.waitForFunction(()=>window.reply&&window.__occlude?.drawing.plan&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:60000});
 const capture=()=>page.evaluate(async()=>({hash:window.reply.planHash,paper:window.reply.paper,pens:window.reply.pens,settings:window.reply.planSettings,camera:window.reply.construction[0].camera,stats:window.reply.three,svg:await window.__occlude.drawing.svg('#F5F0E6',-1)}));
 // Export coordinates are physical mm. The drawing frame is inset by 5% of
 // the short paper side and 100 user units span the remaining short side.
 const checkInk=(svg,clipBounds=[4,6,92,112])=>{
   const unit=215.9*.9/100,offset=215.9*.05;
   const rect=(x,y,w,h)=>[offset+x*unit,offset+y*unit,offset+(x+w)*unit,offset+(y+h)*unit];
   const clip=rect(...clipBounds),mask=rect(52,76,44,17);
   const body=svg.match(/<g[^>]*data-pen="shade"[^>]*>([\s\S]*?)<\/g>/)?.[1];assert(body);
   const paths=[...body.matchAll(/<path d="([^"]+)"/g)];assert(paths.length>0);
   let segments=0,outside=0,throughMask=0,zero=0;
   for(const [,d] of paths){
     assert(/^M[\d. -]+(?:L[\d. -]+)+$/.test(d),'shade should contain line paths');
     const points=d.slice(1).split('L').map(s=>s.split(' ').map(Number));
     for(let i=1;i<points.length;i++){
       const a=points[i-1],b=points[i];segments++;
       if(a[0]===b[0]&&a[1]===b[1])zero++;
       if([a,b].some(p=>p[0]<clip[0]-.01||p[0]>clip[2]+.01||p[1]<clip[1]-.01||p[1]>clip[3]+.01))outside++;
       // Intersect with a slightly inset open rectangle so border ink and
       // the established 0.005mm output grid are not counted as mask leaks.
       let lo=0,hi=1;
       for(let k=0;k<2;k++){
         const d=b[k]-a[k],min=mask[k]+.01,max=mask[k+2]-.01;
         if(d===0){if(a[k]<=min||a[k]>=max){hi=-1;break;}}
         else{const ts=[(min-a[k])/d,(max-a[k])/d].sort((a,b)=>a-b);lo=Math.max(lo,ts[0]);hi=Math.min(hi,ts[1]);}
       }
       if(lo<hi)throughMask++;
     }
   }
   return {segments,outside,throughMask,zero};
 };
 await page.goto(base);await ready();
 assert.deepEqual(await page.evaluate(()=>window.__occlude.editor.diagnostics()),[]);
 const before=await capture(),beforeInk=checkInk(before.svg);
 assert.equal(before.paper.w,215.9);assert.equal(before.paper.h,279.4);assert.equal(before.paper.color,'#F5F0E6');
 assert.deepEqual(before.pens.map(p=>[p.name,p.width,p.color]),[['ink',.3,'#18202A'],['shade',.18,'#A84932']]);
 assert.equal(before.stats.adapter.isFallbackAdapter,false);assert(before.stats.scenes[0].dispatches>0);
 assert.equal(models,1);assert.equal(interpretations.length,1);
 assert(interpretations[0].visible>0&&interpretations[0].hidden>0&&interpretations[0].hatch>0&&interpretations[0].supported);
 assert.equal(beforeInk.outside,0);assert.equal(beforeInk.throughMask,0);assert.equal(beforeInk.zero,0);
 await page.screenshot({path:output+'/orthographic.png'});await writeFile(output+'/orthographic.svg',before.svg);
 await page.getByRole('button',{name:'3D',exact:true}).click();
 await page.getByLabel('Projection',{exact:true}).selectOption('perspective');
 assert.equal((await capture()).svg,before.svg);assert.equal(models,1);
 await page.getByRole('button',{name:'Commit view',exact:true}).click();
 await page.waitForFunction(hash=>window.reply.planHash!==hash&&document.querySelector('.construction-pick')?.textContent?.startsWith('View committed.'),before.hash,{timeout:60000});
 const after=await capture(),afterInk=checkInk(after.svg);
 assert.equal(models,1);assert.equal(after.camera.kind,'perspective');assert.notEqual(after.svg,before.svg);
 assert.equal(afterInk.outside,0);assert.equal(afterInk.throughMask,0);assert.equal(afterInk.zero,0);
 assert.equal(interpretations.length,2);assert(interpretations[1].supported);
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download',exact:true}).click();
 const portable=await readFile(await (await pending).path(),'utf8');assert(portable.includes(JSON.stringify(after.camera)));
 await writeFile(output+'/portable.ts',portable);await writeFile(output+'/perspective.svg',after.svg);
 await page.evaluate(source=>localStorage.setItem('occlude.sketch',source),portable);await page.reload();await ready();
 const reopened=await capture();assert.equal(reopened.hash,after.hash);assert.equal(reopened.svg,after.svg);assert.deepEqual(reopened.camera,after.camera);assert.deepEqual(reopened.pens,after.pens);assert.deepEqual(reopened.settings,after.settings);assert.equal(models,2);
 // The default view fits within the generous clip. A deliberately smaller
 // clip supplies a non-vacuous clipping control using the same model/ink.
 const narrow=[30,40,40,50];
 const clippedSource=source.replace('rect(4,6,92,112)','rect(30,40,40,50)');
 const clippedCount=await page.evaluate(()=>window.renderCount);
 await page.evaluate(source=>window.__occlude.editor.setValue(source),clippedSource);
 await page.waitForFunction(count=>window.renderCount>count&&document.querySelector('#status-msg').textContent==='ok',clippedCount,{timeout:60000});
 const clipped=checkInk((await capture()).svg,narrow);assert(clipped.segments>0);assert.equal(clipped.outside,0);assert.equal(clipped.throughMask,0);
 // Removing both operators must expose ink outside that clip and inside mask.
 const unbounded=source.replace('clip(rect(4,6,92,112),view','view').replace('];})),mask(rect(52,76,44,17)),','];}),');
 const count=await page.evaluate(()=>window.renderCount);
 await page.evaluate(source=>window.__occlude.editor.setValue(source),unbounded);
 await page.waitForFunction(count=>window.renderCount>count&&document.querySelector('#status-msg').textContent==='ok',count,{timeout:60000});
 const negative=checkInk((await capture()).svg,narrow);assert(negative.outside>0);assert(negative.throughMask>0);
 assert.deepEqual(errors,[]);
 await writeFile(output+'/report.json',JSON.stringify({passed:true,base,before,after,reopenedHash:reopened.hash,beforeInk,afterInk,clipped,negative,interpretations,errors},null,2));
 console.log('Paper API selective hatch/hidden ink, clip/mask negative controls, projection commit and exact portable reopen passed.');
}catch(error){if(page)await page.screenshot({path:output+'/failure.png'});throw error;}finally{await browser.close();}

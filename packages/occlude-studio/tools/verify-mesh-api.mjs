import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const instanceCheck=process.env.OCCLUDE_API_EXAMPLE==='instances',queryCheck=process.env.OCCLUDE_API_EXAMPLE==='queries',curveCheck=process.env.OCCLUDE_API_EXAMPLE==='curves',profileCheck=process.env.OCCLUDE_API_EXAMPLE==='profiles';
const output=process.env.OCCLUDE_API_EVIDENCE??(instanceCheck?'../../development/3d/instances-api':queryCheck?'../../development/3d/query-api':'../../development/3d/mesh-api');await mkdir(output,{recursive:true});
const docs=await readFile('../../docs/three.md','utf8');
let source=[...docs.matchAll(/```ts live[^\n]*\n([\s\S]*?)```/g)][8][1].replace('const terrain =',"console.info('mesh-model'); const terrain =");
if(instanceCheck)source=(await readFile('../../development/3d/api-examples/instanced-forms.ts','utf8')).replace('const sites=',"console.info('mesh-model'); const sites=").replace('return view(forms,',"return (drawing=>{console.info('instance-shared:'+new Set(drawing.scene.objects.map(o=>o.surface)).size);return drawing;})(view(forms,").replace("stroke:'ink'});","stroke:'ink'}));");
if(queryCheck)source=(await readFile('../../development/3d/api-examples/surface-queries.ts','utf8')).replace('const pull=',"console.info('mesh-model'); const pull=").replace('const limits=',"console.info('query-proof:'+JSON.stringify({rows:roofHits.length,misses:roofHits.filter(r=>r.hit===null).length,nearestMisses:nearby.filter(r=>r.hit===null).length,identity:roofHits.every(r=>r.source===terrain.points.at(r.source.index)),typedFaces:roofHits.every(r=>!r.hit||r.hit.face.roof===true),distanceVsT:roofHits.every(r=>!r.hit||Math.abs(r.hit.distance-2*r.hit.t)<1e-10),rayOracle:roofHits.every(r=>{const x=r.source.x,y=r.source.y,z=.4-Math.tan(Math.PI/12)*x,inside=Math.abs(x)<=1.5*Math.cos(Math.PI/12)&&Math.abs(y)<=1.5;return inside?!!r.hit&&Math.abs(r.hit.position[2]-z)<1e-10&&Math.abs(r.hit.distance-(3-z))<1e-10:r.hit===null;}),nearestOracle:nearby.every(r=>{const p=r.source,c=Math.cos(Math.PI/12),s=Math.sin(Math.PI/12),x=c*p.x-s*(p.z-.4),z=s*p.x+c*(p.z-.4),d=Math.hypot(z,Math.max(0,Math.abs(x)-1.5),Math.max(0,Math.abs(p.y)-1.5));return d<=.35?!!r.hit&&Math.abs(r.hit.distance-d)<1e-10:r.hit===null;})})); const limits=");
if(curveCheck)source=(await readFile('../../development/3d/api-examples/curves.ts','utf8')).replace('const block =',"console.info('mesh-model'); const block =");
if(profileCheck)source=(await readFile('../../development/3d/api-examples/profile-construction.ts','utf8')).replace('const vessel =',"console.info('mesh-model'); const vessel =");
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1100}});let models=0;const shared=[];const queries=[];const curveOracles=[];const profileOracles=[];const errors=[];
 page.on('console',m=>{if(m.text().startsWith('profile-oracle:'))profileOracles.push(JSON.parse(m.text().slice('profile-oracle:'.length)));if(m.text().startsWith('curve-oracle:'))curveOracles.push(JSON.parse(m.text().slice('curve-oracle:'.length)));if(m.text()==='mesh-model')models++;if(m.text().startsWith('instance-shared:'))shared.push(Number(m.text().split(':')[1]));if(m.text().startsWith('query-proof:'))queries.push(JSON.parse(m.text().slice('query-proof:'.length)));});page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(source=>{if(!sessionStorage.getItem('mesh-api-initialized')){localStorage.setItem('occlude.sketch',source);sessionStorage.setItem('mesh-api-initialized','1');}window.requests=[];const Original=Worker;window.Worker=class extends Original{postMessage(m,...r){window.requests.push(m.type);return super.postMessage(m,...r);}constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.renderReplyCount=(window.renderReplyCount??0)+1;}});}};},source);
 await page.goto(base);await page.waitForFunction(()=>window.reply&&window.__occlude?.drawing.plan&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:60000});
 const diagnostics=await page.evaluate(()=>window.__occlude.editor.diagnostics());await writeFile(output+'/diagnostics.json',JSON.stringify(diagnostics,null,2));assert.deepEqual(diagnostics,[]);
 const before=await page.evaluate(async()=>({hash:window.reply.planHash,svg:await window.__occlude.drawing.svg('#fff',-1),stats:window.reply.three}));
 const zeroLengthPaths=[...before.svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"/g)].filter(m=>m[1]===m[3]&&m[2]===m[4]).length;
 if(instanceCheck)assert.equal(zeroLengthPaths,0,'convex cone instances must not emit stray endpoint dots');
 assert.equal(before.stats.adapter.isFallbackAdapter,false);assert(before.stats.scenes[0].dispatches>0);assert.equal(models,1);if(instanceCheck)assert.deepEqual(shared,[1]);
 if(queryCheck){assert.equal(queries.length,1);assert(queries[0].rows>0&&queries[0].misses>0&&queries[0].nearestMisses>0);assert(queries[0].identity&&queries[0].typedFaces&&queries[0].distanceVsT&&queries[0].rayOracle&&queries[0].nearestOracle);const batches=before.stats.modeling.filter(m=>m.operation==='query');assert.equal(batches.length,2);assert.equal(batches[0].targetCacheHit,false);assert(batches[0].targetUploadBytes>0);assert.equal(batches[1].targetCacheHit,true);assert.equal(batches[1].targetUploadBytes,0);assert(batches.every(b=>b.dispatches>0));}
 await page.screenshot({path:output+'/default-view.png',fullPage:true});await writeFile(output+'/default-view.svg',before.svg);
 await page.getByRole('button',{name:'3D',exact:true}).click();const targetProjection=instanceCheck?'orthographic':'perspective';await page.getByLabel('Projection',{exact:true}).selectOption(targetProjection);
 assert.equal(await page.evaluate(()=>window.reply.planHash),before.hash);assert.equal(models,1);
 await page.getByRole('button',{name:'Commit view',exact:true}).click();
 await page.waitForFunction(hash=>window.reply.planHash!==hash&&document.querySelector('.construction-pick')?.textContent?.startsWith('View committed.'),before.hash,{timeout:60000});
 const after=await page.evaluate(async()=>({hash:window.reply.planHash,camera:window.reply.construction[0].camera,svg:await window.__occlude.drawing.svg('#fff',-1),renders:window.requests.filter(t=>t==='render').length}));
 assert.equal(models,1);assert.equal(after.renders,1);assert.equal(after.camera.kind,targetProjection);assert.notEqual(after.svg,before.svg);
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download',exact:true}).click();const file=await pending,portable=await readFile(await file.path(),'utf8');
 assert(portable.includes('cameras3:'));assert(portable.includes(JSON.stringify(after.camera)));await writeFile(output+'/portable.ts',portable);
 await page.evaluate(source=>localStorage.setItem('occlude.sketch',source),portable);await page.reload();await page.waitForFunction(()=>window.reply&&window.__occlude?.drawing.plan,{},{timeout:60000});
 const reopened=await page.evaluate(()=>({hash:window.reply.planHash,camera:window.reply.construction[0].camera}));assert.deepEqual(reopened,{hash:after.hash,camera:after.camera});assert.equal(models,2);
 const probe=profileCheck?"revolve(polyline([[1,0,0],[1,0,1]]).attribute('height',1)).points.at(0).height":curveCheck?"circle().attribute('height',1).points.at(0).height":queryCheck?"query(plane()).batch().nearest(plane().attribute('height',1).points)[0].source.height":instanceCheck?"instanceOnPoints(cone(),pointCloud([[0,0,0]]).attribute('height',1).points).instances.at(0).height":"plane().attribute('height',1).points.at(0).height";
 await page.evaluate(({probe,queryCheck,curveCheck,profileCheck})=>window.__occlude.editor.setValue(window.__occlude.editor.getValue()+'\nconst __typeProbe: string = '+probe+';'+(queryCheck?"\nconst __faceProbe: string = query(plane().faceAttribute('roof',true)).nearest([0,0,1]).face.roof;":'')+(curveCheck?'\ncircle().faces();':'')+(profileCheck?"\nconst __pathProbe: string = sweep(circle(),polyline([[0,0,0],[0,0,1]]).attribute('radius',1)).points.at(0).radius;":'')),{probe,queryCheck,curveCheck,profileCheck});
 const negative=await page.evaluate(()=>window.__occlude.editor.diagnostics());await writeFile(output+'/negative-diagnostics.json',JSON.stringify(negative,null,2));assert(negative.some(d=>d.code===2322),'Monaco must retain numeric attribute types rather than any');
 if(curveCheck)assert(negative.some(d=>d.code===2339),'curve geometry must not claim a face domain');
 if(queryCheck||profileCheck)assert.equal(negative.filter(d=>d.code===2322).length,2);
 if(curveCheck){
  for(const projection of ['orthographic','perspective']){
   const oracleSource=`import {sketch,strokes} from 'occlude';
import {box,polyline,view,orthographic,perspective} from 'occlude/3d';
export default sketch({seed:42},()=>view([box(),polyline([[-2,0,-1],[2,0,-1]]).withKey('path')],{camera:${projection}({eye:[0,0,5],up:[0,1,0],${projection==='orthographic'?'span:5':'fovDegrees:45'}})},lines=>{
const select=c=>c.feature.objectId==='path';
console.info('curve-oracle:'+JSON.stringify({projection:'${projection}',visible:lines.visible.filter(select).map(c=>c.range),hidden:lines.hidden.filter(select).map(c=>c.range)}));
return strokes(lines.visible);
}));`;
   const prior=await page.evaluate(()=>window.reply.planHash);
   await page.evaluate(source=>window.__occlude.editor.setValue(source),oracleSource);
   await page.waitForFunction(hash=>window.reply.planHash!==hash&&document.querySelector('#status-msg').textContent==='ok',prior,{timeout:60000});
   const proof=curveOracles.at(-1),lo=projection==='orthographic'?.375:1/3,hi=1-lo;
   assert.equal(proof.projection,projection);assert.equal(proof.visible.length,2);assert.equal(proof.hidden.length,1);
   const actual=[...proof.visible.flat(),...proof.hidden.flat()],expected=[0,lo,hi,1,lo,hi];
   actual.forEach((v,i)=>assert(Math.abs(v-expected[i])<1e-10,`${projection} wire interval ${v} != ${expected[i]}`));
   const stats=await page.evaluate(()=>window.reply.three);assert.equal(stats.adapter.isFallbackAdapter,false);assert(stats.scenes[0].dispatches>0);
  }
 }
 if(profileCheck){
  for(const operation of ['revolve','sweep'])for(const projection of ['orthographic','perspective']){
   const mesh=operation==='revolve'?"revolve(polyline([[0,0,-1],[1,0,-1],[1,0,1],[0,0,1]]),{segments:8})":"sweep(circle(1,{segments:8}),polyline([[0,0,-1],[0,0,1]]),{caps:true,normal:[1,0,0]})";
   const oracleSource=`import {sketch,strokes} from 'occlude';
import {polyline,circle,revolve,sweep,view,orthographic,perspective} from 'occlude/3d';
export default sketch({seed:42},()=>view([${mesh},polyline([[-2,0,-2],[2,0,-2]]).withKey('path')],{camera:${projection}({eye:[0,0,5],up:[0,1,0],${projection==='orthographic'?'span:5':'fovDegrees:60'}})},lines=>{
const select=c=>c.feature.objectId==='path';
console.info('profile-oracle:'+JSON.stringify({operation:'${operation}',projection:'${projection}',visible:lines.visible.filter(select).map(c=>c.range),hidden:lines.hidden.filter(select).map(c=>c.range)}));
return strokes(lines.visible);
}));`;
   const priorCount=await page.evaluate(()=>window.renderReplyCount);
   const rendered=page.waitForEvent('console',{predicate:m=>m.text().startsWith('profile-oracle:')&&m.text().includes('"operation":"'+operation+'"')&&m.text().includes('"projection":"'+projection+'"'),timeout:60000});
   await page.evaluate(source=>window.__occlude.editor.setValue(source),oracleSource);await rendered;
   await page.waitForFunction(count=>window.renderReplyCount>count&&document.querySelector('#status-msg').textContent==='ok',priorCount,{timeout:60000});
   const proof=profileOracles.at(-1),lo=projection==='orthographic'?.25:.0625,hi=1-lo;
   assert.equal(proof.operation,operation);assert.equal(proof.projection,projection);assert.equal(proof.visible.length,2);assert.equal(proof.hidden.length,1);
   const actual=[...proof.visible.flat(),...proof.hidden.flat()],expected=[0,lo,hi,1,lo,hi];
   actual.forEach((v,i)=>assert(Math.abs(v-expected[i])<1e-10,`${operation} ${projection} wire interval ${v} != ${expected[i]}`));
   const stats=await page.evaluate(()=>window.reply.three);assert.equal(stats.adapter.isFallbackAdapter,false);assert(stats.scenes[0].dispatches>0);
  }
 }
 assert.deepEqual(errors,[]);
 const report={passed:true,base,diagnostics,negative,modelsBeforeReopen:1,modelsAfterReopen:2,reopened,stats:before.stats,zeroLengthPaths,sharedPrototypeCounts:shared,queries,curveOracles,profileOracles,errors};await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}

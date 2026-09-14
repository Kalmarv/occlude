import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const instanceCheck=process.env.OCCLUDE_API_EXAMPLE==='instances',queryCheck=process.env.OCCLUDE_API_EXAMPLE==='queries',curveCheck=process.env.OCCLUDE_API_EXAMPLE==='curves',profileCheck=process.env.OCCLUDE_API_EXAMPLE==='profiles',samplingCheck=process.env.OCCLUDE_API_EXAMPLE==='sampling',decorationCheck=process.env.OCCLUDE_API_EXAMPLE==='decorations';
const evidenceDirs={instances:'instances-api',queries:'query-api',curves:'curves-api',profiles:'profile-construction',sampling:'sampling-api',decorations:'decoration-api/default'};
const output=process.env.OCCLUDE_API_EVIDENCE??('../../development/3d/'+(evidenceDirs[process.env.OCCLUDE_API_EXAMPLE]??'mesh-api'));await mkdir(output,{recursive:true});
const docs=await readFile('../../docs/three.md','utf8');
let source=[...docs.matchAll(/```ts live[^\n]*\n([\s\S]*?)```/g)][8][1].replace('const terrain =',"console.info('mesh-model'); const terrain =");
if(instanceCheck)source=(await readFile('../../development/3d/api-examples/instanced-forms.ts','utf8')).replace('const sites=',"console.info('mesh-model'); const sites=").replace('return view(forms,',"return (drawing=>{console.info('instance-shared:'+new Set(drawing.scene.objects.map(o=>o.surface)).size);return drawing;})(view(forms,").replace("stroke:'ink'});","stroke:'ink'}));");
if(queryCheck)source=(await readFile('../../development/3d/api-examples/surface-queries.ts','utf8')).replace('const pull=',"console.info('mesh-model'); const pull=").replace('const limits=',"console.info('query-proof:'+JSON.stringify({rows:roofHits.length,misses:roofHits.filter(r=>r.hit===null).length,nearestMisses:nearby.filter(r=>r.hit===null).length,identity:roofHits.every(r=>r.source===terrain.points.at(r.source.index)),typedFaces:roofHits.every(r=>!r.hit||r.hit.face.roof===true),distanceVsT:roofHits.every(r=>!r.hit||Math.abs(r.hit.distance-2*r.hit.t)<1e-10),rayOracle:roofHits.every(r=>{const x=r.source.x,y=r.source.y,z=.4-Math.tan(Math.PI/12)*x,inside=Math.abs(x)<=1.5*Math.cos(Math.PI/12)&&Math.abs(y)<=1.5;return inside?!!r.hit&&Math.abs(r.hit.position[2]-z)<1e-10&&Math.abs(r.hit.distance-(3-z))<1e-10:r.hit===null;}),nearestOracle:nearby.every(r=>{const p=r.source,c=Math.cos(Math.PI/12),s=Math.sin(Math.PI/12),x=c*p.x-s*(p.z-.4),z=s*p.x+c*(p.z-.4),d=Math.hypot(z,Math.max(0,Math.abs(x)-1.5),Math.max(0,Math.abs(p.y)-1.5));return d<=.35?!!r.hit&&Math.abs(r.hit.distance-d)<1e-10:r.hit===null;})})); const limits=");
if(curveCheck)source=(await readFile('../../development/3d/api-examples/curves.ts','utf8')).replace('const block =',"console.info('mesh-model'); const block =");
if(profileCheck)source=(await readFile('../../development/3d/api-examples/profile-construction.ts','utf8')).replace('const vessel =',"console.info('mesh-model'); const vessel =");
if(samplingCheck)source=(await readFile('../../development/3d/api-examples/surface-sampling.ts','utf8')).replace('const terrain =',"console.info('mesh-model'); const terrain =").replace('return view([terrain, trees, stones]',`console.info('sampling-proof:'+JSON.stringify({count:sites.points.length,samples:marks.points.length,generation:sites.generation,typedFace:sites.points.map(p=>p.sample.face.ground).every(v=>v===true),identity:trees.rows.every(r=>r.source===sites.points.at(r.source.index)),onSurface:sites.points.map(p=>Math.hypot(p.x-p.sample.position[0],p.y-p.sample.position[1],p.z-p.sample.position[2])).every(d=>d===0),spacing:sites.points.map((p,i)=>sites.points.map((q,j)=>i<j?Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z):Infinity)).flat().every(d=>d>=.45),aligned:trees.rows.every(r=>{const b=r.transform.rotate[1]*Math.PI/180,c=r.transform.rotate[2]*Math.PI/180,n=r.source.sample.normal;return Math.hypot(Math.cos(c)*Math.sin(b)-n[0],Math.sin(c)*Math.sin(b)-n[1],Math.cos(b)-n[2])<1e-12;})})); return view([terrain, trees, stones]`);
if(decorationCheck)source=(await readFile('../../development/3d/api-examples/surface-decoration.ts','utf8')).replace('const model =',"console.info('mesh-model'); const model =");
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1100}});let models=0;const shared=[];const queries=[];const curveOracles=[];const profileOracles=[];const samplingProofs=[];const samplingQueries=[];let samplingQueryStats;const errors=[];
 page.on('console',m=>{if(m.text().startsWith('sampling-query-proof:'))samplingQueries.push(JSON.parse(m.text().slice('sampling-query-proof:'.length)));if(m.text().startsWith('sampling-proof:'))samplingProofs.push(JSON.parse(m.text().slice('sampling-proof:'.length)));if(m.text().startsWith('profile-oracle:'))profileOracles.push(JSON.parse(m.text().slice('profile-oracle:'.length)));if(m.text().startsWith('curve-oracle:'))curveOracles.push(JSON.parse(m.text().slice('curve-oracle:'.length)));if(m.text()==='mesh-model')models++;if(m.text().startsWith('instance-shared:'))shared.push(Number(m.text().split(':')[1]));if(m.text().startsWith('query-proof:'))queries.push(JSON.parse(m.text().slice('query-proof:'.length)));});page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(source=>{if(!sessionStorage.getItem('mesh-api-initialized')){localStorage.setItem('occlude.sketch',source);sessionStorage.setItem('mesh-api-initialized','1');}window.requests=[];const Original=Worker;window.Worker=class extends Original{postMessage(m,...r){window.requests.push(m.type);return super.postMessage(m,...r);}constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.renderReplyCount=(window.renderReplyCount??0)+1;}});}};},source);
 await page.goto(base);await page.waitForFunction(()=>window.reply&&window.__occlude?.drawing.plan&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:60000});
 const diagnostics=await page.evaluate(()=>window.__occlude.editor.diagnostics());await writeFile(output+'/diagnostics.json',JSON.stringify(diagnostics,null,2));assert.deepEqual(diagnostics,[]);
 const before=await page.evaluate(async()=>({hash:window.reply.planHash,svg:await window.__occlude.drawing.svg('#fff',-1),stats:window.reply.three}));
 const zeroLengthPaths=[...before.svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"/g)].filter(m=>m[1]===m[3]&&m[2]===m[4]).length;
 if(instanceCheck)assert.equal(zeroLengthPaths,0,'convex cone instances must not emit stray endpoint dots');
 assert.equal(before.stats.adapter.isFallbackAdapter,false);assert(before.stats.scenes[0].dispatches>0);assert.equal(models,1);if(instanceCheck)assert.deepEqual(shared,[1]);
 if(queryCheck){assert.equal(queries.length,1);assert(queries[0].rows>0&&queries[0].misses>0&&queries[0].nearestMisses>0);assert(queries[0].identity&&queries[0].typedFaces&&queries[0].distanceVsT&&queries[0].rayOracle&&queries[0].nearestOracle);const batches=before.stats.modeling.filter(m=>m.operation==='query');assert.equal(batches.length,2);assert.equal(batches[0].targetCacheHit,false);assert(batches[0].targetUploadBytes>0);assert.equal(batches[1].targetCacheHit,true);assert.equal(batches[1].targetUploadBytes,0);assert(batches.every(b=>b.dispatches>0));}
 if(samplingCheck){assert.equal(samplingProofs.length,1);const p=samplingProofs[0];assert(p.count>0&&p.samples===12&&p.identity&&p.onSurface&&p.typedFace&&p.spacing&&p.aligned);assert.equal(p.generation.accepted,p.count);}
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
 const probe=decorationCheck?"box().faceAttribute('spacing',1).faces().at(0).spacing":profileCheck?"revolve(polyline([[1,0,0],[1,0,1]]).attribute('height',1)).points.at(0).height":curveCheck?"circle().attribute('height',1).points.at(0).height":queryCheck?"query(plane()).batch().nearest(plane().attribute('height',1).points)[0].source.height":instanceCheck?"instanceOnPoints(cone(),pointCloud([[0,0,0]]).attribute('height',1).points).instances.at(0).height":"plane().attribute('height',1).points.at(0).height";
 if(samplingCheck)await page.evaluate(()=>window.__occlude.editor.setValue(window.__occlude.editor.getValue()+`
function __samplingTypes(t: import('occlude').Toolkit) {
  const point: string = t.sample(plane().attribute('height',1),{count:1}).points.at(0).height;
  const face: string = instanceOnPoints(cone(),t.sample(plane().faceAttribute('ground',true),{count:1}).points).instances.at(0).source.sample.face.ground;
}`));
 else await page.evaluate(({probe,queryCheck,curveCheck,profileCheck})=>window.__occlude.editor.setValue(window.__occlude.editor.getValue()+'\nconst __typeProbe: string = '+probe+';'+(queryCheck?"\nconst __faceProbe: string = query(plane().faceAttribute('roof',true)).nearest([0,0,1]).face.roof;":'')+(curveCheck?'\ncircle().faces();':'')+(profileCheck?"\nconst __pathProbe: string = sweep(circle(),polyline([[0,0,0],[0,0,1]]).attribute('radius',1)).points.at(0).radius;":'')),{probe,queryCheck,curveCheck,profileCheck});
 if(decorationCheck)await page.evaluate(()=>window.__occlude.editor.setValue(window.__occlude.editor.getValue()+`
view(box().faceAttribute('spacing',1), {camera:orthographic({eye:[5,7,6]}), hatch:{spacing:f=>{const __bad:string=f.spacing;return mm(1);}}});`));
 const negative=await page.evaluate(()=>window.__occlude.editor.diagnostics());await writeFile(output+'/negative-diagnostics.json',JSON.stringify(negative,null,2));assert(negative.some(d=>d.code===2322),'Monaco must retain numeric attribute types rather than any');
 if(curveCheck)assert(negative.some(d=>d.code===2339),'curve geometry must not claim a face domain');
 if(queryCheck||profileCheck||samplingCheck||decorationCheck)assert.equal(negative.filter(d=>d.code===2322).length,2);
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
 if(samplingCheck){
  const querySource=`import {sketchAsync} from 'occlude';
import {plane,query,view,orthographic} from 'occlude/3d';
export default sketchAsync({seed:42},async t=>{
 const target=plane(2).faceAttribute('ground',true),sites=t.sample(target,{count:20}).translate([0,0,1]),batch=query(target).batch(t);
 const nearest=await batch.nearest(sites.points),rays=await batch.rays(sites.points,{origin:p=>[p.x,p.y,3],direction:p=>[0,0,-2*p.sample.normal[2]]}),segments=await batch.segments(sites.points,{to:p=>p.sample.position});
 console.info('sampling-query-proof:'+JSON.stringify({rows:sites.points.length,identity:[nearest,rays,segments].every(rows=>rows.every((r,i)=>r.source===sites.points.at(i))),source:[nearest,rays,segments].every(rows=>rows.every(r=>r.source.sample.source===target.surface&&r.source.sample.face.ground===true)),nearest:nearest.every(r=>r.hit&&Math.abs(r.hit.distance-1)<1e-10),rays:rays.every(r=>r.hit&&Math.abs(r.hit.distance-3)<1e-10&&Math.abs(r.hit.t-1.5)<1e-10),segments:segments.every(r=>r.hit&&Math.abs(r.hit.distance-1)<1e-10&&Math.abs(r.hit.t-1)<1e-10)}));
 return view(target,{camera:orthographic({eye:[4,5,6],span:4})});
});`;
  const priorCount=await page.evaluate(()=>window.renderReplyCount),rendered=page.waitForEvent('console',{predicate:m=>m.text().startsWith('sampling-query-proof:'),timeout:60000});
  await page.evaluate(source=>window.__occlude.editor.setValue(source),querySource);await rendered;
  await page.waitForFunction(count=>window.renderReplyCount>count&&document.querySelector('#status-msg').textContent==='ok',priorCount,{timeout:60000});
  const p=samplingQueries.at(-1);assert(p.rows===20&&p.identity&&p.source&&p.nearest&&p.rays&&p.segments);
  samplingQueryStats=await page.evaluate(()=>window.reply.three);assert.equal(samplingQueryStats.adapter.isFallbackAdapter,false);assert.equal(samplingQueryStats.modeling.length,3);assert(samplingQueryStats.modeling.every(s=>s.backend==='gpu'&&s.dispatches>0));assert.deepEqual(samplingQueryStats.modeling.map(s=>s.targetCacheHit),[false,true,true]);assert.deepEqual(await page.evaluate(()=>window.__occlude.editor.diagnostics()),[]);
 }
 assert.deepEqual(errors,[]);
 const report={passed:true,base,diagnostics,negative,modelsBeforeReopen:1,modelsAfterReopen:2,reopened,stats:before.stats,zeroLengthPaths,sharedPrototypeCounts:shared,queries,curveOracles,profileOracles,samplingProofs,samplingQueries,samplingQueryStats,errors};await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}

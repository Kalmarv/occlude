/** Exact saved demo, GPU edge intervals and exported bottom contours. */
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const fixture=process.env.OCCLUDE_PAPER_FIXTURE??'../../development/3d/paper-box-oracle';
const output=process.env.OCCLUDE_API_EVIDENCE??fixture+'/gpu';
const source=await readFile(fixture+'/source.ts','utf8');
const oracle=JSON.parse(await readFile(fixture+'/oracle.json','utf8'));
await mkdir(output,{recursive:true});
const instrument=source.replace('box, view, orthographic','box, view as baseView, orthographic')+`
function view(...args: Parameters<typeof baseView>) {
 const drawing=baseView(...args);
 return {...drawing, draw: (...args: Parameters<typeof drawing.draw>) => {
  console.info('box-edges:'+JSON.stringify(args[0].features.filter(r=>!r.feature.curve)));
  console.info('box-bottom:'+JSON.stringify(args[0].features.filter(r=>r.feature.attributes.hatchFace==='f0')));
  console.info('box-curves:'+JSON.stringify(args[0].features.filter(r=>r.feature.curve).map(r=>({id:r.feature.id,a:r.feature.a,b:r.feature.b,visible:r.visible,hidden:r.hidden}))));
  return drawing.draw(...args);
 }};
}
`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
let page;
try{
 page=await browser.newPage({viewport:{width:1440,height:1000}});const results=[],errors=[];let latest,bottom,curves;
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.text().startsWith('box-edges:'))latest=JSON.parse(m.text().slice(10));if(m.text().startsWith('box-bottom:'))bottom=JSON.parse(m.text().slice(11));if(m.text().startsWith('box-curves:'))curves=JSON.parse(m.text().slice(11));});
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.count=(window.count??0)+1;}});}};},instrument);
 await page.goto(base);await page.waitForFunction(()=>window.reply&&window.__occlude?.drawing.plan&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:60000});
 for(const row of oracle.cases){
  if(row.case){
   const variant=instrument.replace(/("paper-study":\s*)\{[^\n]+\}/,(_,prefix)=>prefix+JSON.stringify(row.camera));
   const prior=await page.evaluate(()=>window.count);latest=undefined;bottom=undefined;curves=undefined;
   await page.evaluate(source=>window.__occlude.editor.setValue(source),variant);
   await page.waitForFunction(n=>window.count>n&&document.querySelector('#status-msg').textContent==='ok',prior,{timeout:60000});
  }
  assert(latest);assert.equal(latest.length,row.edges.length);
  const reply=await page.evaluate(async()=>({camera:window.reply.construction[0].camera,stats:window.reply.three,svg:await window.__occlude.drawing.svg('#F5F0E6',-1)}));
  assert.equal(reply.stats.adapter.isFallbackAdapter,false);assert.deepEqual(await page.evaluate(()=>window.__occlude.editor.diagnostics()),[]);
  assert(bottom?.length>10);const bottomHiddenRows=row.camera.eye[2]<-.8?bottom.filter(r=>r.hidden.length>0).length:undefined;
  let maxError=0;const edgeFailures=[];
  for(const edge of row.edges){
   const actual=latest.find(r=>r.feature.id===edge.id);assert(actual,edge.id);if(actual.hidden.length!==edge.expectedHidden.length){edgeFailures.push({id:edge.id,expected:edge.expectedHidden,actual:actual.hidden});continue;}
   edge.expectedHidden.forEach((span,i)=>span.forEach((v,k)=>{const error=Math.abs(v-actual.hidden[i][k]);maxError=Math.max(maxError,error);if(error>1e-5)edgeFailures.push({id:edge.id,error});}));
  }
  const curveFailures=[];
  for(const expected of row.curves??[]){
   const actual=curves.find(r=>r.id===expected.id);assert(actual,expected.id);
   if(actual.hidden.length!==expected.expectedHidden.length){curveFailures.push({id:expected.id,expected:expected.expectedHidden,actual:actual.hidden});continue;}
   expected.expectedHidden.forEach((span,i)=>span.forEach((v,k)=>{if(Math.abs(v-actual.hidden[i][k])>1e-5)curveFailures.push({id:expected.id,expected:expected.expectedHidden,actual:actual.hidden});}));
  }
  const completeCurveOracle=curves.length===(row.curves??[]).length;
  const zeroLengthPaths=[...reply.svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"/g)].filter(m=>m[1]===m[3]&&m[2]===m[4]).length;
  // Record degenerate export paths before asserting so failures retain evidence.
  await writeFile(output+`/case-${row.case}.svg`,reply.svg);
  if(row.case===0)await page.screenshot({path:output+'/saved-view.png'});
  results.push({case:row.case,camera:reply.camera,maxError,edgeFailures,curveFailures,completeCurveOracle,bottomHiddenRows,bottom,curves,zeroLengthPaths,stats:reply.stats,edges:latest});
 }
 assert.deepEqual(errors,[]);
 await writeFile(output+'/report.json',JSON.stringify({passed:results.every(r=>(r.completeCurveOracle||r.zeroLengthPaths===0)&&r.edgeFailures.length===0&&r.curveFailures.length===0&&(r.bottomHiddenRows??0)===0),base,comparedEdges:oracle.comparedEdges,comparedCurves:oracle.comparedCurves,results,errors}));
 assert(results.every(r=>(r.completeCurveOracle||r.zeroLengthPaths===0)&&r.edgeFailures.length===0&&r.curveFailures.length===0&&(r.bottomHiddenRows??0)===0),'Box interval differences or degenerate export paths; see report.json');
 console.log(JSON.stringify({passed:true,cases:results.map(r=>({case:r.case,maxError:r.maxError,zeroLengthPaths:r.zeroLengthPaths}))}));
}catch(error){if(page)await page.screenshot({path:output+'/failure.png'});throw error;}finally{await browser.close();}

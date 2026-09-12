// Real Studio worker verification. Intercepts only this browser context's WASM
// request; production files and the shared pen library are not modified.
// node bench/contour-sdf-studio.cjs <wasm or '-'> <fixture> <artifact-dir> [url]
const {chromium}=require('playwright-core');const fs=require('node:fs');const path=require('node:path');
const [wasm,fixture,out,base='http://127.0.0.1:4173']=process.argv.slice(2);
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1500,height:1050}});
 await context.addInitScript(source=>{
  localStorage.setItem('occlude.sketch',source);
  localStorage.setItem('occlude.settings',JSON.stringify({paper:'Custom',customPaper:{w:304.8,h:304.8},paperUnit:'in',defaultMarginPct:5}));
 },fs.readFileSync(fixture,'utf8'));
 let intercepted=0;
 if(wasm!=='-')await context.route('**/*occlude_core_bg*.wasm',route=>{intercepted++;return route.fulfill({status:200,contentType:'application/wasm',body:fs.readFileSync(wasm)});});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/?seed=42');
  await page.waitForFunction(()=>{const m=document.querySelector('#status-msg');return m&&(m.className==='status-err'||(/^ok/.test(m.textContent)&&document.querySelector('#status-stats')?.textContent.includes('frags')));},null,{timeout:35000});
  const status=await page.locator('#status-msg').textContent();
  const stats=await page.evaluate(()=>window.__occlude.result()?.stats);
  await page.screenshot({path:path.join(out,'studio.png')});
  const result={fixture,status,stats,intercepted,pageErrors:errors};
  fs.writeFileSync(path.join(out,'studio.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  if(!status.startsWith('ok')||errors.length||(wasm!=='-'&&!intercepted))process.exitCode=1;
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});

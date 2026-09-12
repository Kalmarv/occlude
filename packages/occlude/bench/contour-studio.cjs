const {chromium}=require('playwright-core');
const fs=require('fs');
const path=require('path');
// Requires Playwright's Chromium. Start Studio, then: node bench/contour-studio.cjs <url> [artifact-directory]
const base=process.argv[2] || 'http://127.0.0.1:4175';
const artifacts=process.argv[3] || '/tmp/occlude-contour-studio';
fs.mkdirSync(artifacts,{recursive:true});
(async()=>{
 const source=fs.readFileSync(path.join(__dirname,'fixtures/thicken-contour-residual.ts'),'utf8');
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const results=[];
 for(const width of (process.env.WIDTHS || '0.01,0.4,0.45').split(',').map(Number)){
  const context=await browser.newContext({viewport:{width:1500,height:1050}});
  await context.addInitScript(source=>{
   localStorage.setItem('occlude.sketch',source);
   localStorage.setItem('occlude.settings',JSON.stringify({paper:'Custom',customPaper:{w:304.8,h:304.8},paperUnit:'in',defaultMarginPct:5}));
  },source);
  await context.route('**/api/pens',async route=>{
   const response=await route.fetch();
   const pens=await response.json();
   await route.fulfill({response,json:pens.map(p=>({...p,width}))});
  });
  const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const start=Date.now();await page.goto(base+'/?seed=42');
  try {
   await page.waitForFunction(()=>{
    const msg=document.querySelector('#status-msg');
    return msg && (msg.className==='status-err' || (/^ok/.test(msg.textContent)&&document.querySelector('#status-stats')?.textContent.includes('frags')));
   },null,{timeout:35000});
   const status=await page.locator('#status-msg').textContent();
   const stats=await page.locator('#status-stats').textContent();
   await page.screenshot({path:path.join(artifacts,`studio-${width}.png`)});
   const warmSamples=[];
   for(let i=0;i<Number(process.env.SAMPLES || 0);i++){
    await page.locator('#render-toggle').click();
    await page.locator('#render-toggle').click();
    await page.waitForFunction(()=>/^rendering/.test(document.querySelector('#status-msg').textContent));
    await page.waitForFunction(()=>/^ok/.test(document.querySelector('#status-msg').textContent),null,{timeout:25000});
    warmSamples.push(await page.evaluate(()=>({renderMs:window.__occlude.result().stats.renderMs,fragments:window.__occlude.result().frags.length})));
   }
   results.push({width,status,stats,elapsedMs:Date.now()-start,warmSamples,errors});
  } catch(e){results.push({width,error:String(e),errors});}
  console.log(JSON.stringify(results[results.length-1]));
  await context.close();
 }
 await browser.close();fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify(results,null,2));
 if(results.some(r=>r.error||!r.status.startsWith('ok')||r.errors.length))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});

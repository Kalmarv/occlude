// Run against the production dist server after pnpm build.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
  try {
    const page = await browser.newPage({viewport:{width:1600,height:1100}});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const source=fs.readFileSync(path.join(__dirname,'fixtures/thicken-contour-residual.ts'),'utf8');
    await page.addInitScript(source=>{
      localStorage.setItem('occlude.sketch',source);
      localStorage.setItem('occlude.settings',JSON.stringify({paper:'Custom',customPaper:{w:304.8,h:304.8}}));
    },source);
    const start=Date.now();
    await page.goto(process.env.STUDIO_URL || 'http://localhost:4173/');
    await page.waitForFunction(()=>{
      const s=document.querySelector('#status-msg');
      return s?.textContent==='ok'||s?.className==='status-err';
    },{},{timeout:30000});
    const status=await page.locator('#status-msg').textContent();
    const build=await page.locator('#status-build').textContent();
    console.log(JSON.stringify({status,build,elapsedMs:Date.now()-start,stats:await page.locator('#status-stats').textContent(),errors}));
    await page.screenshot({path:'/tmp/fable-contour-studio.png'});
    if(status!=='ok'||errors.length)throw Error('Studio render failed');
    if(process.env.EXPECTED_BUILD&&!build.includes(process.env.EXPECTED_BUILD))throw Error('Unexpected build');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});

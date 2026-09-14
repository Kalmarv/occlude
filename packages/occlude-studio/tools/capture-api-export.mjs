import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
const prefix=process.env.OCCLUDE_CAPTURE_PREFIX??'after';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const source=await readFile('../../development/3d/api-export-defect/paper-composition.ts','utf8');
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage({viewport:{width:1500,height:1100}});
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const Original=Worker;window.Worker=class extends Original{constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data.type==='render')window.apiReply=e.data;});}};},source);
 await page.goto(base);await page.waitForFunction(()=>window.apiReply&&window.__occlude?.drawing.plan&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:60000});
 const report=await page.evaluate(async()=>({reply:window.apiReply,svg:await window.__occlude.drawing.svg('#F5F0E6',-1)}));
 await writeFile(`../../development/3d/api-export-defect/${prefix}.svg`,report.svg);
 await writeFile(`../../development/3d/api-export-defect/${prefix}.json`,JSON.stringify(report.reply,null,2));
 await page.screenshot({path:`../../development/3d/api-export-defect/${prefix}.png`,fullPage:true});
 await page.setContent('<html><body style="margin:0">'+report.svg+'</body></html>');
 await page.locator('svg').evaluate(el=>{el.style.width='800px';el.style.height='1036px';});
 await page.screenshot({path:`../../development/3d/api-export-defect/${prefix}-export.png`,fullPage:true});
 const dots=[...report.svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"/g)].filter(m=>m[1]===m[3]&&m[2]===m[4]).length;
 const summary={base,passed:dots===0,zeroLengthPaths:dots,svgBytes:report.svg.length,stats:report.reply.three};
 await writeFile(`../../development/3d/api-export-defect/${prefix}-summary.json`,JSON.stringify(summary,null,2));
 if(prefix!=='before')assert.equal(dots,0,'hidden hatch must not export zero-length round-cap paths');
 console.log(JSON.stringify(summary));
}finally{await browser.close();}

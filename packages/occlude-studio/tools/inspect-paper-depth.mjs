import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const out='../../development/3d/paper-depth/';
const source=await (await fetch('http://127.0.0.1:5273/api/sketches/paper-composition')).text();
await writeFile(out+'source.ts',source);
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try {
const page=await browser.newPage({viewport:{width:1440,height:1000}});
await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const W=window.Worker;window.Worker=class extends W{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render')window.reply=e.data;});}};},source);
await page.goto('http://127.0.0.1:5273');
await page.waitForFunction(()=>window.reply&&document.querySelector('#status-msg').textContent==='ok',{}, {timeout:90000});
await page.screenshot({path:out+'paper.png'});
await writeFile(out+'paper.svg',await page.evaluate(()=>window.__occlude.drawing.svg('#F5F0E6',-1)));
await page.getByRole('button',{name:'3D',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('#construction-canvas').dataset.revision);
await page.screenshot({path:out+'world.png'});
const bounds=await page.locator('#construction-canvas').boundingBox();
await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2-400,{steps:30});await page.mouse.up();
await page.waitForTimeout(500);await page.screenshot({path:out+'underside.png'});
await writeFile(out+'capture.json',JSON.stringify(await page.evaluate(()=>window.reply.construction),null,2));
}finally{await browser.close();}

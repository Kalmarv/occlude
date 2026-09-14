import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273';
const output='../../development/3d/projection-controls';await mkdir(output,{recursive:true});
const source=`import {sketch,box3,lineArt3,pen,mm} from 'occlude';
export default sketch({seed:42,pens:{ink:pen({width:mm(.25)})}},t=>{
console.info('projection-model');const size=1+t.rnd();
return [0,1].map(i=>lineArt3({id:'view-'+i,objects:[{id:'box',surface:box3([size,1,1])}],
camera:{kind:i?'perspective':'orthographic',span:4,fovDegrees:60,eye:[5,7,6],target:[0,0,0],near:.1,far:30},
viewport:{x:10+i*90,y:20,width:80,height:100},lineSets:[{id:'edges',stroke:'ink',select:f=>f.flags!==0}]}));});`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});let models=0;
 page.on('console',m=>{if(m.text()==='projection-model')models++;});
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);window.requests=[];const Original=Worker;window.Worker=class extends Original{postMessage(m,...r){window.requests.push(m.type);return super.postMessage(m,...r);}constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render')window.reply=e.data;});}};},source);
 await page.goto(base);await page.waitForFunction(()=>window.reply&&window.__occlude?.drawing.plan,{},{timeout:60000});
 const original=await page.evaluate(async()=>({hash:window.reply.planHash,svg:await window.__occlude.drawing.svg('#fff',-1)}));
 await page.getByRole('button',{name:'3D',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#construction-canvas')?.dataset.revision);
 const projection=page.getByLabel('Projection',{exact:true}),scene=page.getByLabel('3D scene',{exact:true});
 assert.equal(await projection.inputValue(),'orthographic');
 await projection.selectOption('perspective');
 await page.getByLabel('Vertical FOV (degrees)',{exact:true}).fill('32');await page.getByLabel('Vertical FOV (degrees)',{exact:true}).press('Tab');
 await scene.selectOption('1');assert.equal(await projection.inputValue(),'perspective');assert.equal(Number(await page.getByLabel('Vertical FOV (degrees)',{exact:true}).inputValue()),60);
 await projection.selectOption('orthographic');await page.getByLabel('Orthographic span',{exact:true}).fill('5');await page.getByLabel('Orthographic span',{exact:true}).press('Tab');
 await scene.selectOption('0');assert.equal(await projection.inputValue(),'perspective');assert.equal(Number(await page.getByLabel('Vertical FOV (degrees)',{exact:true}).inputValue()),32);
 await page.getByRole('button',{name:'Reset camera',exact:true}).click();assert.equal(await projection.inputValue(),'orthographic');assert.equal(Number(await page.getByLabel('Orthographic span',{exact:true}).inputValue()),4);
 await scene.selectOption('1');assert.equal(await projection.inputValue(),'orthographic');assert.equal(Number(await page.getByLabel('Orthographic span',{exact:true}).inputValue()),5);
 await page.getByRole('button',{name:'Reset camera',exact:true}).click();assert.equal(await projection.inputValue(),'perspective');assert.equal(Number(await page.getByLabel('Vertical FOV (degrees)',{exact:true}).inputValue()),60);
 const after=await page.evaluate(async()=>({hash:window.reply.planHash,svg:await window.__occlude.drawing.svg('#fff',-1),renders:window.requests.filter(t=>t==='render').length}));
 assert.equal(after.hash,original.hash);assert.equal(after.svg,original.svg);assert.equal(models,1);assert.equal(after.renders,1);
 await page.screenshot({path:output+'/two-scenes.png',fullPage:true});
 const report={passed:true,models,renders:after.renders,explorationRetainedPerScene:true,resetBothModes:true,exportUnchanged:true};await writeFile(output+'/two-scenes.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}

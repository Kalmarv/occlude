/** Exercise stable source decimation through the served Studio and planned SVG. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273',output=resolve('../../development/3d/playwright-style-identity');
await mkdir(output,{recursive:true});
const source=(reverse=false,omit=false)=>`import { sketchAsync,paper,mm,pen,lineArt3,constructStrokes3,decimate } from 'occlude';
export default sketchAsync({seed:42,margin:0,paper:paper({width:mm(100),height:mm(100)}),pens:{ink:pen({width:mm(.2),color:'#18202A'})}},async t=>{
const view=await t.classify3(lineArt3({camera:{kind:'orthographic',span:10,eye:[0,0,5],target:[0,0,0],up:[0,1,0],near:.1,far:10},wires:Array.from({length:20},(_,i)=>({id:'wire-'+i,points:[[-4,-4+i*.4,0],[4,-4+i*.4,0]]})),lineSets:[]}));
const rows=constructStrokes3(view,[{id:'outline',stroke:'ink',select:f=>${omit?"f.objectId!=='wire-0'":'true'}}]);
return t.strokes3(${reverse?'[...rows].reverse()':'rows'},{modifiers:[decimate(.5)]});});`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(source=>{
    localStorage.setItem('occlude.sketch',source);window.replies=[];
    const Original=window.Worker;window.Worker=class extends Original{constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data.type==='render')window.replies.push(e.data);});}};
  },source());
  await page.goto(base);
  const ready=count=>page.waitForFunction(count=>window.replies.length>=count&&window.__occlude?.drawing.plan?.planHash===window.replies.at(-1).planHash, count,{timeout:60000});
  const capture=()=>page.evaluate(async()=>({svg:await window.__occlude.drawing.svg(undefined,-1),hash:window.replies.at(-1).planHash,adapter:window.replies.at(-1).three.adapter}));
  const segments=svg=>[...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].flatMap(m=>m[1].split(/(?=M)/).filter(s=>s.trim()).map(s=>{
    const numbers=s.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi).map(Number);
    assert.equal(numbers.length,4,'fixture SVG subpath must be one line');
    return JSON.stringify([numbers.slice(0,2),numbers.slice(2,4)].sort((a,b)=>a[0]-b[0]||a[1]-b[1]));
  })).sort();
  await ready(1);const original=await capture(),originalSegments=segments(original.svg);
  assert.equal(original.adapter.isFallbackAdapter,false);assert(originalSegments.length>0&&originalSegments.length<20);
  await page.evaluate(source=>window.__occlude.editor.replaceValue(source),source(true));await ready(2);const reversed=await capture();
  assert.deepEqual(segments(reversed.svg),originalSegments);
  await page.evaluate(source=>window.__occlude.editor.replaceValue(source),source(false,true));await ready(3);const filtered=await capture();
  assert.deepEqual(segments(filtered.svg),originalSegments.filter(s=>JSON.parse(s)[0][1]!==90));
  assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve(output,'filtered.png')});
  await writeFile(resolve(output,'original.svg'),original.svg);
  await writeFile(resolve(output,'report.json'),JSON.stringify({passed:true,base,browser:browser.version(),original,reversed,filtered,segments:originalSegments,errors},null,2));
  console.log(JSON.stringify({passed:true,segments:originalSegments.length,reordered:true,unrelatedSelectionRemoved:true}));
} finally {await browser.close();}

/** Served Studio check of the API-ergonomics batch: the rewritten docs examples
 * (keys removed, two-call crosshatch, flat isolines, steps shorthand) and one
 * sketch exercising every new verb on the NVIDIA adapter. */
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=process.env.OCCLUDE_GPU_URL??'http://127.0.0.1:5273',out=process.env.OCCLUDE_API_EVIDENCE??'../../development/3d/api-ergonomics/live',stamp=process.env.OCCLUDE_STAMP??'ecb4f59-api-ergonomics';
const docs=[...(await readFile('../../docs/three.md','utf8')).matchAll(/```ts live[^\n]*\n([\s\S]*?)```/g)].map(m=>m[1]);
const custom=`import { sketchAsync, pen, mm, strokes, label } from 'occlude';
import { box, sphere, cylinder, plane, instanceOnFaces, isolines, v3, falloff, light, view, perspective } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  red: pen({ width: mm(0.2), color: '#A84932' }),
  blue: pen({ width: mm(0.18), color: '#2A6F8A' }),
} }, async t => {
  const relief = plane(4, 4).subdivide(3)
    .displace(p => 0.6 * falloff(p, { radius: 2.2, ease: k => k * k }) + 0.15 * t.noise(p, { wavelength: 0.8 }))
    .steps(2, { move: p => v3.scale([0, 0, 1], 0.05 * Math.sin(p.x * 2)) })
    .attributes({ height: p => p.z }).smooth('height', { steps: 1 });
  const rings = isolines(relief, p => p.z, { count: 6, stroke: 'blue' });
  const block = box(1).translate([1.2, -1.2, 0.9]).rotate('z', 30).rotate('x', 20, { local: true });
  const pins = instanceOnFaces(cylinder(0.08, 0.5, { segments: 8 }), block.faces, { offset: 0.25 });
  const ball = sphere(0.6, { segments: 24, rings: 12 }).translate([-1.3, 1.1, 0.9]).displace(0.05);
  const sun = light({ direction: 'up', ambient: 0.1, floor: 0.15 });
  const shade = await t.hatch(ball, { spacing: 0.08, direction: s => s.tangentU, tone: sun, stroke: 'red' });
  return [
    view([relief, rings, block, pins, ball, shade], { camera: perspective({ eye: [6, -7, 6], target: [0, 0, 0.6], fovDegrees: 36 }), stroke: 'ink' }, lines => [
      strokes(lines.visible.except('isoline', 'trace'), { stroke: 'ink' }),
      strokes(lines.visible.kind('isoline'), { stroke: 'blue' }),
      strokes(lines.visible.kind('trace'), { stroke: 'red' }),
    ]),
    label('API / ERGONOMICS', 8, 94, 4, { stroke: 'ink' }),
  ];
});`;
const examples=[...(process.env.OCCLUDE_EXAMPLES??'6,16,17,18,21,23,25').split(',').map(n=>({name:`three#${n}`,src:docs[Number(n)]})),{name:'api-ergonomics',src:custom}];
await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:false,env:{...process.env,VK_DRIVER_FILES:'/usr/share/vulkan/icd.d/nvidia_icd.json'},args:['--no-sandbox','--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--disable-vulkan-surface','--ignore-gpu-blocklist']});
const results=[],errors=[];
try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(source=>{localStorage.setItem('occlude.sketch',source);const Original=Worker;window.Worker=class extends Original{constructor(...a){super(...a);this.addEventListener('message',e=>{if(e.data.type==='render'){window.reply=e.data;window.count=(window.count??0)+1;}});}};},examples[0].src);
 await page.goto(base);await page.waitForFunction(s=>document.querySelector('#status-build')?.textContent.includes(s),stamp);console.log(await page.locator('#status-build').textContent());
 for(const [iteration,{name,src}] of examples.entries()){
  const started=Date.now();
  if(iteration){const prior=await page.evaluate(()=>window.count);await page.evaluate(s=>window.__occlude.editor.setValue(s),src);await page.waitForFunction(n=>window.count>n&&document.querySelector('#status-msg').textContent==='ok',prior,{timeout:90000});}
  else await page.waitForFunction(()=>window.reply&&document.querySelector('#status-msg').textContent==='ok',{},{timeout:90000});
  const result=await page.evaluate(async()=>({stats:window.reply.three,status:document.querySelector('#status-msg').textContent,diagnostics:await window.__occlude.editor.diagnostics(),svg:await window.__occlude.drawing.svg(undefined,-1)}));
  assert.deepEqual(result.diagnostics,[],`${name} diagnostics`);assert.equal(result.stats.adapter.isFallbackAdapter,false);assert(result.svg.includes('<path'),`${name} has paths`);
  results.push({example:name,ms:Date.now()-started,status:result.status,modeling:result.stats.modeling?.map(m=>({operation:m.operation,backend:m.backend,wallMs:m.timings?.wallMs,hatch:m.hatch&&{traces:m.hatch.traces,segments:m.hatch.segments}})),svgBytes:result.svg.length});
  const file=name.replace('#','-');await page.screenshot({path:`${out}/${file}.png`});await writeFile(`${out}/${file}.svg`,result.svg);
  console.log(JSON.stringify(results.at(-1)));
 }
 assert.deepEqual(errors,[]);await writeFile(out+'/report.json',JSON.stringify({passed:true,base,stamp,examples:results.length,results,errors},null,2)+'\n');console.log(JSON.stringify({passed:true,examples:results.length}));
}catch(e){await writeFile(out+'/failure.json',JSON.stringify({results,errors,error:String(e)},null,2));throw e;}finally{await browser.close();}

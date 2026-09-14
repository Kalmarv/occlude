import {readFileSync} from 'node:fs';
import {beforeAll,it,expect} from 'vitest';
import {initOcclude,sketch,sketchAsync,compileSketchAsync,commitCamera3,render,exportSvg,pen,mm,clip,rect,group,label,strokes,dash,lineArt3,box3,decodePlanBuffer,evalPrim} from '../src/index.js';
import * as core from '../../../crates/occlude-core/pkg/occlude_core.js';
import {pensToJson} from '../src/render.js';
import {plane,box,view,orthographic,perspective} from 'occlude/3d';
import {projectedLines} from 'occlude/3d/advanced';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const config={seed:42,margin:0,pens:{ink:pen({width:mm(.25),color:'#112233'}),shade:pen({width:mm(.18),color:'#a84932'})}};
const camera=orthographic({eye:[5,7,6],span:5});
it('draws composed default mesh views and retains camera interpretation without modeling',async()=>{
 let models=0;
 const definition=sketch(config,t=>{models++;const shape=plane(3,3).subdivide(2).displace(p=>[0,0,t.noise(p.x,p.y)*.2]);return [clip(rect(5,5,90,85),view([shape,box(.6).translate([0,0,.5])],{camera,hatch:{spacing:mm(3),stroke:'shade'}})),label('MESH',10,94,3,{stroke:'ink'})];});
 const original=await compileSketchAsync(definition),before=exportSvg(original),scene=[...original.scenes3.keys()][0];
 expect(before).toContain('#a84932');expect(render(original).raw.frags.length).toBeGreaterThan(0);
 const committed=await commitCamera3(original,scene,perspective({eye:[5,7,6],fovDegrees:38}));
 expect(models).toBe(1);expect(exportSvg(original)).toBe(before);expect(exportSvg(committed)).not.toBe(before);
 expect(committed.fixedStrokes3.size).toBe(0);
});
it('replaces default emission with readable interval collections and honors group pen defaults',async()=>{
 let visible=0,hidden=0;
 const drawing=view(box(),{camera},lines=>{visible=lines.visible.length;hidden=lines.hidden.length;expect([...lines.visible].every(r=>r.range[0]<r.range[1]&&r.kinds.has('crease'))).toBe(true);return strokes(lines.visible.filter(()=>false));});
 const empty=await compileSketchAsync(sketch(config,()=>drawing));expect(render(empty).raw.frags.length).toBe(0);expect(visible).toBeGreaterThan(0);expect(hidden).toBeGreaterThan(0);
 const colored=await compileSketchAsync(sketch(config,()=>group({pen:'shade'},view(box(),{camera}))));
 const svg=exportSvg(colored);expect(svg).toContain('#a84932');expect(svg).not.toContain('#112233');
});
it('captures hatch eligibility once on the owned revision and keeps multiple views independent',async()=>{
 let selected=0;const geometry=box().faceAttribute('height',1);
 const a=view(geometry,{camera,hatch:{spacing:mm(4),select:f=>{selected++;return f.height>.7;}}});
 const b=view(geometry,{camera:orthographic({eye:[-5,7,6],span:4})});
 expect(selected).toBe(6);expect(a.scene.objects[0].surface).toBe(b.scene.objects[0].surface);
 const original=await compileSketchAsync(sketch(config,()=>[a,b]));
 const committed=await commitCamera3(original,a.scene,perspective({eye:[5,7,6],fovDegrees:35}));
 expect(selected).toBe(6);expect(committed.scenes3.get(b.scene)).toBe(original.scenes3.get(b.scene));
 expect(()=>view([box(1,{key:'same'}),box(2,{key:'same'})],{camera})).toThrow('unique');
});
it('preserves full wire dash phase through interval filtering and actual planned output',async()=>{
 const execution=await compileSketchAsync(sketchAsync(config,async t=>{
  const classified=await t.classify3(lineArt3({camera:orthographic({eye:[0,0,5],up:[0,1,0],span:10}),objects:[{id:'box',surface:box3(),lineSource:false}],wires:[{id:'wire',points:[[-4,0,0],[0,0,0],[4,0,0]]}],lineSets:[]}));
  const lines=projectedLines(classified);
  expect(lines.hidden.length).toBeGreaterThan(0);
  return strokes(lines.visible.filter(c=>c.b[0]>50),{stroke:'ink',modifiers:[dash(mm(7),mm(4))]});
 }),{paper:{w:100,h:100}});
 const result=render(execution),pens=pensToJson(result.pens),plan=core.wasm_plan(result.raw.prims,result.raw.frags,pens,200000,.01);
 const spans=decodePlanBuffer(plan).map(chain=>{const xs=chain.prims.flatMap(p=>[evalPrim(p,0)[0],evalPrim(p,1)[0]]);return [Math.min(...xs),Math.max(...xs)].map(x=>Math.round(x*1e6)/1e6);}).sort((a,b)=>a[0]-b[0]);
 expect(spans).toEqual([[55,61],[65,72],[76,83],[87,90]]);
 expect(execution.fixedStrokes3.size).toBe(1);
});

import {readFileSync} from 'node:fs';
import {beforeAll,it,expect} from 'vitest';
import { sketch, pen, mm, clip, rect, group, label, strokes, dash } from '../src/index.js';
import {
  initOcclude, compileSketchAsync, commitCamera3, render, exportSvg, decodePlanBuffer, evalPrim,
} from '../src/host.js';
import { lineArt3, box3 } from '../src/three/api/advanced.js';
import * as core from '../../../crates/occlude-core/pkg/occlude_core.js';
import {pensToJson} from '../src/render.js';
import {plane,box,view,orthographic,perspective} from 'occlude/3d';
import {projectedLines} from 'occlude/3d/advanced';
import {surfaceOf} from '../src/three/geometry/value.js';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const config={seed:42,margin:0,pens:{ink:pen({width:mm(.25),color:'#112233'}),shade:pen({width:mm(.18),color:'#a84932'})}};
const camera=orthographic({eye:[5,7,6],span:5});
it('draws composed default mesh views and retains camera interpretation without modeling',async()=>{
 let models=0;
 const definition=sketch(config,t=>{models++;const shape=plane(3,3).subdivide(2).displace(p=>[0,0,t.noise(p.x,p.y)*.2]);return [clip(rect(5,5,90,85),view([shape,box(.6).translate([0,0,.5])],{camera,hatch:{spacing:mm(3),pen:'shade'}})),label('MESH',10,94,3,{stroke:'ink'})];});
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
 let selected=0;const geometry=box().faces.set('height',1);
 const a=view(geometry,{camera,hatch:{spacing:mm(4),select:f=>{selected++;return f.height>.7;}}});
 const b=view(geometry,{camera:orthographic({eye:[-5,7,6],span:4})});
 expect(selected).toBe(6);expect(a.scene.objects[0].surface).toBe(b.scene.objects[0].surface);
 const original=await compileSketchAsync(sketch(config,()=>[a,b]));
 const committed=await commitCamera3(original,a.scene,perspective({eye:[5,7,6],fovDegrees:35}));
 expect(selected).toBe(6);expect(committed.scenes3.get(b.scene)).toBe(original.scenes3.get(b.scene));
 expect(()=>view([box(1,{key:'same'}),box(2,{key:'same'})],{camera})).toThrow('unique');
});
it('preserves full wire dash phase through interval filtering and actual planned output',async()=>{
 const execution=await compileSketchAsync(sketch(config,async t=>{
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
it('keeps full wire dash phase through a group and a cut, which are selections of the same lines',async()=>{
 const spans=async(pick:(lines:ReturnType<typeof projectedLines>,t:Parameters<Parameters<typeof sketch>[1]>[0])=>Parameters<typeof strokes>[0])=>{
  const execution=await compileSketchAsync(sketch(config,async t=>{
   const classified=await t.classify3(lineArt3({camera:orthographic({eye:[0,0,5],up:[0,1,0],span:10}),objects:[{id:'box',surface:box3(),lineSource:false}],wires:[{id:'wire',points:[[-4,0,0],[0,0,0],[4,0,0]]}],lineSets:[]}));
   return strokes(pick(projectedLines(classified),t) as never,{stroke:'ink',modifiers:[dash(mm(7),mm(4))]});
  }),{paper:{w:100,h:100}});
  const result=render(execution),plan=core.wasm_plan(result.raw.prims,result.raw.frags,pensToJson(result.pens),200000,.01);
  return decodePlanBuffer(plan).map(chain=>{const xs=chain.prims.flatMap(p=>[evalPrim(p,0)[0],evalPrim(p,1)[0]]);return [Math.min(...xs),Math.max(...xs)].map(x=>Math.round(x*1e6)/1e6);}).sort((a,b)=>a[0]-b[0]);
 };
 const right=[[55,61],[65,72],[76,83],[87,90]];
 // A group is a selection with its key; it draws as the filter does.
 expect(await spans(lines=>{const groups=lines.visible.groupBy(c=>c.b[0]>50);expect(groups.map(g=>g.key)).toEqual([false,true]);expect(groups[1].kind('wire').length).toBe(groups[1].length);return groups[1];})).toEqual(right);
 // A cut at the wire's middle keeps the right half whole, and its phase.
 expect(await spans((lines,t)=>t.within(lines.visible,rect(50,0,50,100)))).toEqual(right);
 // A cut through the middle of a dash reads its range back: the ink is the uncut ink, cut.
 expect(await spans((lines,t)=>t.within(lines.visible,rect(58,0,42,100)))).toEqual([[58,61],[65,72],[76,83],[87,90]]);
});
it('answers the selection words and refuses the ones lines do not have, by name',async()=>{
 await compileSketchAsync(sketch(config,()=>view(box(),{camera},lines=>{
  expect(typeof lines.stats.candidates).toBe('number');
  expect(()=>(lines.visible as unknown as {source:unknown}).source).toThrow(/lines.source: .*lines.stats/);
  expect(()=>lines.visible.adjacent()).toThrow(/lines.adjacent: .*lines.curves/);
  // A hidden line is no visible line: not a member, and not a name for one.
  expect(lines.visible.has(lines.hidden.at(0))).toBe(false);
  expect(()=>lines.visible.rows(lines.hidden.at(0))).toThrow(/another view or the other visibility/);
  const [first,...rest]=lines.visible.groupBy((_,i)=>i%2);
  expect(first.union(...rest).length).toBe(lines.visible.length);
  expect(lines.visible.without(first).intersect(first).length).toBe(0);
  return strokes(lines.visible);
 })));
});

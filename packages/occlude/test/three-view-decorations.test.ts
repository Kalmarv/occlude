import {beforeAll,it,expect,expectTypeOf} from 'vitest';
import {readFileSync} from 'node:fs';
import {box,view,orthographic,perspective,pointCloud,instanceOnPoints,type ViewHatch} from 'occlude/3d';
import {initOcclude,sketch,compileSketchAsync,commitCamera3,exportSvg,pen,mm} from '../src/index.js';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {cameraFrame3} from '../src/three/camera.js';
import {classifySceneCpu3} from '../src/three/visibility/scene.js';
import {section3} from '../src/three/curves/section.js';
import {hatch3} from '../src/three/curves/hatch.js';
import {lineArt3} from '../src/three/scene.js';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const camera=orthographic({eye:[5,7,6],span:5});
const config={seed:42,pens:{ink:pen({width:mm(.3),color:'#112233'}),shade:pen({width:mm(.18),color:'#445566'}),section:pen({width:mm(.25),color:'#a84932'})}};
const snapshot=(scene:ReturnType<typeof view>['scene'],cameraOverride:ReturnType<typeof orthographic>|ReturnType<typeof perspective>=camera)=>featureSnapshot3(scene.objects,[],cameraFrame3(cameraOverride,{x:0,y:0,width:100,height:100}));
it('captures typed hatch fields once per eligible face, independently of camera and caller mutations',async()=>{
 const geometry=box(2).faceAttribute('spacing',f=>f.index+3);
 let selects=0,fields=0,models=0;
 const families:ViewHatch<{spacing:number}>[]=[{key:'one',select:f=>{selects++;return f.normal[2]>0;},spacing:f=>{fields++;expectTypeOf(f.spacing).toEqualTypeOf<number>();return mm(f.spacing);},angle:f=>f.spacing*5,pen:'shade'}, {key:'two',select:f=>f.normal[2]>0,spacing:mm(8),angle:-35,pen:'section'}];
 const planeOrigin:[number,number,number]=[0,0,0];
 const drawing=view(geometry,{camera,hatch:families,sections:[{origin:planeOrigin,normal:[0,0,1],pen:'section'}]});
 families[1]={spacing:mm(100)};planeOrigin[2]=100;
 expect(selects).toBe(6);expect(fields).toBe(1);
 const object=drawing.scene.objects[0];expect(object.surface).toBe(geometry.surface);expect(object.hatch!.surface).toBe(object.surface);expect(object.curves!.surface).toBe(object.surface);
 const captured=JSON.stringify(object);
 const execution=await compileSketchAsync(sketch(config,()=>{models++;return drawing;}));
 const before=exportSvg(execution),next=await commitCamera3(execution,drawing.scene,perspective({eye:[5,7,6]}));
 expect(selects).toBe(6);expect(fields).toBe(1);expect(models).toBe(1);expect(JSON.stringify(object)).toBe(captured);
 expect(exportSvg(next)).not.toBe(before);expect(exportSvg(execution)).toBe(before);
 for(const color of ['#112233','#445566','#a84932'])expect(before).toContain(color);
});
it('preserves the exact shared kernel feature/interval result for mixed section and hatch recipes',()=>{
 const geometry=box(2).faceAttribute('spacing',5),planes=[{id:'level',origin:[0,0,0] as const,normal:[0,0,1] as const,attributes:{height:0}}];
 const families=[{id:'shade',spacing:mm(5),angle:35},{id:'cross',spacing:mm(10),angle:-35}];
 const modern=view(geometry.withKey('model'),{camera,hatch:families.map(({id,...r})=>({...r,key:id})),sections:planes.map(({id,...p})=>({...p,key:id}))});
 const legacy=lineArt3({camera,objects:[{id:'model',surface:geometry.surface,hatch:hatch3(geometry.surface,families),curves:section3(geometry.surface,planes)}],lineSets:[]});
 for(const projection of [camera,perspective({eye:[5,7,6]})]){
  expect(classifySceneCpu3(snapshot(modern.scene,projection)).features).toEqual(classifySceneCpu3(snapshot(legacy,projection)).features);
 }
});
it('sections a box at its exact square perimeter without authoring triangulation ink',()=>{
 const drawing=view(box(2),{camera,sections:[{origin:[0,0,0],normal:[0,0,1]}]});
 const segments=drawing.scene.objects[0].curves!.segments;
 // Each side is triangulated, so the square is represented by eight halves.
 expect(segments).toHaveLength(8);
 let length=0;
 for(const s of segments){
  const [a,b]=[s.a.position,s.b.position];expect(a[2]).toBe(0);expect(b[2]).toBe(0);
  expect([0,1].some(k=>Math.abs(a[k])===1&&a[k]===b[k])).toBe(true);
  length+=Math.hypot(...a.map((v,k)=>v-b[k]));
 }
 expect(length).toBe(8);
});
it('transforms captured prototype sections with instances and captures hatch eligibility per prototype',()=>{
 let calls=0;const prototype=box(2),placed=instanceOnPoints(prototype,pointCloud([[0,0,0],[4,0,2]]).points,{rotate:[0,30,0]});
 const drawing=view(placed,{camera,hatch:{spacing:mm(5),select:()=>{calls++;return false;}},sections:[{origin:[0,0,0],normal:[0,0,1]}]});
 expect(calls).toBe(6);
 const generated=snapshot(drawing.scene).features.filter(f=>f.curve?.kind==='section');expect(generated.length).toBeGreaterThan(0);
 for(const f of generated){expect(f.instance).toBeDefined();expect(f.support.length).toBeGreaterThan(0);expect(f.curve!.a.position[2]).toBe(0);expect(f.curve!.b.position[2]).toBe(0);}
 expect(new Set(generated.map(f=>f.instance!.id)).size).toBe(2);
 expect(new Set(drawing.scene.objects.map(o=>o.surface)).size).toBe(1);
});
it('validates keys and physical recipe values before drawing',()=>{
 expect(()=>view(box(),{camera,hatch:[{key:'same',spacing:mm(2)},{key:'same',spacing:mm(3)}]})).toThrow('hatch keys');
 expect(()=>view(box(),{camera,sections:[{key:'',origin:[0,0,0],normal:[0,0,1]}]})).toThrow('section keys');
 expect(view(box(),{camera,hatch:{spacing:()=>mm(0)}}).scene.objects.every(o=>o.hatch!.families.every(f=>!f.length))).toBe(true);
 expect(()=>view(box(),{camera,sections:[{origin:[0,0,0],normal:[0,0,0]}]})).toThrow();
});

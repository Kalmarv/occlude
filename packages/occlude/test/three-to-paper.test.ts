import {readFileSync} from 'node:fs';
import {beforeAll,it,expect} from 'vitest';
import {initOcclude,sketchAsync,compileSketchAsync,pen,mm,strokes,label} from '../src/index.js';
import {box,view,orthographic,perspective} from 'occlude/3d';
import {projectedLines} from 'occlude/3d/advanced';
import {Material} from '../src/material.js';
import {paperToUser} from '../src/record.js';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const config={seed:42,margin:0,pens:{ink:pen({width:mm(.25),color:'#112233'})}};
const camera=orthographic({eye:[6,9,7],span:5});
const corners:[number,number,number][]=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];

it('puts a world point exactly where the view draws it',async()=>{
 let placed:(readonly [number,number])[]=[];
 const drawing=view(box(2),{camera,stroke:'ink'});
 const execution=await compileSketchAsync(sketchAsync(config,async t=>{
   placed=corners.map(c=>t.toPaper(drawing,c));
   return drawing;
 }));
 const classified=execution.scenes3.get(drawing.scene)!;
 const toUser=paperToUser(execution.frame);
 const ends=[...projectedLines(classified).visible,...projectedLines(classified).hidden]
   .flatMap(row=>[row.a,row.b]).map(p=>toUser(p[0],p[1]));
 // Every corner of the box is an endpoint of a drawn line, to the millimetre.
 for(const p of placed){
   const nearest=Math.min(...ends.map(e=>Math.hypot(e[0]-p[0],e[1]-p[1])));
   expect(nearest).toBeLessThan(1e-9);
 }
 expect(new Set(placed.map(p=>p.join(','))).size).toBe(8);
});

it('follows the camera the view is actually drawn with',async()=>{
 let before:readonly [number,number]=[0,0],after:readonly [number,number]=[0,0];
 const drawing=view(box(2),{camera,stroke:'ink',key:'main'});
 const plain=async(t:{toPaper:(v:typeof drawing,p:[number,number,number])=>readonly [number,number]})=>t.toPaper(drawing,[1,1,1]);
 await compileSketchAsync(sketchAsync(config,async t=>{before=await plain(t);return drawing;}));
 const override=perspective({eye:[6,9,7],fovDegrees:40});
 const committed=await compileSketchAsync(sketchAsync({...config,cameras3:{main:override}},async t=>{after=await plain(t);return drawing;}));
 expect(after).not.toEqual(before);
 // The camera the run is drawn with is the one the point is placed with.
 const classified=committed.scenes3.get(drawing.scene)!;
 const toUser=paperToUser(committed.frame);
 const ends=[...projectedLines(classified).visible,...projectedLines(classified).hidden].flatMap(row=>[row.a,row.b]).map(p=>toUser(p[0],p[1]));
 expect(Math.min(...ends.map(e=>Math.hypot(e[0]-after[0],e[1]-after[1])))).toBeLessThan(1e-9);
});

it('makes a material of many points and a NaN pair behind the eye',async()=>{
 const drawing=view(box(2),{camera:perspective({eye:[0,-6,2],fovDegrees:45}),stroke:'ink'});
 let cloud:Material|undefined,behind:readonly [number,number]=[0,0],rows=0;
 await compileSketchAsync(sketchAsync(config,async t=>{
   cloud=t.toPaper(drawing,corners);
   rows=t.toPaper(drawing,{points:[[0,0,0],[0,-60,0]]}).points.length;
   behind=t.toPaper(drawing,[0,-60,0]);
   return [drawing,label('X',10,10,4,{stroke:'ink'}),strokes(cloud)];
 }));
 expect(cloud).toBeInstanceOf(Material);
 expect(cloud!.points.length).toBe(8);
 expect(behind.every(Number.isNaN)).toBe(true);
 // A point with no place on the paper is skipped, not drawn at NaN.
 expect(rows).toBe(1);
});

it('refuses anything that is not a view, by name',async()=>{
 await compileSketchAsync(sketchAsync(config,async t=>{
   expect(()=>t.toPaper({} as never,[0,0,0])).toThrow('toPaper requires');
   expect(()=>t.toPaper(view(box(),{camera}),{} as never)).toThrow('points');
   return null;
 }));
});

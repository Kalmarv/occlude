import { describe, it, expect } from 'vitest';
import { sketch, pen, mm } from 'occlude';
import { compileSketchAsync } from 'occlude/host';
import { lineArt3, section3, hatch3 } from 'occlude/3d/advanced';
import { box, view, orthographic, mesh } from 'occlude/3d';
import {SurfaceCurves,surfaceBinding3,surfaceCurveNetwork3} from 'occlude/3d/advanced';
import { captureThree3 } from './capture.js';
import { meshOfRecord3, meshRecord3 } from './protocol.js';
const context={engine:'test',scriptJs:'captured compiled source',seed:'42'};
describe('saved 3D input capture',()=>{
  it('round trips committed cameras, realized model attributes and generated support without callbacks',async()=>{
    const source=box().faces.set('importance',2,f=>f.index===0);
    const sections=section3(source,[{id:'mid',origin:[0,0,0],normal:[0,0,1]}]);
    const hatch=hatch3(sections.surface,[{id:'shade',spacing:mm(2),angle:30}]);
    const scene=lineArt3({objects:[{id:'box',surface:hatch.surface,curves:sections,hatch}],camera:{kind:'orthographic',span:3,eye:[3,4,5],target:[0,0,0],near:.1,far:30},lineSets:[{id:'visible',stroke:'ink',select:()=>true}]});
    const run=await compileSketchAsync(sketch({seed:42,pens:{ink:pen({width:mm(.3),color:'#000'})}},()=>scene));
    const captured=captureThree3(run,context)!;
    expect(JSON.parse(JSON.stringify(captured))).toEqual(captured);
    expect(captured.scenes[0].frame.camera).toEqual(scene.camera);
    expect(captured.scenes[0].objects[0].surface).toEqual(meshRecord3(scene.objects[0].surface));
    expect(meshRecord3(meshOfRecord3(captured.scenes[0].objects[0].surface))).toEqual(captured.scenes[0].objects[0].surface);
    expect(captured.scenes[0].generated.some(g=>g.curve.kind==='hatch')).toBe(true);
    expect(captured.scenes[0].generated.some(g=>g.curve.kind==='section')).toBe(true);
    (captured.scenes[0].objects[0].surface.columns.faces.importance.values as unknown[])[0]=9;
    expect(scene.objects[0].surface.faces.at(0)!.importance).toBe(2);
    expect(captured.scriptJs).toBe(context.scriptJs);
  });
  it('preserves seamed corner data through committed scene capture and JSON reopening',async()=>{
    const model=box().corners.set({uv:c=>[c.localIndex/3,c.face.index] as const});
    const scene=view(model,{camera:orthographic({eye:[3,4,5],target:[0,0,0],span:3}),pen:'ink'});
    const run=await compileSketchAsync(sketch({seed:42,pens:{ink:pen({width:mm(.3),color:'#000'})}},()=>scene));
    const captured=captureThree3(run,context)!;
    const reopened=JSON.parse(JSON.stringify(captured)) as typeof captured;
    const restored=meshOfRecord3(reopened.scenes[0].objects[0].surface);
    expect(restored.points.length).toBe(8);
    expect(restored.corners.length).toBe(24);
    expect(restored.corners.map(c=>[c.uv,c.chart])).toEqual(model.corners.map(c=>[c.uv,c.chart]));
    (reopened.scenes[0].objects[0].surface.columns.corners.uv.values as unknown[])[0]=[99,99];
    expect(restored.corners.at(0)!.uv).toEqual(model.corners.at(0)!.uv);
  });
  it('persists rational multi-source support in ordinary views without BigInt JSON loss',async()=>{
    const a=mesh([[1,0,0],[0,1,0],[0,0,1]],[[0,1,2]]),b=mesh([[0,0,0],[1,1,0],[0,0,1]],[[0,1,2]]);
    const curves=new SurfaceCurves(surfaceCurveNetwork3({sources:[{id:'a',binding:surfaceBinding3(a)},{id:'b',binding:surfaceBinding3(b)}],nodes:[{id:'p',point:[1n,1n,1n,3n]},{id:'q',point:[2n,2n,1n,5n]}],segments:[{id:'seam',kind:'intersection',a:'p',b:'q',supports:[{source:0,triangle:0},{source:1,triangle:0}]}]}));
    const drawing=view([a,b,curves],{camera:orthographic({eye:[3,4,5],span:2}),pen:'ink'});
    const run=await compileSketchAsync(sketch({pens:{ink:pen({width:mm(.3),color:'#111'})}},()=>drawing));
    const captured=captureThree3(run,context)!,restored=JSON.parse(JSON.stringify(captured)) as typeof captured;
    const graph=restored.scenes[0].supported![0].network;
    expect(graph.nodes[0].exact).toEqual(['1','1','1','3']);expect(graph.sources).toHaveLength(2);expect(graph.segments[0].supports).toHaveLength(2);
  });
  it('does not add 3D metadata to an ordinary empty execution',async()=>{
    const run=await compileSketchAsync(sketch({},()=>[]));
    expect(captureThree3(run,context)).toBeUndefined();
  });
});

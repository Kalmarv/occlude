import { describe, it, expect } from 'vitest';
import { compileSketchAsync, sketch, lineArt3, box3, section3, hatch3, pen, mm } from 'occlude';
import { captureThree3 } from './capture.js';
const context={engine:'test',scriptJs:'captured compiled source',seed:'42'};
describe('saved 3D input capture',()=>{
  it('round trips committed cameras, realized model attributes and generated support without callbacks',async()=>{
    const source=box3();source.faces[0].attributes.importance=2;
    const sections=section3(source,[{id:'mid',origin:[0,0,0],normal:[0,0,1]}]);
    const hatch=hatch3(sections.surface,[{id:'shade',spacing:mm(2),angle:30}]);
    const scene=lineArt3({objects:[{id:'box',surface:hatch.surface,curves:sections,hatch}],camera:{kind:'orthographic',span:3,eye:[3,4,5],target:[0,0,0],near:.1,far:30},lineSets:[{id:'visible',stroke:'ink',select:()=>true}]});
    const run=await compileSketchAsync(sketch({seed:42,pens:{ink:pen({width:mm(.3),color:'#000'})}},()=>scene));
    const captured=captureThree3(run,context)!;
    expect(JSON.parse(JSON.stringify(captured))).toEqual(captured);
    expect(captured.scenes[0].frame.camera).toEqual(scene.camera);
    expect(captured.scenes[0].objects[0].surface).toEqual(scene.objects[0].surface);
    expect(captured.scenes[0].objects[0].surface).not.toBe(scene.objects[0].surface);
    expect(captured.scenes[0].generated.some(g=>g.curve.kind==='hatch')).toBe(true);
    expect(captured.scenes[0].generated.some(g=>g.curve.kind==='section')).toBe(true);
    captured.scenes[0].objects[0].surface.faces[0].attributes.importance=9;
    expect(scene.objects[0].surface.faces[0].attributes.importance).toBe(2);
    expect(captured.scriptJs).toBe(context.scriptJs);
  });
  it('does not add 3D metadata to an ordinary empty execution',async()=>{
    const run=await compileSketchAsync(sketch({},()=>[]));
    expect(captureThree3(run,context)).toBeUndefined();
  });
});

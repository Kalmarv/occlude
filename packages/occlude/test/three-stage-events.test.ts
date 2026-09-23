import {describe,expect,it} from 'vitest';
import {box,view,orthographic} from '../src/three/api/index.js';
import {compileSketchAsync,initOcclude,pen,mm,sketch,type StageEvent3} from '../src/index.js';
import {readFileSync} from 'node:fs';

await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));

describe('3D stage events',()=>{
  it('reports projected source lines and then visible lines per scene, without changing the result',async()=>{
    const events:StageEvent3[]=[];
    const def=sketch({seed:1,pens:{ink:pen({width:mm(.2)})}},()=>view([box(2),box(1).translate([0,0,1.5])],{key:'boxes',camera:orthographic({eye:[5,7,6],span:5}),pen:'ink'}));
    const listened=await compileSketchAsync(def,undefined,{onStage:e=>events.push(e)});
    const silent=await compileSketchAsync(def);
    expect(events.map(e=>[e.stage,e.scene])).toEqual([['source','boxes'],['classified','boxes']]);
    const [source,classified]=events;
    expect(source.paper.w).toBeGreaterThan(0);
    expect(source.segments.length%4).toBe(0);
    expect(source.total).toBe(source.segments.length/4);
    // Every 3D-visible piece is a sub-interval of a source feature: fewer or
    // equal total length, and all coordinates lie on the paper.
    const length=(s:Float64Array)=>{let n=0;for(let i=0;i<s.length;i+=4)n+=Math.hypot(s[i+2]-s[i],s[i+3]-s[i+1]);return n;};
    expect(length(classified.segments)).toBeLessThan(length(source.segments));
    expect(classified.segments.every(v=>Number.isFinite(v))).toBe(true);
    expect(listened.getProbeStats()).toEqual(silent.getProbeStats());
    expect([...listened.scenes3.values()][0].features.length).toBe([...silent.scenes3.values()][0].features.length);
  });
  it('stays silent after cancellation',async()=>{
    const events:StageEvent3[]=[],controller=new AbortController();
    controller.abort();
    await expect(compileSketchAsync(sketch({},()=>view(box(1),{camera:orthographic({eye:[3,3,3],span:3})})),undefined,{signal:controller.signal,onStage:e=>events.push(e)})).rejects.toThrow();
    expect(events).toEqual([]);
  });
});

describe('modeling progress events',()=>{
  it('reports rising work counts for hatch, mapping and intersections without changing results',async()=>{
    const {plane,box,mapSurface,intersections:_}=await import('../src/three/api/index.js');
    const {curve,sketchAsync}=await import('../src/index.js');
    const events:{operation:string;done:number;total?:number}[]=[];
    const run=async(listen:boolean)=>{
      let sizes:number[]=[];
      await compileSketchAsync(sketchAsync({seed:3},async t=>{
        const sheet=plane(2).subdivide(3);
        const marks=await t.hatch(sheet,{direction:[1,0,0],spacing:.1});
        const mapped=await t.mapSurface(sheet,t.times(64,(_,u)=>curve([[0,u],[1,u]],{closed:false})));
        const seams=await t.intersections(box(2),box(2).translate([1,0,0]));
        sizes=[marks.edges.length,mapped.edges.length,seams.edges.length];return null;
      }),undefined,listen?{onProgress:e=>events.push(e)}:{});
      return sizes;
    };
    const listened=await run(true),silent=await run(false);
    expect(listened).toEqual(silent);
    for(const operation of ['hatch','mapSurface','intersections']){
      const done=events.filter(e=>e.operation===operation).map(e=>e.done);
      expect(done.length).toBeGreaterThan(0);
      expect(done.every((d,i)=>i===0||d>=done[i-1])).toBe(true);
    }
    expect(events.find(e=>e.operation==='intersections')?.total).toBe(1);
    expect(events.find(e=>e.operation==='mapSurface')?.total).toBe(64);
  });
});

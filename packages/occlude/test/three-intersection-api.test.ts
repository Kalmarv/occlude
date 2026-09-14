import {describe,expect,it} from 'vitest';
import {box,intersections,instanceOnPoints,pointCloud,view,orthographic} from '../src/three/api/index.js';
import {compileSketch,compileSketchAsync,initOcclude,pen,mm,sketch,sketchAsync} from '../src/index.js';
import {readFileSync} from 'node:fs';

await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));

const crossing=()=>[box(2),box(2).translate([1,0,0])] as const;

describe('public three intersections API',()=>{
  it('returns supported curves with typed contact attributes usable by view',()=>{
    const [a,b]=crossing(),curves=intersections(a,b);
    const transverse=curves.edges.filter(edge=>edge.contact==='transverse').extract();
    expect(curves.edges.length).toBeGreaterThan(0);
    expect(transverse).toBeInstanceOf(curves.constructor);
    expect(view(transverse,{camera:orthographic({eye:[5,5,5],span:5})})).toBeTruthy();
  });

  it('enforces placement pair and aggregate graph budgets',()=>{
    const prototype=box(2),points=pointCloud([[0,0,0],[1,0,0]]),instances=instanceOnPoints(prototype,points.points);
    expect(()=>intersections(instances,prototype,{maxPairs:1})).toThrow('placement pair budget');
    expect(()=>intersections(instances,prototype,{budget:{graph:{maxSources:2}}})).toThrow('source budget');
    expect(()=>intersections(prototype,prototype,{budget:{contacts:{maxCandidates:0}}})).toThrow('candidate budget');
    expect(()=>intersections(prototype,prototype,{budget:{graph:{maxNodes:0}}})).toThrow('node/segment budget');
  });

  it('runs through the bound async toolkit and records aggregate stats',async()=>{
    let curves!:Awaited<ReturnType<typeof intersections>>;
    const run=await compileSketchAsync(sketchAsync({seed:42,pens:{ink:pen({width:mm(.2)})}},async t=>{
      const [a,b]=crossing();curves=await t.intersections(a,b);return null;
    }));
    expect(curves.edges.length).toBeGreaterThan(0);
    expect(run.modeling3).toHaveLength(1);
    expect(run.modeling3[0].operation).toBe('intersections');
    expect(run.modeling3[0].intersections?.pairs).toBe(1);
  });

  it('captures options before the async boundary',async()=>{
    const [a,b]=crossing();const options:{key?:string}={key:'captured'};
    const run=await compileSketchAsync(sketchAsync({seed:42},async t=>{
      const pending=t.intersections(a,b,options);options.key='mutated';
      const curves=await pending;expect(curves.key).toBe('captured');return null;
    }));
    expect(run.modeling3).toHaveLength(1);
  });

  it('cancels construction before adopting its result',async()=>{
    const prototype=box(2),points=pointCloud([[0,0,0],[1,0,0],[0,1,0],[1,1,0]]),instances=instanceOnPoints(prototype,points.points);
    const controller=new AbortController();
    await expect(compileSketchAsync(sketchAsync({seed:42},async t=>{
      const pending=t.intersections(instances,instances);setTimeout(()=>controller.abort(),0);await pending;return null;
    }),undefined,{signal:controller.signal})).rejects.toThrow();
  });

  it('rejects a retained toolkit after its execution closes',async()=>{
    let toolkit!:ReturnType<typeof import('../src/api.js').bindToolkit>;
    await compileSketchAsync(sketch({},t=>{toolkit=t;return null;}));
    expect(()=>toolkit.intersections(box(2),box(2))).toThrow('execution has finished');
  });
});

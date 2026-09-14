import {afterEach,beforeAll,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {PhaseClock3,phaseKeys3} from '../src/three/timing.js';
import {initOcclude,sketchAsync,compileSketchAsync,exportSvg,mm,pen} from '../src/index.js';
import {plane,box,view,orthographic,query} from 'occlude/3d';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
afterEach(()=>vi.restoreAllMocks());
it('composes exclusive child phases without counting child wall time twice',async()=>{
 let now=0;vi.spyOn(performance,'now').mockImplementation(()=>now);
 const outer=new PhaseClock3();outer.measure('captureMs',()=>{now+=2;});
 now+=1;const child=new PhaseClock3();child.measure('packingMs',()=>{now+=3;});
 await child.wait('readbackWaitMs',async()=>{now+=7;});
 now+=2;outer.merge(child.finish());now+=4;
 const timing=outer.finish();expect(timing.wallMs).toBe(19);expect(timing.captureMs).toBe(2);expect(timing.packingMs).toBe(3);expect(timing.readbackWaitMs).toBe(7);expect(timing.unattributedMs).toBe(7);
 expect(Object.isFrozen(timing)).toBe(true);
 expect(phaseKeys3.reduce((n,key)=>n+timing[key],timing.unattributedMs)).toBe(timing.wallMs);
});
it('reports CPU modeling and classification boundaries without affecting repeatable ink',async()=>{
 const definition=sketchAsync({seed:42,pens:{ink:pen({width:mm(.3)})}},async t=>{
   const target=plane(),points=box().points;
   const hits=await query(target).batch(t).nearest(points);expect(hits).toHaveLength(8);
   const moved=await t.deform3(target.surface,{iterations:2,relaxation:0,displacements:target.points.map(()=>[0,0,.1] as const)});
   expect(moved.points.every(p=>p.position[2]===.2)).toBe(true);
   return view(box(),{camera:orthographic({eye:[5,7,6]})});
 });
 const first=await compileSketchAsync(definition),second=await compileSketchAsync(definition);
 expect(exportSvg(first)).toBe(exportSvg(second));
 for(const stats of [...first.modeling3,...[...first.scenes3.values()].map(v=>v.stats)]){
   const t=stats.timings!;expect(t).toBeDefined();expect(t.wallMs).toBeGreaterThanOrEqual(0);
   for(const key of [...phaseKeys3,'unattributedMs'] as const)expect(t[key]).toBeGreaterThanOrEqual(-1e-6);
   expect(t.uploadSubmitMs).toBe(0);expect(t.readbackWaitMs).toBe(0);expect(t.dispatchSubmitMs).toBe(0);
   expect(phaseKeys3.reduce((sum,key)=>sum+t[key],t.unattributedMs)).toBeCloseTo(t.wallMs,8);
 }
});

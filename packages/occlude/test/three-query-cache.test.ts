import {afterEach,it,expect,vi} from 'vitest';
import {GpuSceneCompute3} from '../src/compute/webgpu/scene.js';
import {GpuIntervals3} from '../src/compute/webgpu/interval.js';
import {GpuSurfaceQueries3} from '../src/compute/webgpu/queries.js';
import {plane} from 'occlude/3d';
afterEach(()=>vi.restoreAllMocks());
function host(memoryBudgetBytes=4096){
  const disposed:ReturnType<typeof vi.fn>[]=[],budgets:number[]=[];
  vi.spyOn(GpuIntervals3,'create').mockResolvedValue({available:true,device:{},dispose:vi.fn(async()=>{})} as unknown as GpuIntervals3);
  const create=vi.spyOn(GpuSurfaceQueries3,'create').mockImplementation(async(_device,source,options)=>{
    budgets.push(options!.memoryBudgetBytes!);const dispose=vi.fn(async()=>{});disposed.push(dispose);
    const stats={queries:1,dispatches:1,refinements:0,transferBytes:48,wallMs:0};
    return {uploadBytes:source.triangles.length*48,rays:async(q:any)=>({hits:source.rays(q),stats}),segments:async(q:any)=>({hits:source.segments(q),stats}),nearest:async(q:any)=>({hits:source.nearest(q),stats}),dispose} as unknown as GpuSurfaceQueries3;
  });
  return {compute:new GpuSceneCompute3({} as GPU,{memoryBudgetBytes}),create,disposed,budgets};
}
it('reuses owned targets, evicts least-recently-used targets and disposes every allocation once',async()=>{
 const {compute,create,disposed}=host(),targets=Array.from({length:5},(_,i)=>plane(2).translate([0,0,i]));
 const run=(i:number)=>compute.query(targets[i].surface,{nearest:[{point:[0,0,8]}]});
 const first=await run(0),again=await run(0);expect(first.stats.targetCacheHit).toBe(false);expect(first.stats.targetUploadBytes).toBe(96);expect(again.stats.targetCacheHit).toBe(true);expect(again.stats.targetUploadBytes).toBe(0);expect(create).toHaveBeenCalledTimes(1);
 for(let i=1;i<5;i++)await run(i);expect(disposed[0]).toHaveBeenCalledTimes(1);
 expect((await run(1)).stats.targetCacheHit).toBe(true);expect((await run(0)).stats.targetCacheHit).toBe(false);expect(disposed[2]).toHaveBeenCalledTimes(1);
 await compute.dispose();expect(disposed).toHaveLength(6);expect(disposed.every(d=>d.mock.calls.length===1)).toBe(true);await expect(run(0)).rejects.toThrow('disposed');
});
it('reserves scratch capacity while bounding retained targets, and leaves cache intact on pre-cancellation',async()=>{
 const {compute,create,disposed,budgets}=host(400),targets=[plane(),plane(),plane()];
 for(const target of targets)await compute.query(target.surface,{nearest:[]});
 expect(budgets).toEqual([296,296,296]);expect(disposed[0]).toHaveBeenCalledTimes(1); // Only two 96-byte targets fit beside 200 bytes of scratch.
 const controller=new AbortController();controller.abort();await expect(compute.query(targets[2].surface,{}, {signal:controller.signal})).rejects.toThrow();expect(create).toHaveBeenCalledTimes(3);
 expect((await compute.query(targets[2].surface,{})).stats.targetCacheHit).toBe(true);await compute.dispose();expect(disposed.every(d=>d.mock.calls.length===1)).toBe(true);
});

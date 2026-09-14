import {describe,expect,it} from 'vitest';
import {ProjectedIndex3,depthCutoff3} from '../src/three/visibility/index.js';
import {refinementTargets3} from '../src/three/visibility/scene.js';
import {box,view,perspective} from '../src/three/api/index.js';
import {compileSketchAsync,initOcclude,sketch} from '../src/index.js';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {candidatePairs3} from '../src/three/visibility/scene.js';
import {readFileSync} from 'node:fs';

await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));

describe('visibility candidate pruning',()=>{
  it('skips items entirely farther than a query, keeps abutting and nearer ones',()=>{
    const bounds=[[0,0,1,1],[0,0,1,1],[0,0,1,1],[5,5,6,6]] as const;
    const index=new ProjectedIndex3(bounds as never,[-10,-5,-1,-1]);
    const cutoff=depthCutoff3(-5);
    expect([...index.query([0,0,1,1],cutoff)].sort()).toEqual([1,2]);
    expect([...index.query([0,0,1,1])].sort()).toEqual([0,1,2]);
    expect(depthCutoff3(-5)).toBeLessThan(-5);
    expect(()=>new ProjectedIndex3(bounds as never,[1])).toThrow('one value per item');
  });
  it('closes end-to-start abutments of edge-adjacent occluders and refines every other near endpoint',()=>{
    const runs=[{interval:[0,.5] as const,occluder:0},{interval:[.5,1] as const,occluder:1},{interval:[.5,.8] as const,occluder:2}];
    const adjacent=(a:number,b:number)=>(a===0&&b===1)||(a===1&&b===0);
    const {refine,closed}=refinementTargets3(runs,1e-6,adjacent);
    // 0 ends where 1 starts across a shared edge: closed, not refined; the
    // unrelated 2 starts next to 1's start (consecutive endpoints): refined.
    expect(closed).toEqual([{end:0,start:1}]);expect([...refine].sort()).toEqual([1,2]);
    const {refine:alone,closed:none}=refinementTargets3(runs.slice(0,2),1e-6,()=>false);
    expect([...alone].sort()).toEqual([0,1]);expect(none).toEqual([]);
    // Rounded the other way (a slight overlap) the same seam is still closed.
    const overlap=[{interval:[0,.5000001] as const,occluder:0},{interval:[.4999999,1] as const,occluder:1}];
    expect(refinementTargets3(overlap,1e-6,adjacent).closed).toEqual([{end:0,start:1}]);
    // Two near starts of adjacent occluders open no gap: nothing to refine;
    // the same pair from unrelated occluders is refined.
    // Endpoints at a feature's own ends are clipping bounds: never refined.
    const covered=[{interval:[0,1] as const,occluder:0},{interval:[0,1] as const,occluder:5},{interval:[0,.5] as const,occluder:9}];
    expect(refinementTargets3(covered,1e-6,()=>false).refine.size).toBe(0);
    const same=[{interval:[.1,.5] as const,occluder:0},{interval:[.1,.7] as const,occluder:1}];
    expect(refinementTargets3(same,1e-6,adjacent).refine.size).toBe(0);
    expect(refinementTargets3(same,1e-6,()=>false).refine.size).toBe(2);
  });
  it('keeps the CPU reference drawing identical with depth pruning in place',async()=>{
    const run=await compileSketchAsync(sketch({seed:1},()=>view([box(2),box(1).translate([0,0,1.6]),box([3,3,.2]).translate([0,0,-1.2])],{camera:perspective({eye:[5,7,6],fovDegrees:40})})));
    const classified=[...run.scenes3.values()][0];
    expect(classified.stats.candidates).toBeGreaterThan(0);
    const snapshot=featureSnapshot3([...run.scenes3.keys()][0].objects,[],classified.frame);
    let pruned=0;for(const _ of candidatePairs3(snapshot))pruned++;
    const unpruned=snapshot.features.reduce((n,f)=>n+[...snapshot.index.query([-1e9,-1e9,1e9,1e9])].filter(j=>!f.support.includes(snapshot.occluders[j].id)).length,0);
    expect(pruned).toBeLessThan(unpruned);expect(pruned).toBe(classified.stats.candidates);
  });
});

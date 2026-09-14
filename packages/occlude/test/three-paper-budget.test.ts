import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { box3, commitCamera3, compileSketchAsync, initOcclude, lineArt3, mm, pen, sketch } from '../src/index.js';
import { paperBudget3, intervalTolerance3 } from '../src/three/visibility/precision.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';
import { precisionFixtures3 } from '../tools/precision-fixtures3.js';
import { lerp3 } from '../src/three/math.js';
import { toPaper3 } from '../src/three/camera.js';

beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
it('bounds paper displacement along each clipped feature, including steep perspective and overscan',()=>{
  for(const {snapshot} of precisionFixtures3()){
    const budget=1e-6, tolerance=intervalTolerance3(snapshot,budget);
    for(const feature of snapshot.features)for(const t of [0,.01,.2,.5,.99,1-tolerance]){
      const a=toPaper3(snapshot.frame,lerp3(feature.a,feature.b,t));
      const b=toPaper3(snapshot.frame,lerp3(feature.a,feature.b,Math.min(1,t+tolerance)));
      expect(Math.hypot(a[0]-b[0],a[1]-b[1])).toBeLessThanOrEqual(budget/2+1e-12);
    }
  }
});
it('rejects invalid budgets and pen widths, and keeps a positive subnormal tolerance',()=>{
  const snapshot=precisionFixtures3()[0].snapshot;
  for(const value of [0,-1,NaN,Infinity]){
    expect(()=>paperBudget3([value])).toThrow();
    expect(()=>intervalTolerance3(snapshot,value)).toThrow();
    expect(()=>intervalTolerance3(snapshot,.005,value)).toThrow();
  }
  expect(paperBudget3([.3,.01])).toBe(.0005);
  expect(intervalTolerance3(snapshot,Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
});
it('passes the narrowest resolved nib budget per execution and retains it on camera commit',async()=>{
  const camera={kind:'orthographic' as const,span:4,eye:[4,6,5] as const,target:[0,0,0] as const,near:.1,far:30};
  const scene=lineArt3({camera,objects:[{id:'box',surface:box3([1,1,1])}],lineSets:[{id:'edges',stroke:'ink'}]});
  const seen:number[]=[];
  const compute3={async classify(snapshot:Parameters<typeof classifySceneCpu3>[0], options:{paperToleranceMm?:number}){seen.push(options.paperToleranceMm!);return classifySceneCpu3(snapshot);}};
  for(const width of [.3,.002]){
    const result=await compileSketchAsync(sketch({pens:{ink:pen({width:mm(.3)}), later:pen({width:mm(width)})}},()=>[scene,scene]),undefined,{compute3});
    await commitCamera3(result,scene,{...camera,span:8},{compute3});
  }
  expect(seen).toEqual([.005,.005,.0001,.0001]);
});

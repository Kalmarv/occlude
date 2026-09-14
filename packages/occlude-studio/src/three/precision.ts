import { paperBudget3, intervalTolerance3 } from 'occlude/src/three/visibility/precision.js';
import { precisionFixtures3, paperBudgetFixtures3 } from '../../../occlude/tools/precision-fixtures3.js';
import { GpuIntervals3 } from 'occlude/src/compute/webgpu/interval.js';
import { candidatePairs3, classifySceneGpu3 } from 'occlude/src/three/visibility/scene.js';
import { toPaper3 } from 'occlude/src/three/camera.js';
import { lerp3 } from 'occlude/src/three/math.js';
/** Analytical hardware acceptance, including paper-space endpoint error. */
export async function precision3(){
  const gpu=await GpuIntervals3.create(navigator.gpu,{requireHardware:true});
  try {
    const cases=[];
    for(const fixture of precisionFixtures3()){
      const drawing=await classifySceneGpu3(fixture.snapshot,gpu,{pairCapacity:1});
      if(drawing.features.length!==(fixture.features??1))throw new Error(`${fixture.id}: feature count`);
      if(fixture.triangles!==undefined&&fixture.snapshot.triangles.length!==fixture.triangles)throw new Error(`${fixture.id}: clipped triangle count`);
      let parameterError=0,paperErrorMm=0;
      for(const row of drawing.features){
        if(row.hidden.length!==fixture.hidden.length)throw new Error(`${fixture.id}: interval topology ${JSON.stringify(row.hidden)}`);
        row.hidden.forEach((range,i)=>range.forEach((value,j)=>{
          const expected=fixture.hidden[i][j];parameterError=Math.max(parameterError,Math.abs(value-expected));
          const actualPoint=toPaper3(drawing.frame,lerp3(row.feature.a,row.feature.b,value));
          const expectedPoint=toPaper3(drawing.frame,lerp3(row.feature.a,row.feature.b,expected));
          paperErrorMm=Math.max(paperErrorMm,Math.hypot(actualPoint[0]-expectedPoint[0],actualPoint[1]-expectedPoint[1]));
        }));
        if(fixture.sourceRange&&row.feature.range.some((value,i)=>Math.abs(value-fixture.sourceRange![i])>1e-12))throw new Error(`${fixture.id}: source clipping range`);
      }
      if(parameterError>1e-5||paperErrorMm>.005)throw new Error(`${fixture.id}: error ${parameterError}, ${paperErrorMm} mm`);
      cases.push({id:fixture.id,features:drawing.features.length,triangles:fixture.snapshot.triangles.length,expected:fixture.hidden,actual:drawing.features.map(row=>row.hidden),parameterError,paperErrorMm,stats:drawing.stats});
    }
    const physicalBudgetCases=[];
    for (const fixture of paperBudgetFixtures3()) {
      const paperToleranceMm=paperBudget3([fixture.nib]);
      const pairs=[...candidatePairs3(fixture.snapshot)].map(row=>row.pair);
      const old=await gpu.classify(pairs,{parameterTolerance:1e-5});
      const result=await classifySceneGpu3(fixture.snapshot,gpu,{paperToleranceMm});
      const error=(ranges: readonly (readonly [number,number] | null)[])=>{
        if(ranges.length!==1||!ranges[0])throw new Error(`${fixture.id}: missing interval`);
        const feature=fixture.snapshot.features[0];
        return Math.max(...ranges[0].map((t,j)=>{
          const a=toPaper3(fixture.snapshot.frame,lerp3(feature.a,feature.b,t));
          const b=toPaper3(fixture.snapshot.frame,lerp3(feature.a,feature.b,fixture.hidden[0][j]));
          return Math.hypot(a[0]-b[0],a[1]-b[1]);
        }));
      };
      const fixedToleranceErrorMm=error(old.intervals), paperErrorMm=error(result.features[0].hidden);
      if(!(fixedToleranceErrorMm>paperToleranceMm))throw new Error(`${fixture.id}: negative control did not expose fixed tolerance`);
      if(paperErrorMm>paperToleranceMm/2)throw new Error(`${fixture.id}: interval budget exceeded`);
      physicalBudgetCases.push({id:fixture.id,nibMm:fixture.nib,paperToleranceMm,parameterTolerance:intervalTolerance3(fixture.snapshot,paperToleranceMm),fixedToleranceErrorMm,paperErrorMm,stats:result.stats});
    }
    return {passed:true,adapter:{vendor:gpu.adapterInfo.vendor,architecture:gpu.adapterInfo.architecture,isFallbackAdapter:gpu.adapterInfo.isFallbackAdapter},paperBudgetMm:.005,pairCapacity:1,cases,physicalBudgetCases};
  }finally{await gpu.dispose();}
}

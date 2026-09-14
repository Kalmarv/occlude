import { expect, it } from 'vitest';
import { precisionFixtures3 } from '../tools/precision-fixtures3.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';
for(const fixture of precisionFixtures3())it(`analytical visibility: ${fixture.id}`,()=>{
  const result=classifySceneCpu3(fixture.snapshot);
  expect(result.features).toHaveLength(fixture.features??1);
  if(fixture.triangles!==undefined)expect(fixture.snapshot.triangles).toHaveLength(fixture.triangles);
  for(const row of result.features){
    expect(row.hidden).toHaveLength(fixture.hidden.length);
    row.hidden.forEach((range,i)=>range.forEach((value,j)=>expect(value).toBeCloseTo(fixture.hidden[i][j],12)));
    if(fixture.sourceRange)row.feature.range.forEach((value,i)=>expect(value).toBeCloseTo(fixture.sourceRange![i],14));
  }
});

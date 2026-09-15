/** Compare complete projected segment coverage; chaining order is intentionally independent. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { surface3 } from '../src/three/geometry/surface.js';
import { cameraFrame3, toPaper3, type Camera3 } from '../src/three/camera.js';
import { featureSnapshot3, FeatureKind3 } from '../src/three/features/snapshot.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';
import { lerp3, type Vec3 } from '../src/three/math.js';
type Point = readonly [number, number];
type Segment = readonly [Point, Point];
type Fixture = { id: string; camera: Camera3; features: (keyof typeof FeatureKind3)[]; visibility: ('visible'|'hidden')[]; objects: {id:string;positions:Vec3[];polygons:number[][];marked?:[number,number][]}[] };
const directory = resolve(process.argv[2] ?? 'test/fixtures/three-reference');
const fixtures: Fixture[] = JSON.parse(readFileSync(resolve(directory,'fixtures.json'),'utf8'));
const referenceName = process.argv[4] ?? 'blender';
const prefix = referenceName === 'blender' ? '' : `${referenceName}-`;
const reference: {version:string;buildHash:string;cases:{id:string;visibility:'visible'|'hidden';segments:Segment[]}[]} = JSON.parse(readFileSync(resolve(directory,`${referenceName}.json`),'utf8'));
assert.equal(reference.version, '5.2.1 LTS');
const hardware: {adapter:{isFallbackAdapter:boolean};cases:{id:string;visibility:string;segments:Segment[]}[]} | undefined = process.argv[3] && process.argv[3] !== '-' ? JSON.parse(readFileSync(resolve(process.argv[3]),'utf8')) : undefined;
if(hardware)assert.equal(hardware.adapter.isFallbackAdapter,false);
const toleranceMm = 0.0001;
/** Cover each entire source segment with collinear target intervals, in both directions.
 * This permits different chaining/subdivision but detects missing or extra line portions. */
function uncovered(source: readonly Segment[], target: readonly Segment[]): number {
  let total = 0;
  for (const [a,b] of source) {
    const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
    if(length===0)continue;
    const project=(p:Point)=>((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length;
    const distance=(p:Point)=>Math.abs((p[0]-a[0])*dy-(p[1]-a[1])*dx)/length;
    const intervals=target.filter(([c,d])=>distance(c)<=toleranceMm&&distance(d)<=toleranceMm)
      .map(([c,d])=>[Math.max(0,Math.min(project(c),project(d))),Math.min(length,Math.max(project(c),project(d)))])
      .filter(([lo,hi])=>lo<=hi).sort((a,b)=>a[0]-b[0]);
    let cursor=0;
    for(const [lo,hi] of intervals){if(lo>cursor+toleranceMm)total+=lo-cursor;cursor=Math.max(cursor,hi);}
    if(length>cursor+toleranceMm)total+=length-cursor;
  }
  return total;
}
/** Independent Möller–Trumbore segment/triangle check at interval interiors.
 * This does not use the visibility half-spaces or projected candidate index. */
function rayBlocked(point: Vec3, triangles: readonly (readonly Vec3[])[], perspective: boolean): boolean {
  const origin: Vec3 = perspective ? [0,0,0] : [point[0],point[1],0];
  const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const direction=sub(point,origin);
  return triangles.some(([a,b,c])=>{
    const e1=sub(b,a),e2=sub(c,a),h=cross(direction,e2),det=dot(e1,h);
    if(Math.abs(det)<1e-12)return false;
    const q=sub(origin,a),u=dot(q,h)/det,k=cross(q,e1),v=dot(direction,k)/det,t=dot(e2,k)/det;
    return u>=0&&v>=0&&u+v<=1&&t>1e-8&&t<1-1e-8;
  });
}
const cases=[];
for(const fixture of fixtures){
  const frame=cameraFrame3(fixture.camera,{x:0,y:0,width:100,height:100});
  const objects=fixture.objects.map(source=>{
    const surface=surface3(source.positions,source.polygons);
    for(const edge of surface.edges)if(source.marked?.some(([a,b])=>edge.vertices.includes(a)&&edge.vertices.includes(b)))edge.attributes.marked=true;
    return {id:source.id,surface};
  });
  const snapshot=featureSnapshot3(objects,[],frame);
  const classified=classifySceneCpu3(snapshot);
  const flags=fixture.features.reduce((mask,kind)=>mask|FeatureKind3[kind],0);
  for(const visibility of fixture.visibility){
    const expected=reference.cases.find(c=>c.id===fixture.id&&c.visibility===visibility);assert(expected);
    const cpuSegments:Segment[]=classified.features.filter(f=>f.feature.flags&flags).flatMap(f=>f[visibility].map(([lo,hi])=>[
      toPaper3(frame,lerp3(f.feature.a,f.feature.b,lo)),toPaper3(frame,lerp3(f.feature.a,f.feature.b,hi)),
    ] as Segment));
    const gpuCase=hardware?.cases.find(c=>c.id===fixture.id&&c.visibility===visibility);
    if(hardware)assert(gpuCase,`missing hardware case ${fixture.id}/${visibility}`);
    const segments=gpuCase?.segments??cpuSegments;
    const extraMm=uncovered(segments,expected.segments),missingMm=uncovered(expected.segments,segments);
    let rayChecks=0, unrepresentableInteriorSamples=0;
    for(const row of classified.features.filter(f=>f.feature.flags&flags))for(const [lo,hi] of row[visibility])for(const fraction of [.25,.5,.75]){
      const parameter=lo+(hi-lo)*fraction;
      if(!(parameter>lo&&parameter<hi)){unrepresentableInteriorSamples++;continue;}
      const point=lerp3(row.feature.a,row.feature.b,parameter);
      assert.equal(rayBlocked(point,snapshot.triangles,fixture.camera.kind==='perspective'),visibility==='hidden',`independent ray disagrees at ${fixture.id}/${row.feature.id}/${visibility}/${lo},${hi}`);
      rayChecks++;
    }
    const result={id:fixture.id,visibility,rayChecks,unrepresentableInteriorSamples,occludeSegments:segments.length,blenderSegments:expected.segments.length,extraMm,missingMm,passed:extraMm===0&&missingMm===0};cases.push(result);
    const paths=(values:readonly Segment[],color:string)=>values.map(([a,b])=>`<path d="M${a.join(' ')} L${b.join(' ')}" stroke="${color}"/>`).join('');
    writeFileSync(resolve(directory,`${prefix}${fixture.id}-${visibility}${hardware?'-gpu':''}.svg`),`<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100"><rect width="200" height="100" fill="white"/><g fill="none" stroke-width="0.15">${paths(expected.segments,'#a84932')}<g transform="translate(100 0)">${paths(segments,'#18202a')}</g></g></svg>`);
    console.log(JSON.stringify(result));
  }
}
writeFileSync(resolve(directory,`${prefix}${hardware?'comparison-gpu.json':'comparison.json'}`),JSON.stringify({backend:hardware?'gpu':'cpu',independentRayBackend:'cpu',referenceVersion:reference.version,buildHash:reference.buildHash,toleranceMm,comparison:'bidirectional collinear segment coverage, independent of chaining',passed:cases.every(c=>c.passed),cases},null,2)+'\n');
assert(cases.every(c=>c.passed),'Blender comparison has unmatched geometry; inspect comparison.json');

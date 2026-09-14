import {beforeAll,describe,it,expect,expectTypeOf} from 'vitest';
import {readFileSync} from 'node:fs';
import {compileSketch,sketch,initOcclude} from 'occlude';
import {sampleSurfacePoints} from '../src/three/api/sampling.js';
import {mesh,box,plane} from 'occlude/3d';
import {surfaceLocation3,rebindSurfaceLocation3} from '../src/three/geometry/location.js';
import {sameAttachmentTopology3} from '../src/three/geometry/topology.js';
import {dot3,cross3,sub3,unit3,type Vec3} from '../src/three/math.js';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const triangle=()=>mesh([[0,0,0],[2,0,0],[0,3,0]],[[0,1,2]])
  .attributes({heat:p=>p.x+2*p.y,label:p=>p.index},{transfer:{label:'nearest'}})
  .faceAttributes({group:'sheet'})
  .cornerAttributes({uv:c=>[c.point.x/2,c.point.y/3] as const,chart:'island'});
const close=(a:Vec3,b:Vec3)=>a.forEach((v,i)=>expect(v).toBeCloseTo(b[i],12));
describe('owned surface locations',()=>{
 it('captures affine source data, distinct domains and chart derivatives',()=>{
  const model=triangle(),p=surfaceLocation3(model.surface,0,[.25,.25,.5],{pointTransfers:model.transfers});
  expect(p.source).toBe(model.surface);expect(p.space).toBe('model');
  expect(p.position).toEqual([.5,1.5,0]);expect(p.modelPosition).toBe(p.position);
  expect(p.barycentric).toEqual([.25,.25,.5]);expect(p.vertexIds).toEqual(model.points.map(p=>p.id));
  expect(p.pointAttributes).toEqual({heat:3.5,label:2});expect(p.faceAttributes.group).toBe('sheet');
  expect(p.uv).toEqual([.25,.5]);expect(p.cornerAttributes.uv).toEqual(p.uv);expect(p.chart).toBe('island');
  expect(p.chartStatus).toBe('regular');expect(p.frame!.du).toEqual([2,0,0]);expect(p.frame!.dv).toEqual([0,3,0]);expect(p.frame!.orientation).toBe(1);
  expect(Object.isFrozen(p.cornerAttributes.uv)).toBe(true);
  expect(()=>{(p.position as unknown as number[])[0]=99;}).toThrow();
 });
 it('keeps different chart values at the same geometric vertex',()=>{
  const model=box().cornerAttributes({uv:c=>[c.face.index,c.localIndex] as const,chart:c=>`face-${c.face.index}`});
  const vertex=0,locations=model.surface.triangles.flatMap((t,i)=>{
    const corner=t.vertices.indexOf(vertex);return corner<0?[]:[surfaceLocation3(model.surface,i,[0,1,2].map(k=>k===corner?1:0) as unknown as Vec3)];
  });
  expect(new Set(locations.map(p=>JSON.stringify(p.position))).size).toBe(1);
  expect(new Set(locations.map(p=>p.chart)).size).toBe(3);
  expect(new Set(locations.map(p=>JSON.stringify(p.uv))).size).toBeGreaterThan(1);
 });
 it('separates model/world positions, tangent directions and inverse-transpose normals',()=>{
  const model=triangle(),transform={scale:[-2,3,.5] as Vec3,rotate:[90,0,0] as Vec3,translate:[3,4,5] as Vec3};
  const p=surfaceLocation3(model.surface,0,[.25,.25,.5],{placement:{id:'placed',transform},shadingNormal:[1,0,1]});
  expect(p.space).toBe('world');expect(p.placement!.id).toBe('placed');expect(p.modelPosition).toEqual([.5,1.5,0]);close(p.position,[2,4,9.5]);
  close(p.normal,[0,-1,0]);close(p.shadingNormal!,unit3([-.5,-2,0]));
  close(p.frame!.du,[-4,0,0]);close(p.frame!.dv,[0,0,9]);expect(p.frame!.orientation).toBe(-1);
  expect(dot3(p.frame!.du,p.normal)).toBeCloseTo(0,14);expect(dot3(p.frame!.dv,p.normal)).toBeCloseTo(0,14);
  const placed=model.scale(transform.scale).rotate(transform.rotate).translate(transform.translate).surface;
  const t=placed.triangles[0],v=t.vertices.map(i=>placed.points[i].position);
  close(p.normal,unit3(cross3(sub3(v[1],v[0]),sub3(v[2],v[0]))));
 });
 it('captures placement revisions by owned input identity, never just a shared label',()=>{
  const model=triangle(),place={id:'same-label',transform:{translate:[1,0,0] as Vec3}};
  const a=surfaceLocation3(model.surface,0,[1,0,0],{placement:place});
  const b=surfaceLocation3(model.surface,0,[0,1,0],{placement:place});
  expect(a.placement).toBe(b.placement);
  expect(surfaceLocation3(model.surface,0,[1,0,0],{placement:structuredClone(place)}).placement).not.toBe(a.placement);
  const rebound=rebindSurfaceLocation3(a,model.translate([0,0,1]).surface);
  expect(rebound.placement).toBe(a.placement);expect(rebound.position).toEqual([1,0,1]);
  place.transform.translate=[4,0,0];
  const changed=surfaceLocation3(model.surface,0,[1,0,0],{placement:place});
  expect(changed.placement).not.toBe(a.placement);expect(changed.position).toEqual([4,0,0]);expect(a.position).toEqual([1,0,0]);
 });
 it('preserves mirror winding when the scale determinant would underflow',()=>{
  const model=triangle(),scale:Vec3=[-1e-120,1e-120,1e-120];
  const p=surfaceLocation3(model.surface,0,[.25,.25,.5],{placement:{id:'tiny mirror',transform:{scale}}});
  const placed=model.scale(scale).surface,t=placed.triangles[0],v=t.vertices.map(i=>placed.points[i].position);
  expect(t.vertices).toEqual([0,2,1]);expect(p.frame!.orientation).toBe(-1);
  expect(p.normal).toEqual([0,0,1]);close(p.normal,unit3(cross3(sub3(v[1],v[0]),sub3(v[2],v[0]))));
 });
 it('rebinds only through retained authoring topology, including mirrored winding',()=>{
  const model=triangle(),p=surfaceLocation3(model.surface,0,[.25,.25,.5],{shadingNormal:[0,0,1]});
  const changed=model.displace(p=>[0,0,p.x]).scale([-2,3,1]);
  expect(sameAttachmentTopology3(model.surface,changed.surface)).toBe(true);
  const next=rebindSurfaceLocation3(p,changed.surface);
  expect(next.position).toEqual([-1,4.5,.5]);expect(p.position).toEqual([.5,1.5,0]);
  expect(next.uv).toEqual(p.uv);expect(next.vertexIds).toEqual([...p.vertexIds].map((_,i)=>p.vertexIds[[0,2,1][i]]));
  expect(next.shadingNormal).toBeUndefined();
  expect(()=>rebindSurfaceLocation3(p,triangle().surface)).toThrow('authoring lineage');
  expect(()=>rebindSurfaceLocation3(p,model.subdivide().surface)).toThrow('regenerate');
  expect(()=>rebindSurfaceLocation3({...p},changed.surface)).toThrow('owned surface location');
 });
 it('reports missing and degenerate charts and rejects incomplete or mixed chart data',()=>{
  const plain=mesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],[[0,1,2,3]]);expect(surfaceLocation3(plain.surface,0,[1,0,0]).chartStatus).toBe('missing');
  const flat=plain.cornerAttributes({uv:[0,0] as const});
  const p=surfaceLocation3(flat.surface,0,[.2,.3,.5]);expect(p.chartStatus).toBe('degenerate');expect(p.frame).toBeUndefined();expect(p.uv).toEqual([0,0]);
  expect(()=>surfaceLocation3(plain.cornerAttributes({uv:[0,0,0]}).surface,0,[1,0,0])).toThrow('finite pair');
  expect(()=>surfaceLocation3(plain.cornerAttributes({chart:c=>c.localIndex}).surface,0,[1,0,0])).toThrow('chart identities');
  expect(()=>surfaceLocation3(plain.surface,0,[-.1,.5,.6])).toThrow('barycentric');
  expect(()=>surfaceLocation3(plain.surface,99,[1,0,0])).toThrow('valid source triangle');
 });
 it('retains small chart/world data without scene-relative snapping',()=>{
  const source=triangle().scale(1e-100),p=surfaceLocation3(source.surface,0,[.25,.25,.5]);
  expect(p.position).toEqual([.5e-100,1.5e-100,0]);expect(p.modelNormal).toEqual([0,0,1]);
  expect(p.uv).toEqual([.25,.5]);expect(p.frame!.du).toEqual([2e-100,0,0]);
 });
});

// Public sampling keeps attachment schemas separate from editable point state.
describe('surface sample rebinding',()=>{
 it('retains typed corner/source fields through point edits and refreshes them explicitly',()=>{
  const rest=triangle();
  const samples=sampleSurfacePoints(rest,{count:8},{rnd:()=>.25});
  const before=samples.points.at(0)!;
  expectTypeOf(before.sample.cornerAttributes.uv).toEqualTypeOf<readonly [number,number]>();
  expectTypeOf(before.sample.pointAttributes.heat).toEqualTypeOf<number>();
  const edited=samples.attribute('heat','captured').translate([0,0,10]);
  expectTypeOf(edited.points.at(0)!.heat).toEqualTypeOf<'captured'>();
  expectTypeOf(edited.points.at(0)!.sample.pointAttributes.heat).toEqualTypeOf<number>();
  expect(edited.points.at(0)!.sample).toBe(before.sample);
  const bent=rest.displace(p=>[0,0,p.x+2*p.y]).attributes({heat:'new source'}).cornerAttributes({extra:7});
  const rebound=edited.rebind(bent),row=rebound.points.at(0)!;
  expectTypeOf(row.sample.cornerAttributes.extra).toEqualTypeOf<7>();
  expectTypeOf(row.sample.pointAttributes.heat).toEqualTypeOf<'new source'>();
  expectTypeOf(row.heat).toEqualTypeOf<'captured'>();
  expect(row.heat).toBe('captured');expect(row.sample.pointAttributes.heat).toBe('new source');
  expect(row.z).toBeCloseTo(row.x+2*row.y,14);expect(row.sample.position).toEqual([row.x,row.y,row.z]);
  expect(row.sample.source).toBe(bent.surface);expect(row.sample.cornerAttributes.uv).toEqual(before.sample.cornerAttributes.uv);
  expect(rebound.points.map(p=>p.id)).toEqual(samples.points.map(p=>p.id));
  expect(rebound.generation).toEqual(samples.generation);expect(rebound.history).toEqual([]);expect(rebound.iteration).toBe(0);
  const selected=edited.points.filter(p=>p.index<2).extract().rebind(bent);expect(selected.points.length).toBe(2);
  expect(()=>samples.rebind(rest.subdivide())).toThrow('regenerate');
  expect(()=>sampleSurfacePoints(rest,{count:0},{rnd:()=>.5}).rebind(triangle())).toThrow('authoring lineage');
 });
 it('selects custom coordinate columns and refuses nearest-only chart coordinates',()=>{
  const rest=plane(2).cornerAttributes({tex:c=>[c.point.x/2+.5,c.point.y/2+.5] as const,island:'custom'});
  const samples=sampleSurfacePoints(rest,{count:1,uvAttribute:'tex',chartAttribute:'island'},{rnd:()=>.25});
  const p=samples.points.at(0)!;expect(p.sample.chart).toBe('custom');expect(p.sample.uv).toEqual(p.sample.cornerAttributes.tex);
  expect(p.sample.frame).toBeDefined();expect(samples.rebind(rest.translate([0,0,1])).points.at(0)!.sample.uv).toEqual(p.sample.uv);
  const discrete=triangle().cornerAttribute('uv',c=>c.uv,{transfer:'nearest'});
  expect(()=>sampleSurfacePoints(discrete,{count:1},{rnd:()=>.25})).toThrow('interpolated corner values');
 });
 it('exposes the richer context through the bound toolkit',()=>{
  let seen=false;
  compileSketch(sketch({seed:42},t=>{
    const rest=triangle(),samples=t.sample(rest,{count:4});
    expectTypeOf(samples.points.at(0)!.sample.cornerAttributes.uv).toEqualTypeOf<readonly [number,number]>();
    const scattered=t.scatter(rest,{spacing:.5,maxPoints:4,maxAttempts:10});
    expectTypeOf(scattered.points.at(0)!.sample.pointAttributes.heat).toEqualTypeOf<number>();
    expect(samples.points.every(p=>p.sample.chart==='island')).toBe(true);seen=true;return [];
  }));
  expect(seen).toBe(true);
 });
});

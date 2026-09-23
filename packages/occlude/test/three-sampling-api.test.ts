import {beforeAll,describe,it,expect,expectTypeOf} from 'vitest';
import {readFileSync} from 'node:fs';
import {plane,mesh,box,pointCloud,instanceOnPoints,query,view,orthographic,perspective} from 'occlude/3d';
import {sampleSurfacePoints,scatterSurfacePoints} from 'occlude/3d/advanced';
import {Rng} from '../src/random.js';
import {initOcclude,sketch,sketchAsync,compileSketchAsync,commitCamera3,exportSvg,pen,mm} from '../src/index.js';
import type {SurfaceSamples} from 'occlude/3d';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const env=(seed:number|string=42)=>{const rng=new Rng(seed);return {rnd:()=>rng.float()};};
describe('surface samples and scatter',()=>{
 it('selects by area times captured face weight, with an independent quantile oracle',()=>{
  const target=mesh([[0,0,0],[2,0,0],[0,1,0],[10,0,0],[16,0,0],[10,1,0]],[[0,1,2],[3,4,5]]).faceAttribute('region',f=>f.index);
  let draws=0,weights=0;
  const sites=sampleSurfacePoints(target,{count:700,weight:f=>{weights++;return f.region?2:1;}},{rnd:()=>{const i=draws++;return i%3===0?(Math.floor(i/3)+.5)/700:i%3===1?.25:.5;}});
  expect(weights).toBe(2);expect(draws).toBe(2100);
  expect(sites.points.filter(p=>p.sample.face.region===0).length).toBe(100);expect(sites.points.filter(p=>p.region===1).length).toBe(600);
  expect(sites.points.at(0)).toMatchObject({x:.5,y:.25,z:0});expect(sites.points.at(-1)).toMatchObject({x:11.5,y:.25,z:0});
  expect(sites.target).toBe(target);expect(sites.points.at(0)!.sample.source).toBe(target.surface);expect(sites.points.at(0)).toBe(sites.points.at(0));expect('faces' in sites).toBe(false);
  expect(sites.generation).toEqual({attempts:700,accepted:700,reason:'count'});
 });
 it('samples triangle interiors uniformly and interpolates numeric columns without averaging labels',()=>{
  const target=mesh([[0,0,0],[2,0,0],[0,3,0]],[[0,1,2]])
    .attribute('height',p=>2*p.x+3*p.y).attribute('vector',p=>[p.x,p.y])
    .attribute('label',p=>p.index,{transfer:'nearest'}).attribute('name',p=>'point-'+p.index)
    .faceAttribute('region','terrain').faceAttribute('height',99);
  const sites=sampleSurfacePoints(target,{count:6000},env());
  expectTypeOf(sites.points.at(0)!.height).toEqualTypeOf<number>();expectTypeOf(sites.points.at(0)!.sample.face.region).toEqualTypeOf<'terrain'>();
  let x=0,y=0;
  for(const p of sites.points){
    expect(p.x).toBeGreaterThanOrEqual(0);expect(p.y).toBeGreaterThanOrEqual(0);expect(p.x/2+p.y/3).toBeLessThanOrEqual(1+1e-15);
    expect(p.height).toBeCloseTo(2*p.x+3*p.y,12);expect(p.vector[0]).toBeCloseTo(p.x,12);expect(p.vector[1]).toBeCloseTo(p.y,12);
    const nearest=p.sample.barycentric.indexOf(Math.max(...p.sample.barycentric));expect(p.label).toBe(nearest);expect(p.name).toBe('point-'+nearest);
    expect(p.sample.normal).toEqual([0,0,1]);expect(p.sample.position).toEqual([p.x,p.y,p.z]);expect(p.sample.vertices).toEqual([0,1,2]);x+=p.x;y+=p.y;
  }
  expect(Math.abs(x/sites.points.length-2/3)).toBeLessThan(.02);expect(Math.abs(y/sites.points.length-1)).toBeLessThan(.025);
 });
 it('preserves sample ownership and typed provenance through fields, edits, extraction and instances',()=>{
  const target=plane(2).faceAttribute('roof',true),samples=sampleSurfacePoints(target,{count:12},env());
  const edited=samples.attribute('up',p=>p.sample.normal).attribute('tag',p=>p.sample.face.roof).translate([0,0,2]).displace(p=>[0,0,p.tag?1:0]);
  expect(edited.points.at(0)!.sample).toBe(samples.points.at(0)!.sample);expect(edited.points.at(0)!.z).toBe(3);expect(edited.points.at(0)!.sample.position[2]).toBe(0);
  const selected=edited.points.filter(p=>p.index%2===0).extract();expect(selected.points.length).toBe(6);expect(selected.points.at(1)!.id).toBe(samples.points.at(2)!.id);expect(selected.points.at(1)!.sample).toBe(samples.points.at(2)!.sample);
  expect(selected.generation).toEqual(samples.generation);expect(selected.withKey('selected').key).toBe('selected');
  expect(()=>edited.attribute('sample',1)).toThrow('reserved');expect(()=>{(edited.points.at(0)!.sample.position as unknown as number[])[0]=99;}).toThrow();
  const placed=instanceOnPoints(box(.1),selected.points,{offset:p=>p.sample.normal});expectTypeOf(placed.instances.at(0)!.source.sample.face.roof).toEqualTypeOf<true>();expect(placed.instances.at(1)!.source).toBe(selected.points.at(1));
  expect(samples.points.at(0)!.sample.face.attributes.roof).toBe(true);
 });
 it('retains rich sample rows through synchronous and async query batches',async()=>{
  const target=plane(2).faceAttribute('roof',true),sites=sampleSurfacePoints(target,{count:4},env()).translate([0,0,2]);
  const batch=query(target).batch();
  for(const results of [batch.nearest(sites.points),batch.rays(sites.points,{direction:p=>p.sample.normal.map(n=>-n) as [number,number,number]}),batch.segments(sites.points,{to:p=>p.sample.position})]){
    expect(results[0].source).toBe(sites.points.at(0));expectTypeOf(results[0].source.sample.face.roof).toEqualTypeOf<true>();expect(results[0].hit!.distance).toBeCloseTo(2,12);
  }
  await compileSketchAsync(sketchAsync({seed:42},async t=>{
    const samples=t.sample(target,{count:3}).translate([0,0,1]),batch=query(target).batch(t);
    for(const rows of [await batch.nearest(samples.points),await batch.rays(samples.points,{direction:p=>[0,0,-p.sample.normal[2]]}),await batch.segments(samples.points,{to:p=>p.sample.position})]){
      expectTypeOf(rows[0].source.sample.face.roof).toEqualTypeOf<true>();expect(rows[0].source).toBe(samples.points.at(0));expect(rows[0].hit!.distance).toBeCloseTo(1,12);
    }
    return [];
  }));
 });
 it('scatters with independently checked Euclidean spacing across nearby disconnected surfaces',()=>{
  const target=mesh([[0,0,0],[2,0,0],[2,2,0],[0,2,0],[0,0,.02],[2,0,.02],[2,2,.02],[0,2,.02]],[[0,1,2,3],[4,5,6,7]]);
  const sites=scatterSurfacePoints(target,{spacing:.3,maxAttempts:3000,maxPoints:100},env());expect(sites.points.length).toBeGreaterThan(20);expect(sites.generation.reason).toBe('attempt-limit');
  const rows=sites.points.map(p=>p);for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)expect(Math.hypot(rows[i].x-rows[j].x,rows[i].y-rows[j].y,rows[i].z-rows[j].z)).toBeGreaterThanOrEqual(.3);
  expect(new Set(rows.map(p=>p.z)).size).toBe(2);
  const repeated=scatterSurfacePoints(target,{spacing:.3,maxAttempts:3000,maxPoints:100},env());expect(repeated.surface).toEqual(sites.surface);
  const short=scatterSurfacePoints(target,{spacing:.3,maxPoints:10,maxAttempts:3000},env());expect(short.generation.reason).toBe('point-limit');expect(short.points.map(p=>p.id)).toEqual(rows.slice(0,10).map(p=>p.id));
 });
 it('bounds work, handles empty domains, cancellation and invalid random sources explicitly',()=>{
  const target=plane(),fail={rnd:()=>{throw Error('random must not run');}};
  expect(sampleSurfacePoints(target,{count:0},fail).points.length).toBe(0);
  expect(()=>sampleSurfacePoints(target,{count:10,maxPoints:9,weight:()=>{throw Error('field must not run');}},fail)).toThrow('budget');
  // A face the weight field rejects is never sampled; no weighted area at all
  // is no samples, not a failed sketch.
  expect(sampleSurfacePoints(target,{count:1,weight:-1},fail).points.length).toBe(0);
  expect(sampleSurfacePoints(target,{count:1,weight:0},fail).generation.reason).toBe('empty');
  expect(scatterSurfacePoints(target,{spacing:1,weight:0},fail).generation).toEqual({attempts:0,accepted:0,reason:'empty'});
  expect(scatterSurfacePoints(target,{spacing:1,maxAttempts:0},fail).generation.reason).toBe('attempt-limit');
  expect(()=>scatterSurfacePoints(target,{spacing:mm(1) as any},fail)).toThrow('world units');
  expect(()=>sampleSurfacePoints(target,{count:1},{rnd:()=>1})).toThrow('[0,1)');
  const controller=new AbortController();controller.abort();expect(()=>sampleSurfacePoints(target,{count:1},{...fail,signal:controller.signal})).toThrow();
  expect(()=>sampleSurfacePoints(pointCloud([]) as any,{count:1},fail)).toThrow('mesh');
 });
 it('binds mesh sampling to the sketch seed without changing model draws on camera commit',async()=>{
  let models=0,sites:SurfaceSamples<any,any>|undefined;
  const definition=sketch({seed:42,pens:{ink:pen({width:mm(.3)})}},t=>{
    models++;const terrain=plane(3).subdivide(2).faceAttribute('height',f=>f.centroid[0]);
    const a=t.sample(terrain,{count:10}),b=t.sample(terrain,{count:10});expect(a.surface).toEqual(b.surface);
    const generated=t.scatter(terrain,{spacing:.6,maxAttempts:300,maxPoints:12});sites=generated;
    return view([terrain,instanceOnPoints(box(.2),generated.points)],{camera:orthographic({eye:[5,7,6],span:5})});
  });
  const result=await compileSketchAsync(definition),source=sites!.surface,before=exportSvg(result),id=[...result.scenes3.keys()][0];
  const changed=await commitCamera3(result,id,perspective({eye:[5,7,6]}));expect(models).toBe(1);expect(sites!.surface).toBe(source);expect(exportSvg(result)).toBe(before);expect(exportSvg(changed)).not.toBe(before);
  await compileSketchAsync(definition);expect(models).toBe(2);expect(sites!.surface).toEqual(source);
 });
});

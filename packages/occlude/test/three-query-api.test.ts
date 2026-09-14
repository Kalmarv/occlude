import {describe,it,expect,beforeAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {plane,box,sphere,pointCloud,query,force,view,orthographic} from 'occlude/3d';
import type {QueryHost} from '../src/three/api/query.js';
import {prepareSurfaceQueries3} from '../src/three/queries/surface.js';
import {initOcclude,sketchAsync,compileSketchAsync,pen,mm,commitCamera3} from '../src/index.js';
import {perspective} from 'occlude/3d';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
describe('prepared surface query facade',()=>{
 it('distinguishes world distance from ray and segment parameters, with owned typed face data',()=>{
  const mesh=plane(4).faceAttribute('kind','floor'),q=query(mesh);
  const nearest=q.nearest([.25,.25,3])!;expect(nearest.distance).toBe(3);expect(nearest.position).toEqual([.25,.25,0]);expect(nearest.face.kind).toBe('floor');expect('t' in nearest).toBe(false);
  const ray=q.ray([.25,.25,3],[0,0,-2])!;expect(ray.t).toBe(1.5);expect(ray.distance).toBe(3);
  const segment=q.segment([.25,.25,3],[.25,.25,-1])!;expect(segment.t).toBe(.75);expect(segment.distance).toBe(3);
  expect(q.ray([0,0,3],[0,0,-2],{far:1})).toBeNull();expect(q.nearest([0,0,3],{within:2})).toBeNull();
  expect(Object.isFrozen(ray.position)).toBe(true);expect(Object.isFrozen(ray.face.attributes)).toBe(true);
 });
 it('preserves each source row including misses and empty selections',()=>{
  const q=query(plane(2)),points=pointCloud([[0,0,2],[4,0,2],[.4,0,2]]).attribute('tag',p=>p.index);
  const selected=points.points.filter(p=>p.index!==2),hits=q.batch().rays(selected,{direction:[0,0,-2]});
  expect(hits).toHaveLength(2);expect(hits[0].source).toBe(points.points.at(0));expect(hits[1].source).toBe(points.points.at(1));expect(hits[0].hit!.t).toBe(1);expect(hits[1].hit).toBeNull();expect(hits[1].source.tag).toBe(1);
  expect(q.batch().nearest(points.points.filter(()=>false))).toEqual([]);expect(Object.isFrozen(hits)).toBe(true);expect(Object.isFrozen(hits[1])).toBe(true);
  expect(()=>q.batch().nearest(plane().faces as any)).toThrow('point collection');
 });
 it('treats zero-length segments as contact queries and returns identity for contact misses',()=>{
  const q=query(plane(2)),points=pointCloud([[0,0,0],[0,0,1],[.25,.25,2]]);
  expect(q.segment([0,0,0],[0,0,0])).toMatchObject({distance:0,t:0});expect(q.segment([0,0,1],[0,0,1])).toBeNull();
  const hits=q.batch().segments(points.points,{to:p=>p.index===2?[p.x,p.y,-2]:p});
  expect(hits.map(r=>r.hit?.t??null)).toEqual([0,null,.5]);expect(hits[1].source).toBe(points.points.at(1));
 });
 it('reuses only owned target revisions and does not follow later geometry edits',()=>{
  const target=box(),a=prepareSurfaceQueries3(target.surface),b=prepareSurfaceQueries3(target.surface);expect(a).toBe(b);
  const moved=target.translate([0,0,3]);expect(prepareSurfaceQueries3(moved.surface)).not.toBe(a);expect(query(target).nearest([0,0,2])!.distance).toBe(1.5);expect(query(moved).nearest([0,0,2])!.distance).toBe(.5);
  const raw=structuredClone(target.surface),first=prepareSurfaceQueries3(raw);raw.points.forEach(p=>p.position=[p.position[0],p.position[1],p.position[2]+4]);expect(prepareSurfaceQueries3(raw)).not.toBe(first);expect(first.nearest([{point:[0,0,2]}])[0]!.distance).toBe(1.5);
 });
 it('captures batch fields before awaiting and rejects result-count mismatches',async()=>{
  const q=query(plane(2)),points=pointCloud([[0,0,1],[3,0,1]]);let release!:()=>void,calls=0;const direction:[number,number,number]=[0,0,-2];
  const host:QueryHost={async querySurface3(surface,input){await new Promise<void>(r=>release=r);const prepared=prepareSurfaceQueries3(surface);return {rays:prepared.rays(input.rays??[]),segments:prepared.segments(input.segments??[]),nearest:prepared.nearest(input.nearest??[])};}};
  const pending=q.batch(host).rays(points.points,{direction:()=>{calls++;return direction;}});expect(calls).toBe(2);direction[2]=2;release();const out=await pending;expect(out[0].hit!.distance).toBe(1);expect(out[1].hit).toBeNull();expect(calls).toBe(2);
  const broken:QueryHost={async querySurface3(){return {rays:[],segments:[],nearest:[]};}};await expect(q.batch(broken).nearest(points.points)).rejects.toThrow('result count');
 });
 it('uses the execution async boundary and never reruns query/model work during camera commit',async()=>{
  let models=0,batches=0;let escaped:ReturnType<ReturnType<typeof query>['batch']>|undefined;
  const definition=sketchAsync({seed:42,pens:{ink:pen({width:mm(.25)})}},async t=>{
    models++;const surface=plane(2).subdivide(2).translate([0,0,1]),q=query(plane(4));const batch=q.batch(t);escaped=batch;
    const hits=await batch.rays(surface.points,{direction:[0,0,-2]});batches++;expect(hits.every(r=>r.hit?.distance===1&&r.hit.t===.5)).toBe(true);
    const segments=await batch.segments(surface.points,{to:p=>[p.x,p.y,0]});batches++;expect(segments.every(r=>r.hit?.t===1)).toBe(true);
    return view(surface,{camera:orthographic({eye:[5,7,6],span:5})});
  });
  const original=await compileSketchAsync(definition);expect(original.modeling3).toHaveLength(2);
  await commitCamera3(original,[...original.scenes3.keys()][0],perspective({eye:[5,7,6],fovDegrees:40}));expect(models).toBe(1);expect(batches).toBe(2);
  await expect(escaped!.nearest(pointCloud([[0,0,0]]).points)).rejects.toThrow('finished');
 });
});
describe('reusable world-space force fields',()=>{
 it('evaluates on each current frozen pass and preserves history',()=>{
  const pull=force.attract([0,0,1],{strength:.5}),original=plane(2),out=original.steps(3,(current,next)=>next.move(current.points,pull),{every:1});
  expect(out.points.at(0)!.z).toBe(.875);expect(out.points.at(0)!.x).toBe(-.125);expect(out.history.map(s=>s.geometry.points.at(0)!.z)).toEqual([0,.5,.75,.875]);expect(original.points.at(0)!.z).toBe(0);
 });
 it('makes plane sidedness explicit and projects to nearest surface without claiming containment',()=>{
  const below=force.plane({origin:[0,0,1],normal:[0,0,2],side:'below'}),above=force.plane({origin:[0,0,1],normal:[0,0,1],side:'above'});
  expect(below({x:0,y:0,z:2})).toEqual([-0,-0,-1]);expect(below({x:0,y:0,z:0})).toEqual([0,0,0]);expect(above({x:0,y:0,z:0})).toEqual([0,0,1]);
  const project=force.project(query(box(2)));const displacement=project({x:0,y:0,z:0});expect(Math.hypot(...displacement)).toBe(1); // Inside still projects to a surface.
  expect(force.project(query(plane()),{within:.1})({x:0,y:0,z:1})).toEqual([0,0,0]);
  const combined=force.sum(force.attract([1,0,0]),force.attract([0,1,0]));expect(combined({x:0,y:0,z:0})).toEqual([1,1,0]);
 });
 it('supports the same query/deformation workflow on a different mesh source',()=>{
  for(const source of [plane(2).subdivide(2),box(2),sphere(1,{segments:8,rings:4})]){
    const out=source.attribute('gain',.1).steps(2,(current,next)=>next.move(current.points,p=>force.attract([0,0,0],{strength:p.gain})(p)));
    expect(query(out).nearest([0,0,4])).not.toBeNull();expect(source.points.length).toBe(out.points.length);
  }
  expect(()=>force.plane({origin:[0,0,0],normal:[0,0,0],side:'below'})).toThrow();expect(()=>force.plane({origin:[0,0,0],normal:[0,0,1],side:'below',strength:2})).toThrow();
 });
});

import {describe,it,expect} from 'vitest';
import {mesh3,meshOfMade3} from '../src/three/geometry/mesh3.js';
import {mesh,plane,box,sphere,cylinder,cone,torus} from 'occlude/3d';
import {gridSurface as grid3} from './helpers/surfaces.js';
import {surfaceBinding3} from '../src/three/curves/network.js';
import {intersectionContacts3,intersectionContactsAsync3} from '../src/three/curves/intersectionContacts.js';
import {triangulation3} from '../src/three/geometry/triangulation.js';
import {WorldIndex3} from '../src/three/geometry/bounds.js';
import {runGeometryJob3} from '../src/three/geometry/job.js';
const binding=(model:ReturnType<typeof plane>)=>surfaceBinding3(mesh3(model));
describe('intersection spatial preparation',()=>{
 it('validates shared topology and retains neighbor/cache identity through motion',()=>{
  const source=plane(2,2).subdivide(2),topology=triangulation3(mesh3(source));
  expect(topology.componentCount).toBe(1);expect(topology.neighbors).toHaveLength(mesh3(source).triangleCount);
  expect(triangulation3(mesh3(source.displace(p=>[0,0,p.x*p.y])))).toBe(topology);
  const mirrored=triangulation3(mesh3(source.scale([-1,1,1])));expect(mirrored.componentCount).toBe(1);
  for(let i=0;i<topology.neighbors.length;i++)for(const neighbor of topology.neighbors[i])if(neighbor>=0)expect(topology.neighbors[neighbor]).toContain(i);
  for(const model of [box(),sphere(),cylinder(),cone(),torus()])expect(triangulation3(mesh3(model)).neighbors.every(row=>row.every(i=>i>=0))).toBe(true);
 });
 it('rejects broken render triangles rather than silently repairing them',()=>{
  // The one quad of a plane, stated with other fixed triangles (positions
  // round its loop): the same triangle twice, one short, a point off the face.
  const source=mesh3(plane()),t=[...source.localTriangles(0)];
  const stated=(local:number[])=>meshOfMade3({x:source.x,y:source.y,z:source.z,names:{...source.names},loops:source.loops,triangles:[local],edges:source.edges});
  expect(()=>triangulation3(stated([...t.slice(0,3),...t.slice(0,3)]))).toThrow('winding');
  expect(()=>triangulation3(stated(t.slice(0,3)))).toThrow('cover');
  expect(()=>triangulation3(stated([0,1,999,...t.slice(3)]))).toThrow('invalid fixed triangle');
  const two=mesh([[0,0,0],[1,0,0],[0,1,0],[0,0,0],[-1,0,0],[0,-1,0]],[[0,1,2],[3,4,5]]);
  expect(triangulation3(mesh3(two)).componentCount).toBe(2);
 });
 it('uses closed world bounds without welding tiny positive gaps',()=>{
  const index=runGeometryJob3(WorldIndex3.build([[0,0,0,1,1,0],[0,0,Number.MIN_VALUE,1,1,Number.MIN_VALUE]])).value;
  expect([...index.query([0,0,0,1,1,0])]).toEqual([0]);expect([...index.query([1,1,0,1,1,0])]).toEqual([0]);
 });
 it('streams fewer spatial candidates than the complete triangle product and reuses prepared sources',()=>{
  const a=surfaceBinding3(mesh3(mesh(grid3(20,20,[20,20])))),b=surfaceBinding3(mesh3(mesh(grid3(20,20,[20,20]))));
  const result=intersectionContacts3(a,b),product=a.source.triangleCount*b.source.triangleCount;
  expect(result.value.stats.candidates).toBeLessThan(product/20);expect(result.value.stats.areaContacts).toBeGreaterThan(0);expect(result.value.stats.sourceCacheHits).toBe(0);
  const warm=intersectionContacts3(a,b);expect(warm.value.stats.sourceCacheHits).toBe(2);expect(warm.value.contacts).toEqual(result.value.contacts);
  const far=surfaceBinding3(mesh3(mesh(grid3(20,20,[20,20]))),{id:'far',transform:{translate:[100,0,0]}});expect(intersectionContacts3(a,far).value.stats.candidates).toBe(0);
 });
 it('reports segment, point and area contacts with actual triangle provenance',()=>{
  const a=binding(box()),b=binding(box().translate([.3,.4,.2])),result=intersectionContacts3(a,b).value;
  expect(result.stats.segmentContacts).toBeGreaterThan(0);expect(result.stats.areaContacts).toBe(0);
  for(const row of result.contacts){expect(row.a).toBeLessThan(a.source.triangleCount);expect(row.b).toBeLessThan(b.source.triangleCount);}
  expect(intersectionContacts3(binding(box()),binding(box().translate([1,1,1]))).value.stats.pointContacts).toBeGreaterThan(0);
  expect(intersectionContacts3(binding(box()),binding(box().translate([1,0,0]))).value.stats.areaContacts).toBeGreaterThan(0);
 });
 it('checks capacities even when the sources have been cached',()=>{
  const a=binding(plane()),b=binding(plane());intersectionContacts3(a,b);
  for(const options of [{maxInputTriangles:1},{maxInputPoints:1},{maxCandidates:0},{maxContacts:0},{maxContactPoints:0},{maxExactBytes:0},{maxCoordinateBits:0}])expect(()=>intersectionContacts3(a,b,options)).toThrow('budget');
  const collapsed=surfaceBinding3(mesh3(plane()),{id:'collapsed',transform:{translate:[1e16,0,0]}});expect(()=>intersectionContacts3(a,collapsed)).toThrow('degenerate');
 });
 it('yields real tasks, observes cancellation, and agrees with synchronous contacts',async()=>{
  const a=surfaceBinding3(mesh3(mesh(grid3(40,40,[4,4])))),b=surfaceBinding3(mesh3(mesh(grid3(40,40,[4,4])))),controller=new AbortController();
  const pending=intersectionContactsAsync3(a,b,{},controller.signal);setTimeout(()=>controller.abort(new Error('cancel contacts')),0);
  await expect(pending).rejects.toThrow('cancel contacts');
  const x=binding(box()),y=binding(box().translate([.25,.25,.25])),asyncResult=await intersectionContactsAsync3(x,y);
  expect(asyncResult.yields).toBeGreaterThan(0);expect(asyncResult.timings.queueMs).toBeGreaterThan(0);expect(asyncResult.value.contacts).toEqual(intersectionContacts3(x,y).value.contacts);
  const options={maxCandidates:0},captured=intersectionContactsAsync3(x,y,options);options.maxCandidates=10000;await expect(captured).rejects.toThrow('candidate budget');
 });
});

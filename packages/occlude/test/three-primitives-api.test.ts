import {describe,it,expect} from 'vitest';
import {sphere,cylinder,cone,torus} from '../src/three/api/index.js';
import {manifold} from './helpers/surfaces.js';
import {toolkit} from './helpers/run.js';
import {DOMAINS3,kernelColumn,mesh3} from '../src/three/geometry/mesh3.js';
import type {Material} from '../src/material.js';
/** Everything the kernels read of a value — names, positions, faces, fixed
 * triangles, edges and every kernel column — as plain data. */
function kernelRead(m:Material){
 const r=mesh3(m),counts={points:r.n,edges:r.edgeCount,faces:r.faceCount,corners:r.cornerCount};
 const cols=DOMAINS3.map(d=>Object.entries(r.cols[d]).filter(([,c])=>kernelColumn(c)).map(([k])=>[k,Array.from({length:counts[d]},(_,i)=>r.cell(d,k,i))]));
 return {names:r.names,x:r.x,y:r.y,z:r.z,loops:r.loops,triangles:r.triangles,edges:r.edges,cols};
}
describe('common mesh primitive catalog',()=>{
 it('shares poles, rims and periodic seams without degenerate faces',()=>{
  const orb=sphere(2,{segments:12,rings:6});manifold(orb,2);expect(orb.points.length).toBe(62);
  for(const p of orb.points)expect(Math.hypot(p.x,p.y,p.z)).toBeCloseTo(2,13);
  manifold(cylinder(),2);manifold(cone(),2);manifold(torus(),0);
  for(const p of torus(2,.4).points)expect(Math.hypot(Math.hypot(p.x,p.y)-2,p.z)).toBeCloseTo(.4,13);
 });
 it('keeps cap choices explicit with precisely the expected open boundaries',()=>{
  expect(cylinder(1,2,{segments:9,caps:false}).edges.filter(e=>e.faces.length===1)).toHaveLength(18);
  expect(cone(1,2,{segments:9,caps:false}).edges.filter(e=>e.faces.length===1)).toHaveLength(9);
  expect(cylinder(1,2,{segments:9}).faces.filter(f=>f.corners!.length===9).length).toBe(2);
 });
 it('uses ordinary immutable attributes, frozen edits and shape-preserving subdivision',()=>{
  for(const source of [sphere(1,{segments:8,rings:4}),cylinder(1,2,{segments:8}),cone(1,2,{segments:8}),torus(1,.2,{segments:8,tubeSegments:4})]){
    const before=source.points.map(p=>[p.x,p.y,p.z]);
    const refined=toolkit().steps(2,source.points.set('mobility',p=>p.z).faces.set('material','ink').subdivide(),m=>m.displace(p=>[0,0,p.mobility*.1]));
    expect(refined.faces.map(f=>f.material).every(v=>v==='ink')).toBe(true);expect(source.points.map(p=>[p.x,p.y,p.z])).toEqual(before);
    expect(kernelRead(source.scale(1))).toEqual(kernelRead(source));
  }
 });
 it('draws nothing for a degenerate primitive and rejects oversized resolution',()=>{
  // A zero size or too few segments to close a surface is an empty mesh, the
  // same nothing-to-draw a box gives a zero size.
  for(const make of [()=>sphere(0),()=>sphere(1,{rings:1}),()=>cylinder(1,0),()=>cone(-1),()=>torus(0,.2)])expect(make().faces.length).toBe(0);
  // A tube as fat as the centerline folds the ring onto its own axis: no
  // simple polygon can hold that, so it stays an error.
  for(const make of [()=>torus(1,1),()=>sphere(1,{segments:1e9}),()=>torus(1,.2,{segments:1e9})])expect(make).toThrow();
  expect(()=>sphere(1,{rings:1.5})).toThrow('integer');
  manifold(sphere(1,{segments:3,rings:2}),2);manifold(torus(1,.2,{segments:3,tubeSegments:3}),0);
 });
});

describe('degenerate primitives draw nothing instead of failing the sketch',()=>{
 it('a box with a non-positive dimension is an empty mesh',async()=>{
  const {box,view,perspective}=await import('../src/three/api/index.js');
  for(const size of [0,[1,1,0] as const,[1,-2,1] as const]){
   const b=box(size as never);
   expect(b.faces.length).toBe(0);expect(b.points.length).toBe(0);
  }
  const {sketch,paper}=await import('../src/index.js');
  const out=sketch({paper:paper({width:100,height:100}),seed:1},()=>view([box(1),box([1,1,0])],{camera:perspective({eye:[3,3,3],target:[0,0,0],fovDegrees:60})}));
  expect(out).toBeDefined();
 });
});

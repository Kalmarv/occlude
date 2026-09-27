import {describe,it,expect} from 'vitest';
import {plane,box,mesh,pointCloud} from '../src/three/api/mesh.js';
import {toolkit} from './helpers/run.js';
import {mesh3,meshOfMade3} from '../src/three/geometry/mesh3.js';
import {triangulation3} from '../src/three/geometry/triangulation.js';
describe('immutable mesh values and frozen domains',()=>{
 it('shares the mesh contract across plane, box and raw topology',()=>{
  for(const shape of [plane(),box(),mesh([[0,0,0],[1,0,0],[0,1,0]],[[0,1,2]])]){
   const original=shape.points.map(p=>[p.x,p.y,p.z]);
   const edited=shape.subdivide().points.set('mobility',p=>p.x+2).displace(p=>[0,0,p.mobility*.1]);
   expect(edited.points.length).toBeGreaterThan(shape.points.length);expect(shape.points.map(p=>[p.x,p.y,p.z])).toEqual(original);
   expect(edited.points.map(p=>p.mobility).every(v=>typeof v==='number')).toBe(true);
  }
  expect(plane().points.length).toBe(4);expect(plane().edges.length).toBe(4);expect(plane().faces.length).toBe(1);
  expect(plane().faces.at(0)?.normal).toEqual([0,0,1]);
 });
 it('propagates typed attributes, supports replacement, and protects row names',()=>{
  const value=plane().points.set('weight',p=>p.x+1).faces.set('height',()=>1.5).faces.set({label:f=>f.height>1?'high':'low'});
  
  
  expect(value.faces.at(0)?.label).toBe('high');
  expect(value.points.set('grade','heavy').points.at(0)?.grade).toBe('heavy');
  expect(()=>value.faces.set('area',2)).toThrow('reserved');
  // `x` on points is the position; a value that is not finite writes nothing.
  expect(value.points.set('x',2).points.every(p=>p.x===2)).toBe(true);
  expect(()=>{(value.points.at(0) as unknown as {weight:number}).weight=5;}).toThrow();
 });
 it('keeps groups as selections and extracts shared face topology',()=>{
  const b=box().faces.set('axis',f=>Math.abs(f.normal[2]));
  const groups=b.faces.groupBy(f=>f.axis);expect(groups.length).toBe(2);
  expect(groups.map(g=>[g.key,g.length]).sort()).toEqual([[0,4],[1,2]]);
  const side=groups.find(g=>g.key===0)!.extract();expect(side.points.length).toBe(8);expect(side.faces.length).toBe(4);
  expect(side.edges.length).toBe(12);expect(side.faces.map(f=>f.axis)).toEqual([0,0,0,0]);
  const points=b.points.filter(p=>p.z>0).extract();expect(points.points.length).toBe(4);expect(points.faces.length).toBe(0);
  const curves=b.edges.filter(e=>e.a.z>0&&e.b.z>0).extract();expect(curves.edges.length).toBe(4);expect(curves.faces.length).toBe(0);
 });
 it('runs passes that read their input unchanged, and keeps history through a continued run',()=>{
  const t=toolkit();
  const original=plane().points.set('mobility',p=>p.x+1);
  const value=t.steps(3,original,m=>{
   const before=m.points.map(p=>p.z),out=m.displace(p=>[0,0,p.mobility]).displace(p=>[0,0,p.mobility]);
   expect(m.points.map(p=>p.z)).toEqual(before);return out;
  },{every:2});
  expect(value.history.length).toBe(3);expect(value.history[0].points.map(p=>[p.x,p.y,p.z])).toEqual(original.points.map(p=>[p.x,p.y,p.z]));
  expect(value.history.every(s=>s.history.length===0)).toBe(true);
  expect(value.points.map(p=>p.z)).toEqual(original.points.map(p=>p.mobility*6));
  // a selection of an earlier revision is read by id, and lands
  expect(value.points.set('z',p=>p.z+1,original.points).points.map(p=>p.z)).toEqual(value.points.map(p=>p.z+1));
  const continued=t.steps(1,value,m=>m,{every:1});expect(continued.history.length).toBe(2);expect(continued.history[0].points.map(p=>p.z)).toEqual(value.points.map(p=>p.z));expect(continued.history[0].history).toEqual([]);
  expect(original.points.map(p=>p.z)).toEqual([0,0,0,0]);
 });
 it('builds values that own their raw inputs and keep names, columns and fixed triangles',()=>{
  const labelled=box().faces.set('label',f=>f.index===0?'bottom':'side'),read=mesh3(labelled);
  expect(read.names.points[0]).toBe('p0');expect(read.names.faces[0]).toBe('f0');expect(labelled.points.at(0)?.x).toBe(-.5);
  expect(labelled.faces.at(0)?.label).toBe('bottom');
  // Every quad holds its two triangles, fixed when it was built.
  for(let f=0;f<read.faceCount;f++)expect(read.localTriangles(f)).toEqual([3,0,1,1,2,3]);
  const positions:[number,number,number][]=[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],faces=[[0,1,2,3]],quad=mesh(positions,faces);
  positions[0]=[99,99,99];faces[0].reverse();
  expect(quad.points.at(0)?.x).toBe(0);expect(mesh3(quad).loops[0]).toEqual([0,1,2,3]);expect(mesh3(quad).names.points[0]).toBe('p0');
  // Faces whose fixed triangles do not cover them are refused by name.
  const bare=meshOfMade3({x:read.x,y:read.y,z:read.z,names:read.names,loops:read.loops,triangles:read.loops.map(()=>[]),edges:read.edges});
  expect(()=>triangulation3(bare)).toThrow('fixed triangles do not cover');
 });
 it('owns raw inputs, preserves edge transfer and leaves new interior attributes optional',()=>{
  const positions:[number,number,number][]=[[0,0,0],[1,0,0],[0,1,0]],source=mesh(positions,[[0,1,2]]).edges.set('pen',2);
  positions[0][0]=99;expect(source.points.at(0)?.x).toBe(0);
  
  const refined=source.subdivide();expect(refined.edges.filter(e=>e.pen===2).length).toBe(6);
  // An interior edge a subdivision made has the column's default.
  expect(refined.edges.filter(e=>e.pen===0).length).toBe(3);
  expect(pointCloud([[0,0,0]]).points.set('height',2).translate([0,0,3]).points.at(0)?.height).toBe(2);
 });
});

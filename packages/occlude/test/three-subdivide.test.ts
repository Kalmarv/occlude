import {describe,it,expect} from 'vitest';
import {box,mesh} from '../src/three/api/mesh.js';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {dot3} from '../src/three/math.js';
import type {Material,Vertex} from '../src/material.js';
const plane=()=>mesh([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],[[0,1,2,3]]);
const area=(m:Material)=>m.faces.sum('area');
describe('generic shape-preserving subdivision',()=>{
 it('produces a shared 32 by 32 quad mesh and rejects growth before allocating',()=>{
  const original=plane(),refined=original.subdivide(5);
  expect(refined.points.length).toBe(33*33);expect(refined.faces.length).toBe(32*32);
  expect(refined.faces.every(f=>f.corners.length===4)).toBe(true);
  expect(refined.edges.filter(e=>e.faces.length===1)).toHaveLength(128);
  expect(area(refined)).toBeCloseTo(4);expect(original.points.length).toBe(4);
  expect(()=>original.subdivide(30,{maxFaces:1_000_000})).toThrow('exceeds budget');
  // No levels: the same rows, each its own source.
  const same=original.subdivide(0);
  expect(mesh3(same).names).toEqual(mesh3(original).names);
  expect(same.points.every(p=>original.points.has(p.source))).toBe(true);
  expect(same.points.map(p=>(p.source as Vertex).index)).toEqual([0,1,2,3]);
 });
 it('preserves box shape, watertight edges and crease geometry',()=>{
  const refined=box(1).subdivide(2);
  expect(refined.faces).toHaveLength(96);expect(refined.points).toHaveLength(98);
  expect(refined.edges.every(e=>e.faces.length===2)).toBe(true);
  expect(refined.points.every(p=>Math.max(Math.abs(p.x),Math.abs(p.y),Math.abs(p.z!))===.5)).toBe(true);
  expect(area(refined)).toBeCloseTo(6);
  // The twelve box edges, each in four pieces, are the only creases.
  const creases=refined.edges.filter(e=>dot3(e.faces.at(0)!.normal,e.faces.at(1)!.normal)<0.5);
  expect(creases).toHaveLength(48);
 });
 it('refines concave polygons and mixed faces without cracks or missing area',()=>{
  const mixed=mesh([[0,0,0],[2,0,0],[2,2,0],[1,1,0],[0,2,0],[3,0,0],[3,2,0]],[[0,1,2,3,4],[1,5,6,2]]);
  const refined=mixed.subdivide(2);
  expect(area(refined)).toBeCloseTo(area(mixed));
  expect(new Set(refined.points.map(p=>JSON.stringify([p.x,p.y,p.z]))).size).toBe(refined.points.length);
  // Original shared x=2 edge must remain interior along its entire length.
  expect(refined.edges.filter(e=>e.a.x===2&&e.b.x===2).every(e=>e.faces.length===2)).toBe(true);
 });
 it('preserves folded represented triangles and categorical sources',()=>{
  const original=mesh([[-1,-1,0],[1,-1,0],[1,1,1],[-1,1,0]],[[0,1,2,3]])
   .points.set({height:p=>p.x,code:p=>p.index},{transfer:{code:'nearest'}})
   .faces.set('label',()=>'roof').edges.set('marked',()=>true);
  // The quad is folded: it is drawn as its two fixed triangles.
  expect(mesh3(original).localTriangles(0)).toHaveLength(6);
  const refined=original.subdivide(1);
  expect(area(refined)).toBeCloseTo(area(original));
  expect(refined.faces).toHaveLength(8);
  expect(refined.faces.every(f=>f.label==='roof'&&original.faces.has(f.source))).toBe(true);
  expect(refined.points.every(p=>p.height===p.x&&Number.isInteger(p.code))).toBe(true);
  expect(refined.edges.filter(e=>e.faces.length===1).every(e=>e.marked===true&&original.edges.has(e.source))).toBe(true);
  // The same program makes the same mesh.
  const again=original.subdivide(1);
  expect(mesh3(again).names).toEqual(mesh3(refined).names);
  expect(again.points.map(p=>[p.x,p.y,p.z,p.height,p.code])).toEqual(refined.points.map(p=>[p.x,p.y,p.z,p.height,p.code]));
 });
});

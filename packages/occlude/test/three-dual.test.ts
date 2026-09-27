import {describe,it,expect} from 'vitest';
import {box,plane,pointCloud,geodesic} from '../src/three/api/index.js';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {volume} from './helpers/surfaces.js';
import type {Material} from '../src/material.js';

function closed(s:Material,chi:number){
  expect(s.edges.every(e=>e.faces.length===2)).toBe(true);
  expect(s.points.length-s.edges.length+s.faces.length).toBe(chi);
  expect(volume(s)).toBeGreaterThan(0);
}

describe('the dual of a mesh',()=>{
 it('turns a cube into an octahedron and back',()=>{
  const cube=box(2);
  const octahedron=cube.dual();
  expect(octahedron.points.length).toBe(6);
  expect(octahedron.faces.length).toBe(8);
  expect(octahedron.faces.every(f=>f.corners.length===3)).toBe(true);
  closed(octahedron,2);
  for(const p of octahedron.points)expect(Math.hypot(p.x,p.y,p.z)).toBeCloseTo(1,12);
  const again=octahedron.dual();
  expect(again.points.length).toBe(8);
  expect(again.faces.length).toBe(6);
  expect(again.faces.every(f=>f.corners.length===4)).toBe(true);
  closed(again,2);
 });
 it('reads a Goldberg polyhedron off the geodesic',()=>{
  const dome=geodesic(1,{frequency:3});
  const goldberg=dome.dual({project:1});
  expect(goldberg.points.length).toBe(dome.faces.length);
  expect(goldberg.faces.length).toBe(dome.points.length);
  expect(goldberg.faces.filter(f=>f.corners.length===5).length).toBe(12);
  expect(goldberg.faces.every(f=>f.corners.length===5||f.corners.length===6)).toBe(true);
  closed(goldberg,2);
  for(const p of goldberg.points)expect(Math.hypot(p.x,p.y,p.z)).toBeCloseTo(1,12);
  // Class III duals the same way: a chiral Goldberg.
  const chiral=geodesic(1,{frequency:[2,1]}).dual({project:1});
  expect(chiral.faces.filter(f=>f.corners.length===5).length).toBe(12);
  closed(chiral,2);
 });
 it('carries columns across and names them for their source',()=>{
  const dome=geodesic(1,{frequency:2}).points.set('height',p=>p.z).faces.set('tilt',f=>f.normal[2]);
  const goldberg=dome.dual({project:1});
  expect(goldberg.points.every(p=>typeof p.tilt==='number')).toBe(true);
  expect(goldberg.faces.every(f=>typeof f.height==='number')).toBe(true);
  expect(mesh3(goldberg).names.points.every(name=>name.startsWith('dual:'))).toBe(true);
  expect(mesh3(goldberg).names.faces.every(name=>name.startsWith('dual:'))).toBe(true);
  // A point answers the face it stands for, a face the point it walks round.
  expect(goldberg.points.every(p=>dome.faces.has(p.source))).toBe(true);
  expect(goldberg.faces.every(f=>dome.points.has(f.source))).toBe(true);
 });
 it('drops a rim it cannot walk around and draws nothing without faces',()=>{
  expect(plane(2).dual().faces.length).toBe(0);
  expect(plane(2).subdivide(2).dual().faces.length).toBeGreaterThan(0);
  expect(pointCloud([[0,0,0],[1,0,0]]).faces.length).toBe(0);
  expect(box(1).dual({project:0}).faces.length).toBe(0);
  expect(()=>box(1).dual([] as never)).toThrow('object');
 });
 it('is the same mesh every time it is built',()=>{
  const a=geodesic(1,{frequency:2}).dual({project:1}),b=geodesic(1,{frequency:2}).dual({project:1});
  expect(a.points.map(p=>[p.x,p.y,p.z])).toEqual(b.points.map(p=>[p.x,p.y,p.z]));
  expect(a.faces.map(f=>f.corners.map(c=>c.point.index))).toEqual(b.faces.map(f=>f.corners.map(c=>c.point.index)));
 });
});

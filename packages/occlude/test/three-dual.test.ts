import {describe,it,expect} from 'vitest';
import {box,plane,pointCloud,geodesic,type Mesh} from '../src/three/api/index.js';
import {cross3,dot3,sub3} from '../src/three/math.js';

function closed(s:Mesh<any,any,any,any>,chi:number){
  expect(s.surface.edges.every(e=>e.faces.length===2)).toBe(true);
  expect(s.points.length-s.edges.length+s.faces.length).toBe(chi);
  let volume=0;for(const t of s.surface.triangles){const [a,b,c]=t.vertices.map(i=>s.surface.points[i].position);volume+=dot3(a,cross3(b,c))/6;}
  expect(volume).toBeGreaterThan(0);
}

describe('the dual of a mesh',()=>{
 it('turns a cube into an octahedron and back',()=>{
  const cube=box(2);
  const octahedron=cube.dual();
  expect(octahedron.points.length).toBe(6);
  expect(octahedron.faces.length).toBe(8);
  expect(octahedron.faces.every(f=>f.vertices.length===3)).toBe(true);
  closed(octahedron,2);
  for(const p of octahedron.points)expect(Math.hypot(p.x,p.y,p.z)).toBeCloseTo(1,12);
  const again=octahedron.dual();
  expect(again.points.length).toBe(8);
  expect(again.faces.length).toBe(6);
  expect(again.faces.every(f=>f.vertices.length===4)).toBe(true);
  closed(again,2);
 });
 it('reads a Goldberg polyhedron off the geodesic',()=>{
  const dome=geodesic(1,{frequency:3});
  const goldberg=dome.dual({project:1});
  expect(goldberg.points.length).toBe(dome.faces.length);
  expect(goldberg.faces.length).toBe(dome.points.length);
  expect(goldberg.faces.filter(f=>f.vertices.length===5).length).toBe(12);
  expect(goldberg.faces.every(f=>f.vertices.length===5||f.vertices.length===6)).toBe(true);
  closed(goldberg,2);
  for(const p of goldberg.points)expect(Math.hypot(p.x,p.y,p.z)).toBeCloseTo(1,12);
  // Class III duals the same way: a chiral Goldberg.
  const chiral=geodesic(1,{frequency:[2,1]}).dual({project:1});
  expect(chiral.faces.filter(f=>f.vertices.length===5).length).toBe(12);
  closed(chiral,2);
 });
 it('carries columns across and names them for their source',()=>{
  const dome=geodesic(1,{frequency:2}).attribute('height',p=>p.z).faceAttribute('tilt',f=>f.normal[2]);
  const goldberg=dome.dual({project:1});
  expect(goldberg.points.every(p=>typeof p.tilt==='number')).toBe(true);
  expect(goldberg.faces.every(f=>typeof f.height==='number')).toBe(true);
  expect(goldberg.surface.points[0].id.startsWith('dual:')).toBe(true);
  expect(goldberg.surface.faces[0].id.startsWith('dual:')).toBe(true);
 });
 it('drops a rim it cannot walk around and draws nothing without faces',()=>{
  expect(plane(2).dual().surface.faces.length).toBe(0);
  expect(plane(2).subdivide(2).dual().faces.length).toBeGreaterThan(0);
  expect(pointCloud([[0,0,0],[1,0,0]]).surface.faces.length).toBe(0);
  expect(box(1).dual({project:0}).surface.faces.length).toBe(0);
  expect(()=>box(1).dual([] as never)).toThrow('object');
 });
 it('is the same mesh every time it is built',()=>{
  const a=geodesic(1,{frequency:2}).dual({project:1}),b=geodesic(1,{frequency:2}).dual({project:1});
  expect(a.points.map(p=>[p.x,p.y,p.z])).toEqual(b.points.map(p=>[p.x,p.y,p.z]));
  expect(a.faces.map(f=>f.vertices)).toEqual(b.faces.map(f=>f.vertices));
 });
});

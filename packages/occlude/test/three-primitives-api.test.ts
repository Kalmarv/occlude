import {describe,it,expect} from 'vitest';
import {sphere,cylinder,cone,torus,type Mesh} from '../src/three/api/index.js';
import {cross3,dot3,sub3} from '../src/three/math.js';
function manifold(s:Mesh,chi:number){
  expect(s.surface.edges.every(e=>e.faces.length===2)).toBe(true);
  expect(s.points.length-s.edges.length+s.faces.length).toBe(chi);
  const directions=new Map<string,number>();
  for(const f of s.surface.faces)for(let i=0;i<f.vertices.length;i++){const a=f.vertices[i],b=f.vertices[(i+1)%f.vertices.length],key=[Math.min(a,b),Math.max(a,b)].join(':');directions.set(key,(directions.get(key)??0)+(a<b?1:-1));}
  expect([...directions.values()].every(n=>n===0)).toBe(true);
  let volume=0;for(const t of s.surface.triangles){const [a,b,c]=t.vertices.map(i=>s.surface.points[i].position);expect(Math.hypot(...cross3(sub3(b,a),sub3(c,a)))).toBeGreaterThan(0);volume+=dot3(a,cross3(b,c))/6;}
  expect(volume).toBeGreaterThan(0);
}
describe('common mesh primitive catalog',()=>{
 it('shares poles, rims and periodic seams without degenerate faces',()=>{
  const orb=sphere(2,{segments:12,rings:6});manifold(orb,2);expect(orb.points.length).toBe(62);
  for(const p of orb.points)expect(Math.hypot(p.x,p.y,p.z)).toBeCloseTo(2,13);
  manifold(cylinder(),2);manifold(cone(),2);manifold(torus(),0);
  for(const p of torus(2,.4).points)expect(Math.hypot(Math.hypot(p.x,p.y)-2,p.z)).toBeCloseTo(.4,13);
 });
 it('keeps cap choices explicit with precisely the expected open boundaries',()=>{
  expect(cylinder(1,2,{segments:9,caps:false}).surface.edges.filter(e=>e.faces.length===1)).toHaveLength(18);
  expect(cone(1,2,{segments:9,caps:false}).surface.edges.filter(e=>e.faces.length===1)).toHaveLength(9);
  expect(cylinder(1,2,{segments:9}).faces.filter(f=>f.vertices.length===9).length).toBe(2);
 });
 it('uses ordinary immutable attributes, frozen edits and shape-preserving subdivision',()=>{
  for(const source of [sphere(1,{segments:8,rings:4}),cylinder(1,2,{segments:8}),cone(1,2,{segments:8}),torus(1,.2,{segments:8,tubeSegments:4})]){
    const before=source.points.map(p=>[p.x,p.y,p.z]);
    const refined=source.attribute('mobility',p=>p.z).faceAttribute('material','ink').subdivide().steps(2,(current,next)=>next.move(current.points,p=>[0,0,p.mobility*.1]));
    expect(refined.faces.map(f=>f.material).every(v=>v==='ink')).toBe(true);expect(refined.iteration).toBe(2);expect(source.points.map(p=>[p.x,p.y,p.z])).toEqual(before);
    expect(source.surface).toEqual(source.scale(1).surface);
  }
 });
 it('rejects invalid geometry and oversized resolution before generation',()=>{
  for(const make of [()=>sphere(0),()=>sphere(1,{rings:1}),()=>sphere(1,{segments:1e9}),()=>cylinder(1,0),()=>cone(-1),()=>torus(1,1),()=>torus(1,.2,{segments:1e9})])expect(make).toThrow();
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

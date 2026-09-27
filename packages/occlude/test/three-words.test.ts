/**
 * The 3D words of the one geometry (src/three/api/words.ts): the core's
 * `Material` methods call them, a word that needs faces refuses a
 * value with none by name, face rows measure on the fixed triangles, and a
 * derivation links its rows to the rows they came from.
 */
import {describe,expect,it} from 'vitest';
import {Material} from '../src/material.js';
import {surfaceOf} from '../src/three/geometry/value.js';
import {faceGeometry3} from '../src/three/geometry/model.js';
import {plane,box,pointCloud} from '../src/three/api/mesh.js';
import {grad} from '../src/three/api/vec.js';
import {toolkit} from './helpers/run.js';
import {sphere,geodesic} from '../src/three/api/primitives.js';
import {curve,curve as chain} from '../src/index.js';

describe('the 3D words of the one geometry',()=>{
  it('every value in space is a Material',()=>{
    for(const made of [plane(1),box(1),sphere(1,{segments:6,rings:3}),curve([[0,0,0],[1,0,0]])])expect(made).toBeInstanceOf(Material);
  });
  it('keeps the working view of a value it made, and its fixed triangles through a write',()=>{
    const bent=plane(2).subdivide(2).displace(p=>[0,0,p.x*p.y]),written=bent.points.set('h',1).faces.set('k',2);
    expect(surfaceOf(written).triangles).toEqual(surfaceOf(bent).triangles);
    expect(surfaceOf(written).points.map(p=>p.id)).toEqual(surfaceOf(bent).points.map(p=>p.id));
  });
  it('refuses a face-only word on a value with no faces, by name',()=>{
    const wire=curve([[0,0,0],[1,0,0],[1,1,0]]);
    expect(()=>wire.subdivide()).toThrow('subdivide: this value has no faces');
    expect(()=>wire.dual()).toThrow('dual: this value has no faces');
    expect(()=>wire.union(wire)).toThrow('union: this value has no faces');
    expect(()=>box(1).union({} as never)).toThrow('union: the second value is not a mesh');
  });
  it('measures a face in space on its fixed triangles',()=>{
    const s=sphere(1,{segments:8,rings:4}),g=faceGeometry3(surfaceOf(s));
    s.faces.forEach((f,i)=>{expect(f.normal).toEqual(g.normals[i]);expect(f.area).toBe(g.areas[i]);expect(f.centroid).toEqual(g.centers[i]);});
    // An edge's middle is in space too.
    const e=box(2).edges.at(0)!;expect(e.center).toEqual([(e.a.x+e.b.x)/2,(e.a.y+e.b.y)/2,(e.a.z+e.b.z)/2]);
  });
  it('walks a curve in space: length, along and resample measure in 3D',()=>{
    const c=curve([[0,0,0],[2,0,0],[2,2,1]]);
    expect(c.length).toBeCloseTo(2+Math.hypot(2,1),12);
    const at=c.along({count:5});
    expect(at.points.length).toBe(5);expect(at.points.at(-1)!.z).toBeCloseTo(1,12);
    expect(at.points.every(p=>typeof p.s==='number'&&Array.isArray(p.tangent))).toBe(true);
    expect(c.resample({spacing:0.5}).edges.length).toBeGreaterThan(4);
  });
  it('links derived rows to the rows they came from',()=>{
    const flat=plane(2),fine=flat.subdivide(1);
    for(const f of fine.faces)expect(f.source).toBe(flat.faces.at(0));
    const middle=[...fine.points].find(p=>p.x===0&&p.y===0)!;
    expect([...(middle.source as Iterable<{index:number}>)].map(p=>p.index).sort()).toEqual([0,1,2,3]);
    const cube=box(1),d=geodesic(1,{frequency:1}).dual();
    expect(d.faces.length).toBeGreaterThan(0);
    for(const p of cube.dual().points)expect(cube.faces.has(p.source as never)).toBe(true);
  });
  it('a field that cannot answer at a point leaves that point, and a wrong answer is refused by name',()=>{
    const cube=box(1),moved=cube.displace(p=>p.index===0?[Number.NaN,0,0]:[0,0,1]);
    expect(moved.points.at(0)!.z).toBe(cube.points.at(0)!.z);expect(moved.points.at(1)!.z).toBe(cube.points.at(1)!.z+1);
    expect(()=>cube.displace(()=>'up' as never)).toThrow('displace: the field answered');
    // An extrusion by a vector that is not finite leaves that region where it is.
    expect(cube.extrude(cube.faces.filter(f=>f.index===0),[Number.NaN,0,0]).faces.length).toBe(cube.faces.length);
  });
  it('refuses a surface to t.sample, and a planar question with a place in space, by name',()=>{
    const t=toolkit();
    expect(()=>t.sample(box(1),{count:4})).toThrow('t.sample: this value has faces, and t.sample walks curves — points on a surface are t.scatter(m, { count })');
    const flat=chain([[0,0],[10,0],[10,10]]);
    expect(()=>flat.points.near([0,0,0],{radius:5})).toThrow('points.near: this value is in the plane');
    expect(()=>flat.edges.near([0,0,0],{radius:5})).toThrow('edges.near: this value is in the plane');
    expect(flat.points.near([0,0],{radius:5}).length).toBe(1);
  });
  it('t.streamlines answers one value in both worlds, the seeds saying which',()=>{
    const t=toolkit(),inSpace=t.streamlines(((...a:number[])=>[0,0,1]) as never,{seeds:[[0,0,0],[1,0,0]],step:.05,maxLength:1} as never);
    expect(inSpace).toBeInstanceOf(Material);expect(inSpace.curves.length).toBe(2);expect(inSpace.points.at(0)!.z).toBeDefined();
    expect(t.streamlines((x:number,y:number,z:number)=>[0,0,1] as const,{seeds:pointCloud([[0,0,0]]),step:.05,maxLength:1}).curves.length).toBe(1);
    expect(t.streamlines((x:number,y:number)=>[1,0],{spacing:20})).toBeInstanceOf(Material);
    // The difference step is an option in space as in the plane.
    expect(()=>grad(((x:number,y:number,z:number)=>x) as never,0.5 as never)).toThrow('grad: the step is an option');
  });
});


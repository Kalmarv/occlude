/**
 * The 3D words of the one geometry (src/three/api/words.ts): the core's
 * `Material` methods delegate to them, a word that needs faces refuses a
 * value with none by name, face rows measure on the fixed triangles, and a
 * derivation links its rows to the rows they came from.
 */
import {describe,expect,it} from 'vitest';
import {Material,WORDS_3D} from '../src/material.js';
import {surfaceOf} from '../src/three/geometry/value.js';
import {faceGeometry3} from '../src/three/geometry/model.js';
import {WORDS3} from '../src/three/api/words.js';
import {plane,box} from '../src/three/api/mesh.js';
import {sphere,geodesic} from '../src/three/api/primitives.js';
import {curve} from '../src/three/api/curves.js';

describe('the 3D words of the one geometry',()=>{
  it('fills the core registry, and every value in space is a Material',()=>{
    for(const name of Object.keys(WORDS_3D))expect((WORDS_3D as unknown as Record<string,unknown>)[name]).toBe((WORDS3 as unknown as Record<string,unknown>)[name]);
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
});

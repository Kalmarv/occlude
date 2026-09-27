/**
 * In space a value's faces are only what it states, so a table write keeps
 * each stated face by row identity (faces.ts `restated`): a face whose points
 * and sides are all still there is kept; a side that a split or a replace
 * swapped for a chain of new points runs through it; a face that lost a point
 * or a side is gone.
 */
import {describe,expect,it} from 'vitest';
import {box,plane,view,orthographic} from '../src/three/api/index.js';
import {material} from '../src/index.js';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {triangulation3} from '../src/three/geometry/triangulation.js';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {cameraFrame3} from '../src/three/camera.js';
import type {Material} from '../src/material.js';

/** A box whose faces and corners carry columns of their own. */
const marked=()=>box(1).faces.set('shade',f=>f.index).corners.set('tag',c=>`c${c.index}`);
/** Each face as the points round it. */
const loops=(m:Material)=>[...m.faces].map(f=>[...f.corners].map(c=>c.point.index));
/** The faces are a valid surface: fixed triangles that cover each face. */
const valid=(m:Material)=>{const r=mesh3(m);expect(()=>triangulation3(r)).not.toThrow();r.loops.forEach((loop,f)=>expect(r.localTriangles(f).length).toBe(3*(loop.length-2)));};

describe('a table write keeps the stated faces it still names',()=>{
  it('keeps every face through an added edge or point, with their columns and names',()=>{
    const m=marked(),ps=[...m.points];
    for(const n of [m.edges.add([ps[0],ps[6]]),m.points.add([[5,5,5]]),m.edges.add([ps[0],ps[2]])]){
      expect(loops(n)).toEqual(loops(m));
      expect([...n.faces].map(f=>f.shade)).toEqual([...m.faces].map(f=>f.shade));
      expect([...n.corners].map(c=>c.tag)).toEqual([...m.corners].map(c=>c.tag));
      expect(mesh3(n).names.faces).toEqual(mesh3(m).names.faces);
      expect([...n.faces].every(f=>m.faces.has(f))).toBe(true);
      valid(n);
    }
  });
  it('drops only the faces that lost a side or a point',()=>{
    const m=marked(),side=m.edges.at(0)!,corner=m.points.at(0)!;
    const noSide=m.edges.remove(side),noCorner=m.points.remove(corner);
    expect(noSide.faces.length).toBe(4);
    expect([...noSide.faces].every(f=>[...f.edges].length===4&&m.faces.has(f))).toBe(true);
    expect([...side.faces].some(f=>noSide.faces.has(f))).toBe(false);
    expect(noCorner.faces.length).toBe(3);
    expect([...corner.faces].some(f=>noCorner.faces.has(f))).toBe(false);
    for(const n of [noSide,noCorner])valid(n);
  });
  it('threads a split side through its new point: a corner there, its columns between',()=>{
    const m=marked(),side=m.edges.at(0)!,[a,b]=[side.a,side.b];
    const n=m.split(side,0.25),mid=n.points.at(-1)!;
    expect(n.faces.length).toBe(6);
    expect([...n.faces].every(f=>m.faces.has(f))).toBe(true);
    expect([...n.faces].map(f=>f.shade)).toEqual([...m.faces].map(f=>f.shade));
    const through=[...n.faces].filter(f=>[...f.corners].some(c=>c.point.index===mid.index));
    expect(through.length).toBe(2);
    for(const f of through){
      const pts=[...f.corners].map(c=>c.point.index),k=pts.indexOf(mid.index),before=pts[(k+pts.length-1)%pts.length],after=pts[(k+1)%pts.length];
      expect(new Set([before,after])).toEqual(new Set([a.index,b.index]));
      // A string corner column takes the nearer corner's value; uv lies between.
      const corners=[...f.corners],at=corners[k],prev=corners[(k+corners.length-1)%corners.length],next=corners[(k+1)%corners.length];
      const near=prev.point.index===a.index?prev:next;
      expect(at.tag).toBe(near.tag);
      const t=prev.point.index===a.index?0.25:0.75;
      at.uv.forEach((v:number,i:number)=>expect(v).toBeCloseTo(prev.uv[i]+(next.uv[i]-prev.uv[i])*t,12));
    }
    valid(n);
  });
  it('threads a replaced side through the motif\'s points',()=>{
    const m=marked(),side=m.edges.at(0)!;
    const motif=material([[0,0],[0.3,0],[0.6,0],[1,0]],{edges:[[0,1],[1,2],[2,3]]});
    const n=m.replace(side,motif);
    expect(n.faces.length).toBe(6);
    expect(loops(n).filter(l=>l.length===6).length).toBe(2);
    valid(n);
  });
  it('draws the faces a write kept',()=>{
    const m=plane(2).subdivide(1),ps=[...m.points],camera=orthographic({eye:[0,0,5],target:[0,0,0],up:[0,1,0],span:3});
    const n=m.edges.add([ps[0],ps.at(-1)!]);
    const count=(g:Material)=>featureSnapshot3(view(g,{camera}).scene.objects,[],cameraFrame3(camera,{x:0,y:0,width:100,height:100})).occluders.length;
    expect(count(n)).toBe(count(m));
  });
  it('leaves the plane alone: there the picture says what the faces are',()=>{
    const flat=material([[0,0],[10,0],[10,10],[0,10]],{edges:[[0,1],[1,2],[2,3],[3,0]]});
    const split=flat.edges.add([flat.points.at(0)!,flat.points.at(2)!]);
    expect(split.faces.length).toBe(2);
  });
});

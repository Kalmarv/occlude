/**
 * The one write on a value in space: `set(column, value, where?, opts?)` and
 * `set({ … }, where?, opts?)` on points, edges, faces and corners, on points
 * and curves, on samples and on instances; and the history a `t.steps` run
 * keeps through `withHistory`. The write is the core's (tables.ts); what is
 * checked here is what a value in space adds: `z` is a position, a write
 * keeps the faces, their corners and their fixed triangles, and a declared
 * transfer policy reaches the 3D refinement.
 */
import {describe,expect,it} from 'vitest';
import {plane,box,pointCloud,curve,grid,instanceOnPoints} from '../src/three/api/index.js';
import {scatterSurface} from '../src/three/api/sampling.js';
import type {Material} from '../src/material.js';
import {surfaceOf} from '../src/three/geometry/value.js';
import {toolkit} from './helpers/run.js';

const sheet=()=>plane(2,2).subdivide(2);

describe('points.set in space',()=>{
  it('writes a number, a string, a boolean and a vector on every point',()=>{
    const m=sheet().points.set({h:(p)=>p.x+p.y,name:'a',on:true,dir:[0,0,1]});
    expect(m.points.every(p=>p.h===p.x+p.y&&p.name==='a'&&p.on===true)).toBe(true);
    expect(m.points.at(0)!.dir).toEqual([0,0,1]);
    expect(Object.isFrozen(m.points.at(0)!.dir)).toBe(true);
  });
  it('answers a new value, keeps the faces, the corners and the fixed triangles, and leaves the input as it was',()=>{
    const a=sheet().displace((p)=>[0,0,p.x*p.y]),b=a.points.set('h',1);
    expect(b).not.toBe(a);
    expect(a.points.at(0)!.h).toBeUndefined();
    expect(b.faces.length).toBe(a.faces.length);expect(b.corners.length).toBe(a.corners.length);
    expect(surfaceOf(b).triangles).toEqual(surfaceOf(a).triangles);
  });
  it('writes only where a predicate, a selection or one row says',()=>{
    const m=sheet().points.set('h',0);
    const byPredicate=m.points.set('h',1,(p)=>p.x>0);
    expect(byPredicate.points.filter(p=>p.h===1).length).toBe(m.points.filter(p=>p.x>0).length);
    const right=m.points.filter(p=>p.x>0);
    const bySelection=m.points.set('h',2,right);
    expect(bySelection.points.filter(p=>p.h===2).indices).toEqual(right.indices);
    const one=m.points.at(3)!;
    expect(m.points.set('h',3,one).points.filter(p=>p.h===3).indices).toEqual([3]);
  });
  it('reads a selection of an earlier state of the same rows',()=>{
    const first=sheet().points.set('h',0),picked=first.points.filter(p=>p.x<0);
    const later=first.displace([0,0,1]);
    expect(later.points.set('h',1,picked).points.filter(p=>p.h===1).indices).toEqual(picked.indices);
  });
  it('reads every function against the rows as they were before the write',()=>{
    const m=sheet().points.set({u:1,w:2});
    const swapped=m.points.set({u:(p)=>p.w,w:(p)=>p.u});
    expect(swapped.points.every(p=>p.u===2&&p.w===1)).toBe(true);
    const spike=m.points.set('u',(p)=>p.index===12?9:0);
    const spread=spike.points.set('u',(p)=>Math.max(p.u,...p.adjacent.map(q=>q.u)));
    expect(spread.points.filter(p=>p.u===9).length).toBe(1+spike.points.at(12)!.adjacent.length);
  });
  it('moves points through z, and keeps the faces',()=>{
    const m=sheet(),out=m.points.set('z',(p)=>p.x>0?1:0);
    expect(out.points.every(p=>p.z===(m.points.at(p.index)!.x>0?1:0))).toBe(true);
    expect(out.faces.length).toBe(m.faces.length);
    expect(()=>m.points.set('z','up' as never)).toThrow("'z' is a position, a number");
  });
  it('a new column written on a subset is the kind\'s default elsewhere: the one geometry has no holes',()=>{
    const out=sheet().points.set('tag','top',(p)=>p.y>0);
    expect(out.points.filter(p=>p.y<=0).every(p=>p.tag==='')).toBe(true);
    expect(out.points.filter(p=>p.y>0).every(p=>p.tag==='top')).toBe(true);
  });
  it('keeps one kind per column, refused by name',()=>{
    const m=sheet().points.set('h',0);
    expect(()=>m.points.set('h','x',(p)=>p.index===0)).toThrow("the column 'h' holds a number");
    expect(()=>m.points.set('id',1)).toThrow("'id' is a reserved field of a point");
  });
  it('declares a transfer policy that the 3D refinement reads',()=>{
    const m=sheet().points.set('cat',(p)=>p.x>0?1:0,{transfer:'nearest'});
    expect(m.transfers.cat).toBe('nearest');
    expect(m.subdivide(1).points.every(p=>p.cat===0||p.cat===1)).toBe(true);
    expect(m.points.set('cat',(p)=>p.x>0?0:1).transfers.cat).toBe('nearest');
    // Interpolated, a column refines to the means of its parents.
    const mean=sheet().points.set('cat',(p)=>p.x>0?1:0).subdivide(1);
    expect(mean.points.some(p=>p.cat>0&&p.cat<1)).toBe(true);
  });
});

describe('edges, faces and corners set in space',()=>{
  it('edges: every value kind, a where',()=>{
    const m=box(1),marked=m.edges.at(0)!;
    const out=m.edges.set({w:(e)=>e.length,label:'rim',on:false,v:[1,2]}).edges.set('hot',true,marked);
    expect(out.edges.every(e=>e.w===e.length&&e.label==='rim'&&e.on===false)).toBe(true);
    expect(out.edges.filter(e=>e.hot===true).indices).toEqual([0]);
  });
  it('faces: a predicate, a selection, a row, and children inherit after subdivide',()=>{
    const m=box(1),up=m.faces.filter(f=>f.normal[2]>0.5);
    const out=m.faces.set('zone',0).faces.set('zone',2,up).faces.set('name',(f)=>f.normal[0]>0.5?'east':'other');
    expect(out.faces.filter(f=>f.zone===2).indices).toEqual(up.indices);
    expect(out.faces.filter(f=>f.name==='east').length).toBe(1);
    expect(out.subdivide(1).faces.filter(f=>f.zone===2).length).toBe(4);
  });
  it('corners: a vector column, one value per face and point',()=>{
    const m=plane(1,1),out=m.corners.set('tone',(c)=>[c.face.corners.indices.indexOf(c.index),0]);
    expect(out.corners.map(c=>c.tone)).toEqual([[0,0],[1,0],[2,0],[3,0]]);
    const one=out.corners.at(2)!;
    expect(out.corners.set('tone',[9,9],one).corners.map(c=>c.tone[0])).toEqual([0,1,9,3]);
  });
});

describe('points and curves set',()=>{
  it('points: columns, a where, and positions',()=>{
    const g=pointCloud([[0,0,0],[1,0,0],[2,0,0]]);
    const out=g.points.set({h:(p)=>p.x*2,tag:'p',on:(p)=>p.x>0,v:[0,1]}).points.set('z',5,(p)=>p.index===1);
    expect(out.points.map(p=>p.h)).toEqual([0,2,4]);
    expect(out.points.map(p=>p.z)).toEqual([0,5,0]);
    expect(out.points.map(p=>p.on)).toEqual([false,true,true]);
  });
  it('a curve: points and edges keep the curve',()=>{
    const c=curve([[0,0,0],[1,0,0],[2,1,0]]);
    const out=c.points.set('w',(p)=>p.index).edges.set('seg',(e)=>e.index===0?'first':'rest');
    expect(out.points.map(p=>p.w)).toEqual([0,1,2]);
    expect(out.edges.map(e=>e.seg)).toEqual(['first','rest']);
    const lifted=out.points.set('z',1,out.points.at(2)!);
    expect(lifted.points.at(2)!.z).toBe(1);
    expect(lifted.edges.length).toBe(2);
  });
  it('grid points write as points',()=>{
    expect(grid({cols:3,rows:3}).points.set('h',1).points.every(p=>p.h===1)).toBe(true);
  });
  it('samples keep their captured sample through a write',()=>{
    let i=0;const rnd=()=>((i++*0.618034)%1);
    const s=scatterSurface(plane(2,2),{count:5},{rnd});
    const out=s.points.set('h',(p)=>p.sample.face.index).points.set('z',1);
    expect(out.points.every(p=>p.h===p.sample.face.index&&p.z===1)).toBe(true);
    expect(out.points.map(p=>p.sample)).toEqual(s.points.map(p=>p.sample));
  });
  it('instances: a column on the instance rows, placements kept; transform is not a column',()=>{
    const inst=instanceOnPoints(box(0.2),pointCloud([[0,0,0],[1,0,0]]));
    const out=inst.instances.set('size',(r)=>r.index+1);
    expect(out.rows.map(r=>r.size)).toEqual([1,2]);
    expect(out.rows.map(r=>r.transform)).toEqual(inst.rows.map(r=>r.transform));
    expect(()=>inst.instances.set('transform',1 as never)).toThrow("'transform' is not a column");
  });
});

describe('history through withHistory',()=>{
  it('a value keeps the states it is handed, and every other operation starts none',()=>{
    const a=sheet(),b=a.displace([0,0,1]),kept=b.withHistory([a,b]);
    expect(kept.history).toEqual([a,b]);
    expect(Object.isFrozen(kept.history)).toBe(true);
    expect(kept.points.set('h',1).history).toEqual([]);
    expect(a.history).toEqual([]);
  });
  it('t.steps over a value in space runs one-argument passes and keeps history with { every }',()=>{
    const t=toolkit();
    const start=sheet().points.set('h',0);
    const lift=(m:Material)=>m.points.set('h',(p)=>p.h+1).displace((p)=>[0,0,p.x>0?0.1:0]);
    const out=t.steps(4,start,lift,{every:2});
    expect(out.points.every(p=>p.h===4)).toBe(true);
    expect(out.history.map(m=>m.points.at(0)!.h)).toEqual([0,2,4]);
    expect(out.history.at(-1)!.points.map(p=>p.z)).toEqual(out.points.map(p=>p.z));
    expect(t.steps(3,start,lift).history).toEqual([]);
  });
});

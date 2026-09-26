import {describe,it,expect,expectTypeOf} from 'vitest';
import {box,plane,pointCloud,instanceOnPoints} from 'occlude/3d';
import {toolkit} from './helpers/run.js';

describe('typed corner fields and edits',()=>{
 it('exposes owned corner collections and typed incident domains without splitting points',()=>{
  const model=box().points.set({mass:2}).faces.set({tone:.5}).corners.set({uv:c=>[c.point.x,c.point.y] as const,age:0});
  expect(model.points.length).toBe(8);expect(model.corners.length).toBe(24);
  const c=model.corners.at(0)!;
  expectTypeOf(c.uv).toEqualTypeOf<readonly [number,number]>();expectTypeOf(c.point.mass).toEqualTypeOf<number>();expectTypeOf(c.face.tone).toEqualTypeOf<number>();
  expect(c.point.corners.length).toBe(3);expect(c.face.corners.length).toBe(4);expect(c.face.corners.has(c)).toBe(true);
  expect(model.faces.filter(f=>f.index===0).corners().points.length).toBe(4);
  expect(model.points.filter(p=>p.index===0).corners().faces().length).toBe(3);
  expect(model.corners.groupBy(c=>c.face.index).map(g=>g.points.length)).toEqual([4,4,4,4,4,4]);
  expect(model.corners.filter(c=>c.index===0).complement().length).toBe(23);
  expect(model.corners.extract().length).toBe(24);expect(()=>JSON.stringify(c)).not.toThrow();
  expect(()=>model.corners.has({...c})).toThrow('expected a corner row');
  // Another revision's corners are read by id (spec 58, G3-29).
  expect(model.corners.union(model.translate([0,0,0]).corners).length).toBe(24);
 });
 it('captures all corner initializers against the same input revision',()=>{
  const initial=plane().corners.set({energy:2,lag:0});
  const out=initial.corners.set({energy:c=>c.energy+1,lag:c=>c.energy});
  expect(out.corners.map(c=>[c.energy,c.lag])).toEqual([[3,2],[3,2],[3,2],[3,2]]);
  expect(initial.corners.every(c=>c.energy===2)).toBe(true);
 });
 it('evolves corner values in a run, with one kind per column and no promises',()=>{
  const t=toolkit();
  const source=plane().corners.set({age:0,uv:c=>[c.point.x,c.point.y] as const});
  const out=t.steps(2,source,m=>{
    const first=m.corners.at(0)!;
    expect(()=>m.corners.set('age','bad',first)).toThrow("'age' would hold a string and a number");
    expect(()=>m.corners.set('uv',[1,2,3],first)).toThrow("'uv' would hold a vector of 3 and a vector of 2");
    expect(()=>m.corners.set('age',(async()=>2) as never)).toThrow('synchronous');
    return m.corners.set({age:c=>c.age+1,uv:c=>[c.uv[0]+1,c.uv[1]] as const});
  },{every:1});
  expect(out.corners.every(c=>c.age===2)).toBe(true);
  expect(out.corners.at(0)!.uv[0]).toBe(source.corners.at(0)!.uv[0]+2);
  expect(out.history.map(h=>h.corners.at(0)!.age)).toEqual([0,1,2]);
  // A selection of an earlier revision is read by id.
  expect(out.corners.set('age',3,source.corners).corners.every(c=>c.age===3)).toBe(true);
 });
 it('preserves typed corner data and transfer policies through extraction and realization',()=>{
  const source=box().corners.set({uv:c=>[c.point.x,c.point.y] as const,label:c=>c.index},{transfer:{label:'nearest'}});
  const selected=source.faces.filter(f=>f.index===0).extract();
  expect(selected.corners.map(c=>c.uv)).toEqual(source.faces.at(0)!.corners.map(c=>c.uv));
  expect(selected.cornerTransfers.label).toBe('nearest');
  const refined=selected.subdivide();expect(refined.cornerTransfers.label).toBe('nearest');
  expect(refined.corners.every(c=>selected.corners.some(p=>p.label===c.label))).toBe(true);
  expectTypeOf(refined.corners.at(0)!.uv).toEqualTypeOf<readonly [number,number]>();
  const instances=instanceOnPoints(source,pointCloud([[0,0,0],[2,0,0]]).points.set('batch',7).points);
  const realized=instances.realize();
  expectTypeOf(realized.corners.at(0)!.uv).toEqualTypeOf<readonly [number,number]>();
  expectTypeOf(realized.corners.at(0)!.batch).toEqualTypeOf<number>();
  expect(realized.corners.length).toBe(48);expect(realized.cornerTransfers.label).toBe('nearest');
  expect(source.corners.set('label',c=>c.label+1).cornerTransfers.label).toBe('nearest');
  expect(()=>source.corners.set('label',1,{transfer:'bad'} as any)).toThrow("'interpolate' or 'nearest'");
  expect(()=>source.points.set('weight',1,{transfer:'bad'} as any)).toThrow("'interpolate' or 'nearest'");
 });
});

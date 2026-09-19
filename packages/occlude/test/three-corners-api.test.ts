import {describe,it,expect,expectTypeOf} from 'vitest';
import {box,plane,pointCloud,instanceOnPoints,type MeshEdit} from 'occlude/3d';

describe('typed corner fields and edits',()=>{
 it('exposes owned corner collections and typed incident domains without splitting points',()=>{
  const model=box().attributes({mass:2}).faceAttributes({tone:.5}).cornerAttributes({uv:c=>[c.point.x,c.point.y] as const,age:0});
  expect(model.points.length).toBe(8);expect(model.corners.length).toBe(24);
  const c=model.corners.at(0)!;
  expectTypeOf(c.uv).toEqualTypeOf<readonly [number,number]>();expectTypeOf(c.point.mass).toEqualTypeOf<2>();expectTypeOf(c.face.tone).toEqualTypeOf<0.5>();
  expect(c.point.corners.length).toBe(3);expect(c.face.corners.length).toBe(4);expect(c.face.corners.has(c)).toBe(true);
  expect(model.faces.filter(f=>f.index===0).corners().points.length).toBe(4);
  expect(model.points.filter(p=>p.index===0).corners().faces().length).toBe(3);
  expect(model.corners.groupBy(c=>c.face.index).map(g=>g.points.length)).toEqual([4,4,4,4,4,4]);
  expect(model.corners.filter(c=>c.index===0).complement().length).toBe(23);
  expect(model.corners.extract().length).toBe(24);expect(()=>JSON.stringify(c)).not.toThrow();
  expect(()=>model.corners.has({...c})).toThrow('expected a corner row');
  expect(()=>model.corners.union(model.translate([0,0,0]).corners)).toThrow('source revision');
 });
 it('captures all corner initializers against the same input revision',()=>{
  const initial=plane().cornerAttributes({energy:2,lag:0});
  const out=initial.cornerAttributes({energy:c=>c.energy+1,lag:c=>c.energy});
  expect(out.corners.map(c=>[c.energy,c.lag])).toEqual([[3,2],[3,2],[3,2],[3,2]]);
  expect(initial.corners.every(c=>c.energy===2)).toBe(true);
 });
 it('evolves corner values in frozen passes, with schema, async and editor checks',()=>{
  const source=plane().cornerAttributes({age:0,uv:c=>[c.point.x,c.point.y] as const});
  let escaped:MeshEdit<{}, {}, {}, {age:number;uv:readonly [number,number]}>|undefined;
  const out=source.steps(2,(current,next)=>{
    escaped=next;
    next.setCorners(current.corners,c=>({age:c.age+1,uv:[c.uv[0]+1,c.uv[1]]}));
    expect(current.corners.at(0)!.age).toBe(current.iteration);
    expect(()=>next.setCorners(current.corners,{age:'bad'} as any)).toThrow('initialized type');
    expect(()=>next.setCorners(current.corners,{uv:[1,2,3]} as any)).toThrow('dimension');
    expect(()=>next.setCorners(current.corners,(async()=>({age:2})) as any)).toThrow('synchronous');
    expect(()=>next.setCorners(current.corners,{unknown:1} as any)).toThrow('initialize');
    next.setCorner(current.corners.at(0)!,{age:current.corners.at(0)!.age+1});
  },{every:1});
  expect(out.corners.every(c=>c.age===2)).toBe(true);
  expect(out.corners.at(0)!.uv[0]).toBe(source.corners.at(0)!.uv[0]+2);
  expect(out.history.map(h=>h.geometry.corners.at(0)!.age)).toEqual([0,1,2]);
  expect(()=>escaped!.setCorners(out.corners,{age:4})).toThrow('closed');
  expect(()=>out.steps(1,(_,next)=>next.setCorners(source.corners,{age:3}))).toThrow('revision');
 });
 it('preserves typed corner data and transfer policies through extraction and realization',()=>{
  const source=box().cornerAttributes({uv:c=>[c.point.x,c.point.y] as const,label:c=>c.index},{transfer:{label:'nearest'}});
  const selected=source.faces.filter(f=>f.index===0).extract();
  expect(selected.corners.map(c=>c.uv)).toEqual(source.faces.at(0)!.corners.map(c=>c.uv));
  expect(selected.cornerTransfers.label).toBe('nearest');
  const refined=selected.subdivide();expect(refined.cornerTransfers.label).toBe('nearest');
  expect(refined.corners.every(c=>selected.corners.some(p=>p.label===c.label))).toBe(true);
  expectTypeOf(refined.corners.at(0)!.uv).toEqualTypeOf<readonly [number,number]>();
  const instances=instanceOnPoints(source,pointCloud([[0,0,0],[2,0,0]]).attribute('batch',7).points);
  const realized=instances.realize();
  expectTypeOf(realized.corners.at(0)!.uv).toEqualTypeOf<readonly [number,number]>();
  expectTypeOf(realized.corners.at(0)!.batch).toEqualTypeOf<7>();
  expect(realized.corners.length).toBe(48);expect(realized.cornerTransfers.label).toBe('nearest');
  expect(source.cornerAttribute('label',c=>c.label+1).cornerTransfers.label).toBe('nearest');
  expect(()=>source.cornerAttribute('label',1,{transfer:'bad'} as any)).toThrow('nearest or interpolate');
  expect(()=>source.attribute('weight',1,{transfer:'bad'} as any)).toThrow('nearest or interpolate');
 });
});

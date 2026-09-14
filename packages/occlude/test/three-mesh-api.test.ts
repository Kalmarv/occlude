import {describe,it,expect,expectTypeOf} from 'vitest';
import {box3} from '../src/three/geometry/surface.js';
import {plane,box,mesh,pointCloud,MeshEdit} from '../src/three/api/mesh.js';
describe('immutable mesh values and frozen domains',()=>{
 it('shares the mesh contract across plane, box and raw topology',()=>{
  for(const shape of [plane(),box(),mesh([[0,0,0],[1,0,0],[0,1,0]],[[0,1,2]])]){
   const original=shape.points.map(p=>[p.x,p.y,p.z]);
   const edited=shape.subdivide().attribute('mobility',p=>p.x+2).displace(p=>[0,0,p.mobility*.1]);
   expect(edited.points.length).toBeGreaterThan(shape.points.length);expect(shape.points.map(p=>[p.x,p.y,p.z])).toEqual(original);
   expect(edited.points.map(p=>p.mobility).every(v=>typeof v==='number')).toBe(true);
  }
  expect(plane().points.length).toBe(4);expect(plane().edges.length).toBe(4);expect(plane().faces().length).toBe(1);
  expect(plane().faces().at(0)?.normal).toEqual([0,0,1]);
 });
 it('propagates typed attributes, supports replacement, and protects row names',()=>{
  const value=plane().attribute('weight',p=>p.x+1).faceAttribute('height',()=>1.5).faceAttributes(f=>({label:f.height>1?'high':'low'}));
  expectTypeOf(value.points.at(0)!.weight).toEqualTypeOf<number>();
  expectTypeOf(value.faces().at(0)!.height).toMatchTypeOf<number>();
  expect(value.faces().at(0)?.label).toBe('high');
  const changed=value.attribute('weight','heavy');expectTypeOf(changed.points.at(0)!.weight).toEqualTypeOf<'heavy'>();
  expect(changed.points.at(0)?.attributes.weight).toBe('heavy');
  expect(()=>value.attribute('x',2)).toThrow('reserved');expect(()=>value.faceAttribute('area',2)).toThrow('reserved');
  expect(()=>value.attribute('bad',NaN)).toThrow('finite');
  expect(()=>{(value.points.at(0)!.attributes as {weight:number}).weight=5;}).toThrow();
 });
 it('keeps groups as selections and extracts shared face topology',()=>{
  const b=box().faceAttribute('axis',f=>Math.abs(f.normal[2]));
  const groups=b.faces().groupBy(f=>f.axis);expect(groups.length).toBe(2);
  expect(groups.map(g=>[g.key,g.length]).sort()).toEqual([[0,4],[1,2]]);
  const side=groups.find(g=>g.key===0)!.extract();expect(side.points.length).toBe(8);expect(side.faces().length).toBe(4);
  expect(side.edges.length).toBe(12);expect(side.faces().map(f=>f.axis)).toEqual([0,0,0,0]);
  const points=b.points.filter(p=>p.z>0).extract();expect(points.points.length).toBe(4);expect('faces' in points).toBe(false);
  const curves=b.edges.filter(e=>e.a.z>0&&e.b.z>0).extract();expect(curves.segments.length).toBe(4);expect('faces' in curves).toBe(false);
 });
 it('accumulates edits against frozen input and preserves continued history',()=>{
  const original=plane().attribute('mobility',p=>p.x+1);let escaped:MeshEdit<{mobility:number},{},{}>|undefined;
  const value=original.steps(3,(current,next,k)=>{
   escaped=next;const before=current.points.map(p=>p.z);
   next.move(current.points,p=>[0,0,p.mobility]);next.move(current.points,p=>[0,0,p.mobility]);
   expect(current.points.map(p=>p.z)).toEqual(before);expect(k).toBeLessThan(3);
  },{every:2});
  expect(value.iteration).toBe(3);expect(value.history.map(s=>s.iteration)).toEqual([0,2,3]);
  expect(value.history.every(s=>s.geometry.history.length===0)).toBe(true);
  expect(value.points.map(p=>p.z)).toEqual(original.points.map(p=>p.mobility*6));
  expect(()=>escaped!.move(original.points,[0,0,1])).toThrow('closed');
  expect(()=>value.steps(1,(_,next)=>next.move(original.points,[0,0,1]))).toThrow('another mesh revision');
  const continued=value.steps(1,(_,next)=>{}, {every:1});expect(continued.iteration).toBe(4);expect(continued.history.map(s=>s.iteration)).toEqual([3,4]);
  expect(original.points.map(p=>p.z)).toEqual([0,0,0,0]);
 });
 it('imports owned mutable surfaces without losing IDs, attributes or fixed triangles',()=>{
  const raw=box3();raw.faces[0].attributes.label='bottom';// preserve source identity
  const imported=mesh(raw);raw.points[0].position=[99,99,99];raw.faces[0].attributes.label='changed';
  expect(imported.points.at(0)?.id).toBe('p0');expect(imported.points.at(0)?.x).toBe(-.5);
  expect(imported.faces().at(0)?.attributes.label).toBe('bottom');
  const invalid={...box3(),triangles:[]};expect(()=>mesh(invalid)).toThrow('triangulation');
 });
 it('owns raw inputs, preserves edge transfer and leaves new interior attributes optional',()=>{
  const positions:[number,number,number][]=[[0,0,0],[1,0,0],[0,1,0]],source=mesh(positions,[[0,1,2]]).edgeAttribute('pen',2);
  positions[0][0]=99;expect(source.points.at(0)?.x).toBe(0);
  expectTypeOf(source.edges.at(0)!.pen).toMatchTypeOf<number>();
  const refined=source.subdivide();expectTypeOf(refined.edges.at(0)!.pen).toMatchTypeOf<number|undefined>();expect(refined.edges.filter(e=>e.attributes.pen===2).length).toBe(6);
  expect(refined.edges.filter(e=>e.attributes.pen===undefined).length).toBe(3);
  expect(pointCloud([[0,0,0]]).attribute('height',2).translate([0,0,3]).points.at(0)?.height).toBe(2);
 });
});

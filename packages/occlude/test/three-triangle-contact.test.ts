import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {point,triangleWeights,type H} from '../src/three/geometry/exact.js';
import {triangleContact3,type ExactTriangle3} from '../src/three/curves/contact.js';
import type {Triangle3} from '../src/three/math.js';
const tri=(points:Triangle3):ExactTriangle3=>points.map(point) as unknown as ExactTriangle3;
const xy=tri([[0,0,0],[2,0,0],[0,2,0]]);
describe('exact triangle contacts',()=>{
 it('constructs transverse endpoints and retains incidence on both sources',()=>{
  const a=tri([[1,0,0],[0,1,0],[0,0,1]]),b=tri([[0,0,0],[1,1,0],[0,0,1]]),hit=triangleContact3(a,b)!;
  expect(hit.kind).toBe('segment');expect(hit.coplanar).toBe(false);expect(hit.points).toEqual([[0n,0n,1n,1n],[1n,1n,0n,2n]]);
  expect(hit.points.every(p=>triangleWeights(a,p)&&triangleWeights(b,p))).toBe(true);
  expect(triangleContact3(b,a)).toEqual(hit);
 });
 it('distinguishes disjoint, isolated tangent, and shared-edge contact',()=>{
  expect(triangleContact3(xy,tri([[0,0,1],[2,0,1],[0,2,1]]))).toBeNull();
  expect(triangleContact3(xy,tri([[3,0,-1],[3,0,1],[3,1,0]]))).toBeNull();
  const tangent=triangleContact3(xy,tri([[2,0,0],[3,0,1],[3,1,1]]))!;expect(tangent.kind).toBe('point');expect(tangent.points).toEqual([[2n,0n,0n,1n]]);
  const edge=triangleContact3(xy,tri([[0,0,0],[2,0,0],[0,0,2]]))!;expect(edge.kind).toBe('segment');expect(edge.coplanar).toBe(false);expect(edge.points).toEqual([[0n,0n,0n,1n],[2n,0n,0n,1n]]);
  const coplanarEdge=triangleContact3(xy,tri([[0,0,0],[0,-2,0],[2,0,0]]))!;expect(coplanarEdge.kind).toBe('segment');expect(coplanarEdge.coplanar).toBe(true);
 });
 it('returns the canonical coplanar overlap polygon under order and winding changes',()=>{
  const other=tri([[1,-1,0],[3,1,0],[-1,1,0]]),hit=triangleContact3(xy,other)!;expect(hit.kind).toBe('area');
  expect(hit.points.length).toBeGreaterThanOrEqual(3);
  for(const a of [xy,[xy[2],xy[1],xy[0]] as ExactTriangle3])for(const b of [other,[other[1],other[2],other[0]] as ExactTriangle3]){expect(triangleContact3(a,b)).toEqual(hit);expect(triangleContact3(b,a)).toEqual(hit);}
  for(const p of hit.points){expect(triangleWeights(xy,p)).not.toBeNull();expect(triangleWeights(other,p)).not.toBeNull();}
 });
 it('keeps coplanar vertex contact and rejects separated coplanar triangles',()=>{
  expect(triangleContact3(xy,tri([[2,0,0],[3,0,0],[2,1,0]]))!.points).toEqual([[2n,0n,0n,1n]]);
  expect(triangleContact3(xy,tri([[3,0,0],[4,0,0],[3,1,0]]))).toBeNull();
  expect(triangleContact3(xy,xy)!.points).toHaveLength(3);
 });
 it('keeps exact tiny separation and validates degenerate input',()=>{
  const tiny=tri([[0,0,Number.MIN_VALUE],[2,0,Number.MIN_VALUE],[0,2,Number.MIN_VALUE]]);expect(triangleContact3(xy,tiny)).toBeNull();
  const far=xy.map(p=>[p[0]+100000000000000000000n*p[3],p[1],p[2],p[3]] as H) as unknown as ExactTriangle3;
  expect(triangleContact3(far,far)!.points).toHaveLength(3);
  expect(()=>triangleContact3(xy,tri([[0,0,0],[1,1,1],[2,2,2]]))).toThrow('degenerate');
 });
 it('matches 300 independent Fraction-oracle contacts across order, winding and scale',()=>{
  const rows=JSON.parse(readFileSync(new URL('./fixtures/triangle-contacts.json',import.meta.url),'utf8')) as {id:string;a:Triangle3;b:Triangle3;expected:unknown}[];
  const encode=(value:unknown)=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));
  expect(rows).toHaveLength(300);
  for(const row of rows){
   const a=tri(row.a),b=tri(row.b),reverse=[a[2],a[1],a[0]] as ExactTriangle3;
   expect(encode(triangleContact3(a,b)),row.id).toEqual(row.expected);
   expect(encode(triangleContact3(b,a)),row.id+' swap').toEqual(row.expected);
   expect(encode(triangleContact3(reverse,b)),row.id+' reverse').toEqual(row.expected);
  }
 });

});

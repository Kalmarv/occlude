import {describe,it,expect} from 'vitest';
import {triangleCorners3} from '../src/three/geometry/corners.js';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {Selection} from '../src/selection.js';
import {mesh,pointCloud} from '../src/three/api/mesh.js';
import {instanceOnPoints} from '../src/three/api/instances.js';
/** Two quads that share a side, each with its own uv
 * chart and island at its corners. */
const pairValue=()=>mesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[2,0,0],[2,1,0]],[[0,1,2,3],[1,4,5,2]]).corners.set({
  uv:c=>[[0,0],[1,0],[1,1],[0,1]][c.index%4].map((v,k)=>v+(k===0?Math.floor(c.index/4)*10:0)),
  island:c=>c.index<4?'left':'right',
});
describe('owned polygon corner storage',()=>{
 it('stores independent values at a shared geometric vertex',()=>{
  const m=pairValue();expect(m.points.length).toBe(6);expect(m.corners.length).toBe(8);
  expect(m.faces.at(0)!.corners.at(1)!.uv).toEqual([1,0]);expect(m.faces.at(1)!.corners.at(0)!.uv).toEqual([10,0]);
  const uv=m.faces.at(0)!.corners.at(1)!.uv;
  expect(Object.isFrozen(uv)).toBe(true);
  expect(()=>{(uv as number[])[0]=99;}).toThrow();
  expect(m.faces.at(0)!.corners.at(1)!.uv).toEqual([1,0]);
 });
 it('keeps corner-to-vertex correspondence under mirrors and fixed nonplanar triangles',()=>{
  const s=pairValue(),mirrored=s.scale([-2,3,1]),names=(v:typeof s)=>mesh3(v).names.corners.slice(0,4);
  expect(names(mirrored)).toEqual([...names(s)].reverse());
  expect(mirrored.faces.at(0)!.corners.map(c=>c.uv)).toEqual([...s.faces.at(0)!.corners.map(c=>c.uv)].reverse());
  expect(mirrored.faces.at(0)!.corners.map(c=>c.point.index)).toEqual([...s.faces.at(0)!.corners.map(c=>c.point.index)].reverse());
  const bent=mesh3(pairValue().displace(p=>[0,0,p.index===2?.5:0]));
  for(let i=0;i<bent.triangleCount;i++)expect(triangleCorners3(bent,i).map(c=>bent.loops[bent.triangleFace[i]][c])).toEqual([...bent.triangle(i)]);
 });
 it('interpolates each seam side independently during subdivision',()=>{
  const s=pairValue().subdivide(1);expect(s.faces.length).toBe(8);
  const seam=s.points.find(p=>p.x===1&&p.y===.5)!;expect(seam).toBeDefined();
  const corners=s.corners.filter(c=>c.point.index===seam.index);
  expect(corners.map(c=>c.uv)).toEqual([[1,.5],[1,.5],[10,.5],[10,.5]]);
  expect(new Set(corners.map(c=>c.island))).toEqual(new Set(['left','right']));
  expect(new Set(mesh3(s).names.corners).size).toBe(32);
 });
 it('retains fixed triangle mapping for non-affine corner fields',()=>{
  // One quad, drawn as the triangles 0-1-2 and 2-3-0, whose uv is not affine.
  const quad=mesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],[[1,2,3,0]]).corners.set('uv',c=>[[0,0],[1,0],[2,1],[0,1]][c.point.index]);
  expect([...mesh3(quad).triangles]).toEqual([0,1,2,2,3,0]);
  expect(()=>quad.subdivide(1,{maxFaces:4})).toThrow('budget');
  const refined=quad.subdivide(1,{maxFaces:8});expect(refined.faces.length).toBe(8);
  expect(refined.faces.every(f=>f.corners.length===3)).toBe(true);
  const center=refined.points.find(p=>p.x===.5&&p.y===.5)!;
  const samples=refined.corners.filter(c=>c.point.index===center.index).map(c=>c.uv);
  expect(samples.length).toBeGreaterThan(0);expect(samples.every(uv=>JSON.stringify(uv)==='[1,0.5]')).toBe(true);
  // No quad was split round its middle: every made point sits between two.
  expect(refined.points.every(p=>!(p.source instanceof Selection)||p.source.length===2)).toBe(true);
 });
 it('namespaces realized corners while preserving their values',()=>{
  const prototype=pairValue(),placed=instanceOnPoints(prototype,pointCloud([[0,0,0],[3,0,0]]).points),out=placed.realize();
  // Every copy has its own corners, holding the prototype's values.
  expect(out.corners.length).toBe(16);expect(out.faces.at(1)!.corners.map(c=>c.uv)).toEqual([[10,0],[11,0],[11,1],[10,1]]);
  expect(out.faces.at(0)!.corners.map(c=>c.uv)).toEqual(out.faces.at(2)!.corners.map(c=>c.uv));
  expect(out.faces.at(3)!.corners.map(c=>c.island)).toEqual(Array(4).fill('right'));
  // A realized face comes from the prototype face and its copy.
  expect(out.faces.at(2)!.source).toEqual([prototype.faces.at(0),placed.points.at(1)]);
 });
 it('names one corner per polygon vertex, uniquely',()=>{
  const m=pairValue(),read=mesh3(m);
  expect(m.faces.map(f=>f.corners.length)).toEqual(read.loops.map(l=>l.length));
  expect(new Set(read.names.corners).size).toBe(read.cornerCount);
  expect(m.faces.at(1)!.corners.map(c=>c.point.index)).toEqual([1,4,5,2]);
 });
});

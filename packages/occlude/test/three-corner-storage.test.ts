import {describe,it,expect} from 'vitest';
import {surface3,assembleSurface3} from '../src/three/geometry/surface.js';
import {snapshotSurface3,transformSurface3,cloneSurface3} from '../src/three/geometry/model.js';
import {triangleCorners3} from '../src/three/geometry/corners.js';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {Selection} from '../src/selection.js';
import {mesh,pointCloud} from '../src/three/api/mesh.js';
import {instanceOnPoints} from '../src/three/api/instances.js';
import {surfaceOf} from '../src/three/geometry/value.js';
function pair(){
 const s=surface3([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[2,0,0],[2,1,0]],[[0,1,2,3],[1,4,5,2]]);
 return assembleSurface3(s.points,s.faces.map((f,i)=>({...f,corners:f.corners!.map((c,j)=>({...c,attributes:{uv:([[0,0],[1,0],[1,1],[0,1]][j]).map((v,k)=>v+(k===0?i*10:0)),island:i?'right':'left'}}))})),s.triangles,s);
}
/** `pair()` as a value: two quads that share a side, each with its own uv
 * chart and island at its corners. */
const pairValue=()=>mesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[2,0,0],[2,1,0]],[[0,1,2,3],[1,4,5,2]]).corners.set({
  uv:c=>[[0,0],[1,0],[1,1],[0,1]][c.index%4].map((v,k)=>v+(k===0?Math.floor(c.index/4)*10:0)),
  island:c=>c.index<4?'left':'right',
});
describe('owned polygon corner storage',()=>{
 it('stores independent values at a shared geometric vertex',()=>{
  const s=snapshotSurface3(pair());expect(s.points.length).toBe(6);expect(s.faces.flatMap(f=>f.corners!).length).toBe(8);
  expect(s.faces[0].corners![1].attributes.uv).toEqual([1,0]);expect(s.faces[1].corners![0].attributes.uv).toEqual([10,0]);
  expect(Object.isFrozen(s.faces[0].corners![1].attributes.uv)).toBe(true);
  expect(()=>{(s.faces[0].corners![1].attributes.uv as number[])[0]=99;}).toThrow();
  expect(cloneSurface3(s).faces[0].corners).toEqual(s.faces[0].corners);
 });
 it('keeps corner-to-vertex correspondence under mirrors and fixed nonplanar triangles',()=>{
  const s=pair(),mirrored=transformSurface3(s,{scale:[-2,3,1]});
  expect(mirrored.faces[0].corners!.map(c=>c.id)).toEqual([...s.faces[0].corners!].reverse().map(c=>c.id));
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
  const prototype=mesh(pair()),out=surfaceOf(instanceOnPoints(prototype,pointCloud([[0,0,0],[3,0,0]]).points).realize());
  expect(new Set(out.faces.flatMap(f=>f.corners!.map(c=>c.id))).size).toBe(16);
  expect(out.faces[0].corners!.map(c=>c.attributes.uv)).toEqual(out.faces[2].corners!.map(c=>c.attributes.uv));
  expect(out.faces[2].corners!.every(c=>c.provenance?.operation==='realize')).toBe(true);
 });
 it('rejects missing or duplicate explicit corner identities',()=>{
  const s=pair();
  expect(()=>assembleSurface3(s.points,[{...s.faces[0],corners:[]}],s.triangles.filter(t=>t.face===0))).toThrow('every polygon vertex');
  expect(()=>assembleSurface3(s.points,s.faces.map(f=>({...f,corners:f.corners!.map(c=>({...c,id:'duplicate'}))})),s.triangles)).toThrow('unique');
 });
});

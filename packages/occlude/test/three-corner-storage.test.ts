import {describe,it,expect} from 'vitest';
import {surface3,assembleSurface3} from '../src/three/geometry/surface.js';
import {snapshotSurface3,transformSurface3,cloneSurface3} from '../src/three/geometry/model.js';
import {triangleCorners3} from '../src/three/geometry/corners.js';
import {subdivideSurface} from '../src/three/api/subdivide.js';
import {Mesh,pointCloud} from '../src/three/api/mesh.js';
import {instanceOnPoints} from '../src/three/api/instances.js';
function pair(){
 const s=surface3([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[2,0,0],[2,1,0]],[[0,1,2,3],[1,4,5,2]]);
 return assembleSurface3(s.points,s.faces.map((f,i)=>({...f,corners:f.corners!.map((c,j)=>({...c,attributes:{uv:([[0,0],[1,0],[1,1],[0,1]][j]).map((v,k)=>v+(k===0?i*10:0)),island:i?'right':'left'}}))})),s.triangles,s);
}
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
  const bent=assembleSurface3(s.points.map((p,i)=>({...p,position:[p.position[0],p.position[1],i===2?.5:0] as const})),s.faces,s.triangles,s);
  bent.triangles.forEach((t,i)=>expect(triangleCorners3(bent,i).map(c=>bent.faces[t.face].vertices[c])).toEqual(t.vertices));
 });
 it('interpolates each seam side independently during subdivision',()=>{
  const s=subdivideSurface(pair(),1);expect(s.faces.length).toBe(8);
  const seam=s.points.findIndex(p=>p.position[0]===1&&p.position[1]===.5);expect(seam).toBeGreaterThan(-1);
  const corners=s.faces.flatMap(f=>f.vertices.flatMap((v,i)=>v===seam?[f.corners![i]]:[]));
  expect(corners.map(c=>c.attributes.uv)).toEqual([[1,.5],[1,.5],[10,.5],[10,.5]]);
  expect(new Set(corners.map(c=>c.attributes.island))).toEqual(new Set(['left','right']));
  expect(new Set(s.faces.flatMap(f=>f.corners!.map(c=>c.id))).size).toBe(32);
 });
 it('retains fixed triangle mapping for non-affine corner fields',()=>{
  const source=pair(),f=source.faces[0];f.corners![2].attributes.uv=[2,1];
  const s=assembleSurface3(source.points,[f],[{face:0,vertices:[0,1,2]},{face:0,vertices:[0,2,3]}],source);
  expect(()=>subdivideSurface(s,1,{maxFaces:4})).toThrow('budget');
  const refined=subdivideSurface(s,1,{maxFaces:8});expect(refined.faces.length).toBe(8);
  expect(refined.faces.every(f=>f.vertices.length===3)).toBe(true);
  const center=refined.points.findIndex(p=>p.position[0]===.5&&p.position[1]===.5);
  const samples=refined.faces.flatMap(f=>f.vertices.flatMap((v,i)=>v===center?[f.corners![i].attributes.uv]:[]));
  expect(samples.length).toBeGreaterThan(0);expect(samples.every(uv=>JSON.stringify(uv)==='[1,0.5]')).toBe(true);
  for(const face of refined.faces)for(const c of face.corners!)expect(c.provenance?.parents.length).toBeLessThanOrEqual(2);
 });
 it('namespaces realized corners while preserving their values',()=>{
  const prototype=new Mesh(pair()),out=instanceOnPoints(prototype,pointCloud([[0,0,0],[3,0,0]]).points).realize().surface;
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

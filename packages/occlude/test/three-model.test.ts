import {describe,it,expect} from 'vitest';
import {box3} from '../src/three/geometry/surface.js';
import {mesh} from '../src/three/api/mesh.js';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {measureFaces3,transformSurface3,cloneSurface3,snapshotSurface3} from '../src/three/geometry/model.js';
import {gridSurface,volume} from './helpers/surfaces.js';
describe('procedural surface construction',()=>{
  it('measures faces with their areas, normals and adjacency',()=>{
    const s=gridSurface(3,2,[6,4]);expect(s.points).toHaveLength(12);expect(s.faces).toHaveLength(6);expect(s.triangles).toHaveLength(12);
    const faces=measureFaces3(mesh3(mesh(s)));expect(faces.filter(f=>Math.abs(f.area-4)<1e-12).length).toBe(6);expect(faces.filter(f=>f.normal[2]===1).length).toBe(6);
    expect(faces[0].adjacent).toEqual([1,3]);
  });
  it('applies explicit pivots and keeps mirrored winding outward',()=>{
    const s=box3([2,2,2]),out=transformSurface3(s,{scale:[-2,3,4],rotate:[30,20,10],translate:[4,5,6]});
    expect(volume(out)).toBeCloseTo(8*24,9);expect(out.faces.map(f=>f.id)).toEqual(s.faces.map(f=>f.id));
    const translated=transformSurface3(s,{translate:[1,2,3]});expect(translated.points[0].position).toEqual([0,1,2]);
    // A singular scale flattens the surface rather than failing.
    expect(transformSurface3(s,{scale:[0,1,1]}).points.every(p=>p.position[0]===0)).toBe(true);
  });
  it('freezes a snapshot and leaves its source editable',()=>{
    const s=gridSurface(1,1),input=snapshotSurface3(cloneSurface3(s));
    expect(()=>{input.points[0].position=[9,9,9];}).toThrow();
    expect(s.points[0].position[2]).toBe(0);
  });
});

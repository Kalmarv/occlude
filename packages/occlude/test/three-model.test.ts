import {describe,it,expect} from 'vitest';
import {box} from '../src/three/api/mesh.js';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {measureFaces3} from '../src/three/geometry/model.js';
import {gridMesh,volume} from './helpers/surfaces.js';
describe('procedural surface construction',()=>{
  it('measures faces with their areas, normals and adjacency',()=>{
    const m=gridMesh(3,2,[6,4]);expect(m.points).toHaveLength(12);expect(m.faces).toHaveLength(6);expect(mesh3(m).triangleCount).toBe(12);
    const faces=measureFaces3(mesh3(m));expect(faces.filter(f=>Math.abs(f.area-4)<1e-12).length).toBe(6);expect(faces.filter(f=>f.normal[2]===1).length).toBe(6);
    expect(faces[0].adjacent).toEqual([1,3]);
  });
  it('applies explicit pivots and keeps mirrored winding outward',()=>{
    const s=box([2,2,2]),out=s.scale([-2,3,4]).rotate([30,20,10]).translate([4,5,6]);
    expect(volume(out)).toBeCloseTo(8*24,9);expect(mesh3(out).names.faces).toEqual(mesh3(s).names.faces);
    const translated=s.translate([1,2,3]),p=translated.points.at(0)!;expect([p.x,p.y,p.z]).toEqual([0,1,2]);
    // A singular scale is nothing to draw rather than a failure.
    const flat=s.scale([0,1,1]);expect(flat.faces).toHaveLength(0);expect(flat.edges).toHaveLength(0);
  });
  it('leaves the value it moved as it was',()=>{
    const m=gridMesh(1,1),moved=m.translate([9,9,9]),at=(v:typeof m)=>{const p=v.points.at(0)!;return [p.x,p.y,p.z];};
    expect(at(moved)).toEqual([8.5,8.5,9]);
    expect(at(m)).toEqual([-0.5,-0.5,0]);
  });
});

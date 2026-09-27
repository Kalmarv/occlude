import {describe,it,expect} from 'vitest';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {mesh,plane} from 'occlude/3d';
import {surfaceLocation3} from '../src/three/geometry/location.js';

// A projection of your own is a corner write: `corners.set({ uv, chart })`
// reads each corner's point, so there is no separate projection helper.
describe('stored UV projections written as corner columns',()=>{
  it('stores an oblique planar frame and keeps it through later moves',()=>{
    // p = origin + u * [2,0,0] + v * [1,3,0], with an independent normal offset.
    const planar=(c:{point:{x:number;y:number}})=>{const v=(c.point.y-7)/3;return [(c.point.x-5-v)/2,v] as const;};
    const source=mesh([[5,7,9],[7,7,9],[8,10,9],[6,10,9]],[[0,1,2,3]])
      .corners.set({ink:2});
    const mapped=source.corners.set({uv:planar,chart:'oblique'});
    expect(mapped.corners.map(c=>c.uv)).toEqual([[0,0],[1,0],[1,1],[0,1]]);
    expect(mapped.corners.every(c=>c.ink===2&&c.chart==='oblique')).toBe(true);
    const moved=mapped.displace(p=>[0,0,p.x]).translate([2,0,0]);
    expect(moved.corners.map(c=>c.uv)).toEqual(mapped.corners.map(c=>c.uv));
    const projectedAgain=moved.corners.set({uv:planar});
    expect(projectedAgain.corners.map(c=>c.uv)).toEqual([[1,0],[2,0],[2,1],[1,1]]);
  });
  it('keeps degenerate projections explicit',()=>{
    const edgeOn=plane().rotate([90,0,0]).corners.set({uv:c=>[c.point.x,c.point.z] as const,chart:'planar'});
    expect(surfaceLocation3(mesh3(edgeOn),0,[1,0,0]).chartStatus).toBe('regular');
    const flat=mesh([[0,0,0],[1,0,0],[1,0,1]],[[0,1,2]]).corners.set({uv:c=>[c.point.x,c.point.y] as const,chart:'planar'});
    expect(surfaceLocation3(mesh3(flat),0,[1,0,0]).chartStatus).toBe('degenerate');
  });
});

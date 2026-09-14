import {describe,it,expect,expectTypeOf} from 'vitest';
import {mesh,plane,cylinder,planarUV,cylindricalUV} from 'occlude/3d';
import {surfaceLocation3} from '../src/three/geometry/location.js';

describe('explicit stored UV projections',()=>{
  it('solves an oblique planar frame and retains unrelated typed columns',()=>{
    // p = origin + u * [2,0,0] + v * [1,3,0], with an independent normal offset.
    const source=mesh([[5,7,9],[7,7,9],[8,10,9],[6,10,9]],[[0,1,2,3]])
      .cornerAttributes({ink:2,uv:[99,99] as const},{transfer:{ink:'nearest',uv:'nearest'}});
    const mapped=planarUV(source,{origin:[5,7,0],u:[2,0,0],v:[1,3,0],chart:'oblique'});
    expect(mapped.corners.map(c=>c.uv)).toEqual([[0,0],[1,0],[1,1],[0,1]]);
    expect(mapped.corners.every(c=>c.ink===2&&c.chart==='oblique')).toBe(true);
    expectTypeOf(mapped.corners.at(0)!.uv).toEqualTypeOf<readonly [number,number]>();
    expect(mapped.cornerTransfers).toEqual({ink:'nearest',uv:'interpolate',chart:'nearest'});
    expect(source.corners.every(c=>c.uv[0]===99)).toBe(true);
    const moved=mapped.displace(p=>[0,0,p.x]).translate([2,0,0]);
    expect(moved.corners.map(c=>c.uv)).toEqual(mapped.corners.map(c=>c.uv));
    const projectedAgain=planarUV(moved,{origin:[5,7,0],u:[2,0,0],v:[1,3,0]});
    expect(projectedAgain.corners.map(c=>c.uv)).toEqual([[1,0],[2,0],[2,1],[1,1]]);
  });
  it('unwraps a cylinder seam with the same physical rim and user-defined axis',()=>{
    const original=cylinder(1,4,{segments:8,caps:false}).rotate([0,90,0]).translate([3,2,1]);
    const projected=cylindricalUV(original,{origin:[1,2,1],axis:[1,0,0],seam:[0,0,-1],height:4});
    expect(projected.points.length).toBe(16);expect(projected.surface.triangles).toEqual(original.surface.triangles);
    for(const f of projected.faces()){
      const uv=f.corners.map(c=>c.uv),angles=uv.map(p=>p[0]);
      expect(Math.max(...angles)-Math.min(...angles)).toBeCloseTo(1/8,12);
      for(const v of uv)expect(v[1]).toBeCloseTo(v[1]<.5?0:1,12);
    }
    for(let i=0;i<projected.surface.triangles.length;i++)expect(surfaceLocation3(projected.surface,i,[.2,.3,.5]).chartStatus).toBe('regular');
  });
  it('places an axis tip in its local angular sector without inventing geometry',()=>{
    const source=mesh([[1,-1,0],[1,1,0],[0,0,2]],[[0,1,2]]);
    const mapped=cylindricalUV(source,{height:2});
    expect(mapped.corners.map(c=>c.uv)).toEqual([[.875,0],[1.125,0],[1,1]]);
    expect(mapped.points.length).toBe(3);
    expect(surfaceLocation3(mapped.surface,0,[0,0,1]).chartStatus).toBe('regular');
  });
  it('keeps degenerate projections explicit and rejects undefined cylindrical charts',()=>{
    const edgeOn=planarUV(plane().rotate([90,0,0]),{u:[1,0,0],v:[0,0,1]});
    expect(surfaceLocation3(edgeOn.surface,0,[1,0,0]).chartStatus).toBe('regular');
    const flat=planarUV(mesh([[0,0,0],[1,0,0],[1,0,1]],[[0,1,2]]));
    expect(surfaceLocation3(flat.surface,0,[1,0,0]).chartStatus).toBe('degenerate');
    expect(()=>planarUV(plane(),{u:[1,0,0],v:[2,0,0]})).toThrow('independent');
    expect(()=>cylindricalUV(cylinder())).toThrow('separate planar cap chart');
    expect(()=>cylindricalUV(plane(),{height:0})).toThrow('height');
    expect(()=>cylindricalUV(plane(),{axis:[0,0,0]})).toThrow();
    expect(()=>cylindricalUV(plane(),{seam:[0,0,1]})).toThrow();
  });
});

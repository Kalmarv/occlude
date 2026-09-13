import {describe,it,expect} from 'vitest';
import {SurfaceQueries3,nearestTriangle3,rayTriangle3} from '../src/three/queries/surface.js';
import {box3,surface3} from '../src/three/geometry/surface.js';
import {grid3,transformSurface3} from '../src/three/geometry/model.js';
describe('prepared batched surface queries',()=>{
  it('hits both sides, clips segment parameters, and retains face metadata',()=>{
    const source=box3([2,2,2]),query=new SurfaceQueries3(source);
    const hits=query.rays([{origin:[0,0,5],direction:[0,0,-2]},{origin:[0,0,0],direction:[0,0,1]}]);
    expect(hits[0]!.distance).toBe(2);expect(hits[0]!.point).toEqual([0,0,1]);expect(hits[1]!.distance).toBe(1);expect(hits[0]!.faceId).toBe('f1');
    expect(query.segments([[[0,0,5],[0,0,2]]])[0]).toBeNull();expect(query.segments([[[0,0,5],[0,0,1]]])[0]!.distance).toBe(1);
    expect(query.rays([{origin:[3,0,5],direction:[0,0,-1]}])[0]).toBeNull();
    source.points[0].position=[999,999,999];expect(query.rays([{origin:[0,0,5],direction:[0,0,-2]}])[0]).toEqual(hits[0]);
  });
  it('finds face, edge and vertex nearest points with distance bounds',()=>{
    const query=new SurfaceQueries3(surface3([[0,0,0],[2,0,0],[0,2,0]],[[0,1,2]]));
    const hits=query.nearest([{point:[.5,.5,3]},{point:[2,2,0]},{point:[-1,-1,0]},{point:[0,0,3],maxDistance:2}]);
    expect(hits[0]!.point).toEqual([.5,.5,0]);expect(hits[0]!.distance).toBe(3);expect(hits[0]!.barycentric).toEqual([.5,.25,.25]);
    expect(hits[1]!.point).toEqual([1,1,0]);expect(hits[2]!.point).toEqual([0,0,0]);expect(hits[3]).toBeNull();
    expect(query.rays([{origin:[.5,.5,0],direction:[1,0,0]}])[0]).toBeNull();
  });
  it('matches all triangles for rotated geometry and deterministic ties',()=>{
    const query=new SurfaceQueries3(transformSurface3(grid3(12,9,[8,6]),{rotate:[15,30,5],translate:[1,2,3]}));
    for(let i=0;i<100;i++){
      const point=[Math.sin(i)*6,Math.cos(i)*5,4] as const,q={point};
      const expected=query.triangles.map((t,triangle)=>({triangle,...nearestTriangle3(t,point)})).sort((a,b)=>a.distance-b.distance||a.triangle-b.triangle)[0],actual=query.nearest([q])[0]!;
      expect(actual.triangle).toBe(expected.triangle);expect(actual.distance).toBe(expected.distance);
      const ray={origin:point,direction:[0,0,-1] as const},all=query.triangles.flatMap((t,triangle)=>{const h=rayTriangle3(t,ray);return h?[{triangle,...h}]:[]}).sort((a,b)=>a.distance-b.distance||a.triangle-b.triangle);
      expect(query.rays([ray])[0]?.triangle??null).toBe(all[0]?.triangle??null);
    }
  });
  it('handles empty inputs and validates invalid queries',()=>{
    const empty=new SurfaceQueries3(surface3([],[]));expect(empty.rays([{origin:[0,0,0],direction:[0,0,1]}])).toEqual([null]);expect(empty.nearest([{point:[0,0,0]}])).toEqual([null]);
    expect(()=>empty.rays([{origin:[0,0,0],direction:[0,0,0]}])).toThrow(/direction/);expect(()=>empty.nearest([{point:[0,0,0],maxDistance:-1}])).toThrow(/distance/);
  });
});

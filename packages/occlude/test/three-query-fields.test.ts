import {describe,it,expect,expectTypeOf} from 'vitest';
import {plane,pointCloud,query} from 'occlude/3d';
import {prepareSurfaceQueries3} from '../src/three/queries/surface.js';
import type {QueryHost} from '../src/three/api/query.js';

describe('captured source-bound query fields',()=>{
  it('preserves misses, source selections and typed extraction',()=>{
    const source=pointCloud([[0,0,1],[4,0,1],[.5,0,2]]).attribute('name',p=>`point-${p.index}`);
    const hits=query(plane(2).faceAttribute('roof',true)).batch().rays(source.points,{direction:[0,0,-1]});
    const distance=hits.field((point,hit)=>hit?hit.distance:point.x+10);
    expect(source.points.map(distance)).toEqual([1,14,2]);
    const near=hits.sources((point,hit)=>!!hit&&hit.distance<2&&point.name==='point-0');
    expect(near.source).toBe(source.surface);expect(near.map(p=>p.index)).toEqual([0]);
    expect(near.extract().points.at(0)!.name).toBe('point-0');
    expectTypeOf(near.at(0)!.name).toEqualTypeOf<`point-${number}`>();
    expectTypeOf(hits[0].hit!.face.roof).toEqualTypeOf<true>();
    expect(hits.sources((_,hit)=>hit===null).map(p=>p.index)).toEqual([1]);
    expect(hits.source.indices).toEqual([0,1,2]);
    expect(hits.map(r=>r.source)).toEqual([...source.points]);
    expect(Object.isFrozen(hits)).toBe(true);
  });
  it('rejects new revisions, copied rows, and unqueried rows with the same source',()=>{
    const source=plane(2).translate([0,0,1]),hits=query(plane(4)).batch().nearest(source.points.filter(p=>p.index===0));
    const field=hits.field((_,hit)=>hit!.distance);
    expect(field(source.points.at(0)!)).toBe(1);
    expect(()=>field(source.points.at(1)!)).toThrow('queried row');
    expect(()=>field({...source.points.at(0)!})).toThrow('captured source revision');
    expect(()=>source.translate([0,0,1]).attribute('distance',field)).toThrow('captured source revision');
    expect(()=>source.attribute('label',0).attribute('distance',field)).toThrow('captured source revision');
  });
  it('captures query attributes before an intentional deformation',()=>{
    const source=plane().translate([0,0,2]);
    const hits=query(plane(4)).batch().nearest(source.points);
    const captured=source.attribute('restDistance',hits.field((_,hit)=>hit!.distance));
    const moved=captured.displace(p=>[0,0,p.restDistance]);
    expect(moved.points.map(p=>[p.z,p.restDistance])).toEqual([[4,2],[4,2],[4,2],[4,2]]);
    expect(query(plane(4)).batch().nearest(moved.points).map(r=>r.hit!.distance)).toEqual([4,4,4,4]);
  });
  it('does not dispatch new GPU queries while fields and source selections are consumed',async()=>{
    let calls=0;
    const host:QueryHost={async querySurface3(surface,input){calls++;const prepared=prepareSurfaceQueries3(surface);return {nearest:prepared.nearest(input.nearest??[]),rays:prepared.rays(input.rays??[]),segments:prepared.segments(input.segments??[])};}};
    const points=pointCloud([[0,0,1],[3,0,1]]),batch=query(plane(2)).batch(host);
    for(const hits of [await batch.nearest(points.points,{within:1.5}),await batch.rays(points.points,{direction:[0,0,-1]}),await batch.segments(points.points,{to:p=>[p.x,p.y,0]})]){
      expect(points.points.map(hits.field((_,hit)=>hit?.distance??-1))).toEqual([1,-1]);
      expect(hits.sources((_,hit)=>hit!==null).length).toBe(1);
      expect(points.points.map(hits.field((_,hit)=>hit!==null))).toEqual([true,false]);
    }
    expect(calls).toBe(3);
  });
  it('keeps empty results empty and adapts exact zero-length contact results',()=>{
    const source=pointCloud([[0,0,0],[0,0,1]]),batch=query(plane()).batch();
    const empty=batch.nearest(source.points.filter(()=>false));
    expect(empty).toEqual([]);expect(empty.sources(()=>true).length).toBe(0);
    const hits=batch.segments(source.points,{to:p=>p});
    expect(source.points.map(hits.field((_,hit)=>hit?.t??null))).toEqual([0,null]);
  });
});

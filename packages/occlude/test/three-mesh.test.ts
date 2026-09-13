import { describe, expect, it } from 'vitest';
import { surface3, box3 } from '../src/three/geometry/surface.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { cross3, sub3, type Vec3 } from '../src/three/math.js';
import { featureSnapshot3, FeatureKind3 } from '../src/three/features/snapshot.js';
import { candidatePairs3, classifySceneCpu3, classifySceneGpu3 } from '../src/three/visibility/scene.js';
import { hiddenInterval3, unionIntervals3 } from '../src/three/visibility/interval.js';
import type { GpuIntervals3 } from '../src/compute/webgpu/interval.js';

const frame = (perspective = false) => cameraFrame3({ ...(perspective ? {kind:'perspective' as const,fovDegrees:60} : {kind:'orthographic' as const,span:6}), eye:[4,-6,4],target:[0,0,0],near:.1,far:100 },{x:10,y:20,width:180,height:120});

describe('polygon surfaces and topology features', () => {
  it('keeps box polygons, real edges, triangle parentage and multi-flags', () => {
    const box=box3();expect(box.points).toHaveLength(8);expect(box.faces).toHaveLength(6);expect(box.triangles).toHaveLength(12);expect(box.edges).toHaveLength(12);
    box.edges[0].attributes.marked=true;
    const snapshot=featureSnapshot3([{id:'box',surface:box}],[],frame());
    expect(snapshot.features).toHaveLength(12);
    expect(snapshot.features.filter(f=>f.flags&FeatureKind3.boundary)).toHaveLength(0);
    expect(snapshot.features.filter(f=>f.flags&FeatureKind3.silhouette)).toHaveLength(6);
    expect(snapshot.features.every(f=>Math.abs(f.creaseAngle-90)<1e-10)).toBe(true);
    const marked=snapshot.features.find(f=>f.flags&FeatureKind3.marked)!;expect(marked.flags&FeatureKind3.crease).toBeTruthy();
    expect(snapshot.features.every(f=>f.support.length===4)).toBe(true);
    const drawing=classifySceneCpu3(snapshot);
    expect(drawing.features.filter(f=>f.hidden.length>0)).toHaveLength(3);
    expect(drawing.features.filter(f=>f.visible.length>0)).toHaveLength(9);
  });
  it('triangulates a concave polygon without a fan crossing its notch', () => {
    const shape=surface3([[0,0,0],[3,0,0],[3,1,0],[1,1,0],[1,3,0],[0,3,0]],[[0,1,2,3,4,5]]);
    const area=shape.triangles.reduce((a,t)=>{const p=t.vertices.map(v=>shape.points[v].position);return a+Math.hypot(...cross3(sub3(p[1],p[0]),sub3(p[2],p[0])))/2},0);
    expect(area).toBeCloseTo(5,12);expect(shape.triangles).toHaveLength(4);
    expect(featureSnapshot3([{id:'L',surface:shape}],[],frame()).features).toHaveLength(6);
  });
  it('rejects ambiguous topology and nonplanar construction, then preserves triangulation through deformation', () => {
    expect(()=>surface3([[0,0,0],[1,1,0],[0,1,0],[1,0,0]],[[0,1,2,3]])).toThrow();
    expect(()=>surface3([[0,0,0],[1,0,0],[1,1,1],[0,1,0]],[[0,1,2,3]])).toThrow(/planar/);
    expect(()=>surface3([[0,0,0],[1,0,0],[0,1,0],[0,-1,0]],[[0,1,2],[0,1,3]])).toThrow(/winding/);
    const shape=surface3([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],[[0,1,2,3]]);
    const triangles=shape.triangles.map(t=>[...t.vertices]);shape.points[0].position=[-1,-1,4];
    const side=cameraFrame3({kind:'orthographic',span:8,eye:[4,0,1],target:[0,0,1],near:.1,far:100},{x:0,y:0,width:100,height:100});
    const snapshot=featureSnapshot3([{id:'fold',surface:shape}],[],side);
    expect(shape.triangles.map(t=>t.vertices)).toEqual(triangles);
    const diagonal=snapshot.features.filter(f=>!(f.flags&FeatureKind3.boundary));
    expect(diagonal).toHaveLength(1);expect(diagonal[0].flags).toBe(FeatureKind3.silhouette);expect(diagonal[0].faceAttributes).toHaveLength(1);
  });
  it('captures positions and both incident face attributes without aliasing', () => {
    const box=box3();box.faces[0].attributes.group='base';box.edges[0].attributes.weights=[1,2];
    const snapshot=featureSnapshot3([{id:'object',surface:box,attributes:{group:'forms'}}],[],frame());
    const before=JSON.stringify(snapshot.features);box.points[0].position=[999,999,999];box.faces[0].attributes.group='edited';(box.edges[0].attributes.weights as number[])[0]=9;
    expect(JSON.stringify(snapshot.features)).toBe(before);
  });
});

describe('conservative indexed scene visibility', () => {
  for(const perspective of [false,true]) it(`matches all-pairs on overlap, near clipping and thin occluders (${perspective})`, () => {
    const objects=Array.from({length:10},(_,i)=>({id:`box${i}`,surface:box3([.03+i/15,1,1],[Math.sin(i),Math.cos(i),i/10])}));
    const wires=Array.from({length:12},(_,i)=>({id:`wire${i}`,points:[[-3,Math.sin(i)*2,0],[3,Math.cos(i)*2,2]] as Vec3[]}));
    const snapshot=featureSnapshot3(objects,wires,frame(perspective)), indexed=classifySceneCpu3(snapshot);
    snapshot.features.forEach((feature,i)=>{
      const hidden=snapshot.occluders.flatMap(o=>{if(feature.support.includes(o.id))return [];const interval=hiddenInterval3(feature.a,feature.b,o.volume);return interval?[interval]:[]});
      expect(indexed.features[i].hidden).toEqual(unionIntervals3(hidden));
    });
    expect(indexed.stats.candidates).toBeLessThan(snapshot.features.length*snapshot.occluders.length/2);
  });
  it('preserves occluders excluded from line generation and source-only surfaces', () => {
    const front=surface3([[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],[[0,1,2,3]]);
    const camera=cameraFrame3({kind:'orthographic',span:4,eye:[0,0,5],target:[0,0,0],up:[0,1,0],near:1,far:10},{x:0,y:0,width:100,height:100});
    const wire={id:'wire',points:[[-2,0,0],[2,0,0]] as Vec3[]};
    const snapshot=featureSnapshot3([{id:'front',surface:front,lineSource:false}],[wire],camera);
    expect(snapshot.features).toHaveLength(1);expect(classifySceneCpu3(snapshot).features[0].hidden).toEqual([[.25,.75]]);
    expect(classifySceneCpu3(featureSnapshot3([{id:'front',surface:front,occluder:false}],[wire],camera)).features.at(-1)!.hidden).toEqual([]);
    expect(()=>featureSnapshot3([{id:'wire',surface:front}],[wire],camera)).toThrow(/unique/);
  });
  it('clips a near-plane triangle before indexing and keeps geometry outside the page', () => {
    const camera=cameraFrame3({kind:'perspective',fovDegrees:60,eye:[0,0,0],target:[0,0,-1],up:[0,1,0],near:1,far:10},{x:0,y:0,width:100,height:100});
    const face=surface3([[-2,-1,-.5],[2,-1,-2],[0,2,-2]],[[0,1,2]]);
    const snapshot=featureSnapshot3([{id:'cut',surface:face}],[{id:'outside',points:[[20,0,-2],[21,0,-2]]}],camera);
    expect(snapshot.triangles).toHaveLength(2);expect(snapshot.features.some(f=>f.objectId==='outside')).toBe(true);
    expect([...candidatePairs3(snapshot)].every(p=>p.pair.a[2]<=-1 && p.pair.b[2]<=-1)).toBe(true);
  });
  it('refines uncertain interval unions across batches without filling real gaps', async () => {
    const camera=cameraFrame3({kind:'orthographic',span:4,eye:[0,0,5],target:[0,0,0],up:[0,1,0],near:1,far:10},{x:0,y:0,width:100,height:100});
    for (const gap of [0,1e-7]) {
      const left=surface3([[-1,-1,1],[-gap,-1,1],[-gap,1,1],[-1,1,1]],[[0,1,2,3]]);
      const right=surface3([[gap,-1,1],[1,-1,1],[1,1,1],[gap,1,1]],[[0,1,2,3]]);
      const snapshot=featureSnapshot3([{id:'left',surface:left,lineSource:false},{id:'right',surface:right,lineSource:false}],[{id:'wire',points:[[-2,0,0],[2,0,0]]}],camera);
      const approximate={classify:async(pairs:any[])=>({intervals:pairs.map(p=>{const r=hiddenInterval3(p.a,p.b,p.volume);return r?[r[0]+1e-8,r[1]-1e-8]:null}),dispatches:1,refinements:0,transferBytes:0})} as unknown as GpuIntervals3;
      const result=await classifySceneGpu3(snapshot,approximate,{pairCapacity:1});
      expect(result.features[0].hidden).toEqual(classifySceneCpu3(snapshot).features[0].hidden);
      expect(result.features[0].hidden).toHaveLength(gap===0?1:2);
      expect(result.stats.refinements).toBeGreaterThan(0);
    }
  });
  it('handles an empty scene and capacity errors without dropping pairs', async () => {
    const empty=featureSnapshot3([],[],frame());expect(classifySceneCpu3(empty).features).toEqual([]);
    const scene=featureSnapshot3([{id:'box',surface:box3()}],[],frame());
    const noGpu={classify:()=>{throw new Error('must not dispatch')}} as unknown as GpuIntervals3;
    await expect(classifySceneGpu3(scene,noGpu,{maxCandidates:0})).rejects.toThrow(/candidate pairs/);
    await expect(classifySceneGpu3(scene,noGpu,{pairCapacity:0})).rejects.toThrow(/capacity/);
    expect((await classifySceneGpu3(empty,noGpu)).stats.dispatches).toBe(0);
  });
});

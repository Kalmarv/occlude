import { describe, expect, it } from 'vitest';
import { box, mesh } from '../src/three/api/index.js';
import { gridMesh } from './helpers/surfaces.js';
import { mesh3 } from '../src/three/geometry/mesh3.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { cross3, sub3, type Vec3 } from '../src/three/math.js';
import { featureSnapshot3, FeatureKind3 } from '../src/three/features/snapshot.js';
import { candidatePairs3, classifySceneCpu3, classifySceneGpu3 } from '../src/three/visibility/scene.js';
import { hiddenInterval3, unionIntervals3 } from '../src/three/visibility/interval.js';
import type { GpuIntervals3 } from '../src/compute/webgpu/interval.js';

/** A box of `size` about `center`, as the advanced stage's scenes place one. */
const boxAt = (size: Vec3 = [1, 1, 1], center: Vec3 = [0, 0, 0]) => box(size).translate(center);
const frame = (perspective = false) => cameraFrame3({ ...(perspective ? {kind:'perspective' as const,fovDegrees:60} : {kind:'orthographic' as const,span:6}), eye:[4,-6,4],target:[0,0,0],near:.1,far:100 },{x:10,y:20,width:180,height:120});

describe('polygon surfaces and topology features', () => {
  it('keeps flat relief ground edges crease-free across camera views', () => {
    const sheet = gridMesh(6, 6, [4, 4]);
    const surface = sheet.extrude(sheet.faces.filter(f => f.index % 6 % 2 === 0 && Math.floor(f.index / 6) % 2 === 0), { distance: 1 }, { key: 'ground-regression' });
    // A feature's source is its edge's kernel name: the ground edges by name.
    const read = mesh3(surface);
    const ground = new Set(read.names.edges.filter((_, e) => read.edgeFaces[e].length === 2 && read.edgeFaces[e].every(f =>
      read.loops[f].every(v => read.z[v] === 0))));
    expect(ground.size).toBe(30);
    for (const eye of [[5, 7, 6], [-3, 5, 8]] as const) {
      const camera = cameraFrame3({ kind: 'orthographic', span: 5.5, eye, target: [0, 0, 0.4], near: 0.1, far: 30 }, { x: 0, y: 0, width: 200, height: 200 });
      const features = featureSnapshot3([{ id: 'relief', surface }], [], camera).features;
      for (const f of features.filter(f => ground.has(f.sourceId))) {
        expect(f.creaseAngle).toBe(0);
        expect(f.flags & FeatureKind3.crease).toBe(0);
      }
      expect(features.some(f => f.creaseAngle === 90)).toBe(true);
    }
  });
  it('retains a real shallow fold and its angle independently of camera', () => {
    const surface = mesh([[0,0,0],[1,0,0],[0,1,0],[0,-1,1e-10]], [[0,1,2],[1,0,3]]);
    const angles = [frame(), frame(true)].map(camera => {
      const edge = featureSnapshot3([{ id: 'fold', surface }], [], camera).features.find(f => !(f.flags & FeatureKind3.boundary))!;
      expect(edge.flags & FeatureKind3.crease).toBeTruthy();
      expect(edge.creaseAngle).toBeGreaterThan(0);
      expect(edge.creaseAngle).toBeCloseTo(Math.atan(1e-10) * 180 / Math.PI, 16);
      return edge.creaseAngle;
    });
    expect(angles[0]).toBe(angles[1]);
  });

  it('keeps box polygons, real edges, triangle parentage and multi-flags', () => {
    const box=boxAt().edges.set('marked',true,e=>e.index===0);expect(box.points).toHaveLength(8);expect(box.faces).toHaveLength(6);expect(mesh3(box).triangleCount).toBe(12);expect(box.edges).toHaveLength(12);
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
    const shape=mesh([[0,0,0],[3,0,0],[3,1,0],[1,1,0],[1,3,0],[0,3,0]],[[0,1,2,3,4,5]]),read=mesh3(shape);
    let area=0;for(let t=0;t<read.triangleCount;t++){const p=read.triangle(t).map(v=>read.positions[v]);area+=Math.hypot(...cross3(sub3(p[1],p[0]),sub3(p[2],p[0])))/2;}
    expect(area).toBeCloseTo(5,12);expect(read.triangleCount).toBe(4);
    expect(featureSnapshot3([{id:'L',surface:shape}],[],frame()).features).toHaveLength(6);
  });
  it('rejects ambiguous topology and nonplanar construction, then preserves triangulation through deformation', () => {
    // A polygon with no usable plane keeps its place in the face order and
    // contributes no triangles; a nonplanar one becomes its own triangles.
    const bowtie=mesh([[0,0,0],[1,1,0],[0,1,0],[1,0,0]],[[0,1,2,3]]);
    expect(bowtie.faces.length).toBe(1);expect(mesh3(bowtie).triangleCount).toBe(0);
    // Beside a face that draws, it draws nothing and the view keeps rendering.
    const beside=mesh([[0,0,0],[1,1,0],[0,1,0],[1,0,0],[3,0,0],[4,0,0],[4,1,0]],[[0,1,2,3],[4,5,6]]);
    expect(featureSnapshot3([{id:'beside',surface:beside}],[],frame()).features).toHaveLength(3);
    expect(mesh3(mesh([[0,0,0],[1,0,0],[1,1,1],[0,1,0]],[[0,1,2,3]])).triangleCount).toBe(2);
    expect(()=>mesh([[0,0,0],[1,0,0],[0,1,0],[0,-1,0]],[[0,1,2],[0,1,3]])).toThrow(/winding/);
    const flat=mesh([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],[[0,1,2,3]]);
    const shape=flat.points.set('z',4,p=>p.index===0);
    const side=cameraFrame3({kind:'orthographic',span:8,eye:[4,0,1],target:[0,0,1],near:.1,far:100},{x:0,y:0,width:100,height:100});
    const snapshot=featureSnapshot3([{id:'fold',surface:shape}],[],side);
    expect([...mesh3(shape).triangles]).toEqual([...mesh3(flat).triangles]);
    const diagonal=snapshot.features.filter(f=>!(f.flags&FeatureKind3.boundary));
    expect(diagonal).toHaveLength(1);expect(diagonal[0].flags).toBe(FeatureKind3.silhouette);expect(diagonal[0].faceAttributes).toHaveLength(1);
  });
  it('captures edge columns and both incident face columns as frozen records', () => {
    const box=boxAt().faces.set('group','base',f=>f.index===0).edges.set('weights',[1,2],e=>e.index===0);
    const snapshot=featureSnapshot3([{id:'object',surface:box,attributes:{group:'forms'}}],[],frame());
    const edge=snapshot.features.find(f=>(f.attributes.weights as readonly number[])[0]===1)!;
    expect(edge.attributes).toMatchObject({group:'forms',weights:[1,2]});
    expect(edge.faceAttributes.map(a=>a.group)).toEqual(['base','']);
    expect(Object.isFrozen(edge.attributes)&&Object.isFrozen(edge.attributes.weights)&&edge.faceAttributes.every(Object.isFrozen)).toBe(true);
  });
});

describe('conservative indexed scene visibility', () => {
  for(const perspective of [false,true]) it(`matches all-pairs on overlap, near clipping and thin occluders (${perspective})`, () => {
    const objects=Array.from({length:10},(_,i)=>({id:`box${i}`,surface:boxAt([.03+i/15,1,1],[Math.sin(i),Math.cos(i),i/10])}));
    const wires=Array.from({length:12},(_,i)=>({id:`wire${i}`,points:[[-3,Math.sin(i)*2,0],[3,Math.cos(i)*2,2]] as Vec3[]}));
    const snapshot=featureSnapshot3(objects,wires,frame(perspective)), indexed=classifySceneCpu3(snapshot);
    snapshot.features.forEach((feature,i)=>{
      const hidden=snapshot.occluders.flatMap(o=>{if(feature.support.includes(o.id))return [];const interval=hiddenInterval3(feature.a,feature.b,o.volume,feature.basis);return interval?[interval]:[]});
      expect(indexed.features[i].hidden).toEqual(unionIntervals3(hidden));
    });
    expect(indexed.stats.candidates).toBeLessThan(snapshot.features.length*snapshot.occluders.length/2);
  });
  it('preserves occluders excluded from line generation and source-only surfaces', () => {
    const front=mesh([[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],[[0,1,2,3]]);
    const camera=cameraFrame3({kind:'orthographic',span:4,eye:[0,0,5],target:[0,0,0],up:[0,1,0],near:1,far:10},{x:0,y:0,width:100,height:100});
    const wire={id:'wire',points:[[-2,0,0],[2,0,0]] as Vec3[]};
    const snapshot=featureSnapshot3([{id:'front',surface:front,lineSource:false}],[wire],camera);
    expect(snapshot.features).toHaveLength(1);expect(classifySceneCpu3(snapshot).features[0].hidden).toEqual([[.25,.75]]);
    expect(classifySceneCpu3(featureSnapshot3([{id:'front',surface:front,occluder:false}],[wire],camera)).features.at(-1)!.hidden).toEqual([]);
    expect(()=>featureSnapshot3([{id:'wire',surface:front}],[wire],camera)).toThrow(/unique/);
  });
  it('clips a near-plane triangle before indexing and keeps geometry outside the page', () => {
    const camera=cameraFrame3({kind:'perspective',fovDegrees:60,eye:[0,0,0],target:[0,0,-1],up:[0,1,0],near:1,far:10},{x:0,y:0,width:100,height:100});
    const face=mesh([[-2,-1,-.5],[2,-1,-2],[0,2,-2]],[[0,1,2]]);
    const snapshot=featureSnapshot3([{id:'cut',surface:face}],[{id:'outside',points:[[20,0,-2],[21,0,-2]]}],camera);
    expect(snapshot.triangles).toHaveLength(2);expect(snapshot.features.some(f=>f.objectId==='outside')).toBe(true);
    expect([...candidatePairs3(snapshot)].every(p=>p.pair.a[2]<=-1 && p.pair.b[2]<=-1)).toBe(true);
  });
  it('refines uncertain interval unions across batches without filling real gaps', async () => {
    const camera=cameraFrame3({kind:'orthographic',span:4,eye:[0,0,5],target:[0,0,0],up:[0,1,0],near:1,far:10},{x:0,y:0,width:100,height:100});
    for (const gap of [0,1e-7]) {
      const left=mesh([[-1,-1,1],[-gap,-1,1],[-gap,1,1],[-1,1,1]],[[0,1,2,3]]);
      const right=mesh([[gap,-1,1],[1,-1,1],[1,1,1],[gap,1,1]],[[0,1,2,3]]);
      const snapshot=featureSnapshot3([{id:'left',surface:left,lineSource:false},{id:'right',surface:right,lineSource:false}],[{id:'wire',points:[[-2,0,0],[2,0,0]]}],camera);
      const approximate={classify:async(pairs:any[])=>({intervals:pairs.map(p=>{const r=hiddenInterval3(p.a,p.b,p.volume);return r?[r[0]+1e-8,r[1]-1e-8]:null}),dispatches:1,refinements:0,transferBytes:0})} as unknown as GpuIntervals3;
      const result=await classifySceneGpu3(snapshot,approximate,{pairCapacity:1}),exact=classifySceneCpu3(snapshot).features[0].hidden;
      // Each quad's two triangles abut at their diagonal: watertight, closed
      // without refinement, so their outer ends keep the f32 offset within the
      // tolerance. The left/right junction is between objects and is refined
      // exactly: a 1e-7 gap survives, a zero gap does not.
      expect(result.features[0].hidden).toHaveLength(gap===0?1:2);
      expect(result.features[0].hidden).toHaveLength(exact.length);
      result.features[0].hidden.forEach((interval,i)=>{expect(Math.abs(interval[0]-exact[i][0])).toBeLessThan(2*result.stats.parameterTolerance!);expect(Math.abs(interval[1]-exact[i][1])).toBeLessThan(2*result.stats.parameterTolerance!);});
      if(gap>0)expect(result.features[0].hidden[0][1]).toBeLessThan(result.features[0].hidden[1][0]);
      expect(result.stats.refinements).toBeGreaterThan(0);
    }
  });
  it('handles an empty scene and capacity errors without dropping pairs', async () => {
    const empty=featureSnapshot3([],[],frame());expect(classifySceneCpu3(empty).features).toEqual([]);
    const scene=featureSnapshot3([{id:'box',surface:boxAt()}],[],frame());
    const noGpu={classify:()=>{throw new Error('must not dispatch')}} as unknown as GpuIntervals3;
    await expect(classifySceneGpu3(scene,noGpu,{maxCandidates:0})).rejects.toThrow(/candidate pairs/);
    await expect(classifySceneGpu3(scene,noGpu,{pairCapacity:0})).rejects.toThrow(/capacity/);
    expect((await classifySceneGpu3(empty,noGpu)).stats.dispatches).toBe(0);
  });
});

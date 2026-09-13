import { describe, expect, it } from 'vitest';
import { hatch3, section3, surface3, box3, mm, FeatureKind3, constructStrokes3, lineArt3, type Camera3 } from '../src/index.js';
import { cameraFrame3, toPaper3, toCamera3 } from '../src/three/camera.js';
import { featureSnapshot3 } from '../src/three/features/snapshot.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';
const camera:Camera3={kind:'orthographic',span:10,eye:[0,0,10],target:[0,0,0],up:[0,1,0],near:.1,far:30};
const frame=cameraFrame3(camera,{x:0,y:0,width:100,height:100});
const quad=()=>surface3([[-4,-4,0],[4,-4,0],[4,4,0],[-4,4,0]],[[0,1,2,3]]);
const select=(f:{flags:number})=>(f.flags&FeatureKind3.hatch)!==0;
const classify=(hatch:ReturnType<typeof hatch3>,f=frame)=>classifySceneCpu3(featureSnapshot3([{id:'sheet',surface:hatch.surface,hatch}],[],f));
describe('physical surface hatch',()=>{
  it('shares one ruling lattice across triangle boundaries and crosshatch families',()=>{
    const hatch=hatch3(quad(),[{id:'rows',spacing:mm(10),angle:0}]);
    const result=classify(hatch),runs=constructStrokes3(result,[{id:'hatch',stroke:'ink',select}]);
    expect(runs).toHaveLength(7);
    expect(runs.every(r=>r.parts.length===2&&Math.abs(r.length-80)<1e-8)).toBe(true);
    expect(runs.map(r=>Math.round(r.points[0][1])).sort((a,b)=>a-b)).toEqual([20,30,40,50,60,70,80]);
    expect(result.features.filter(r=>select(r.feature)).every(r=>r.hidden.length===0&&r.feature.curve?.kind==='hatch')).toBe(true);
    const cross=hatch3(quad(),[{id:'rows',spacing:mm(10),angle:0},{id:'columns',spacing:mm(10),angle:90}]);
    expect(constructStrokes3(classify(cross),[{id:'cross',stroke:'ink',select}])).toHaveLength(14);
  });
  it('keeps physical spacing after camera zoom and applies percent units to the drawable',()=>{
    const hatch=hatch3(quad(),[{id:'rows',spacing:mm(10),angle:0}]);
    const zoom=cameraFrame3({...camera,span:5},frame.paper);
    const runs=constructStrokes3(classify(hatch,zoom),[{id:'hatch',stroke:'ink',select}]);
    const ys=runs.map(r=>r.points[0][1]).sort((a,b)=>a-b);
    expect(runs).toHaveLength(15);for(let i=1;i<ys.length;i++)expect(ys[i]-ys[i-1]).toBeCloseTo(10);
    expect(ys[0]).toBeLessThan(0); // overscan is generated, not page-culled
    const relative=hatch3(quad(),[{id:'percent',spacing:5,angle:0}]);
    const snapshot=featureSnapshot3([{id:'sheet',surface:relative.surface,hatch:relative}],[],frame,{innerW:200,innerH:300});
    expect(snapshot.features.filter(select).every(f=>f.attributes.hatchSpacingMm===10)).toBe(true);
  });
  it('lifts perspective rulings onto sloped and folded triangles with source weights',()=>{
    const surface=quad();surface.points[2].position=[4,4,4];
    const hatch=hatch3(surface,[{id:'slanted',spacing:mm(4),angle:27}]);
    const perspective=cameraFrame3({...camera,kind:'perspective',fovDegrees:60},frame.paper);
    const features=classify(hatch,perspective).features.filter(r=>select(r.feature));
    expect(features.length).toBeGreaterThan(10);
    const theta=27*Math.PI/180;
    for(const {feature:f} of features)for(const point of [f.curve!.a,f.curve!.b]) {
      const p=toPaper3(perspective,toCamera3(perspective,point.position));
      expect(-Math.sin(theta)*p[0]+Math.cos(theta)*p[1]).toBeCloseTo(Number(f.attributes.hatchLine)*4,7);
      const reconstructed=point.vertices.reduce((sum,v,i)=>sum.map((n,k)=>n+hatch.surface.points[v].position[k]*point.weights[i]),[0,0,0]);
      point.position.forEach((n,k)=>expect(n).toBeCloseTo(reconstructed[k]));
    }
  });
  it('clips across the near plane, respects mirrored instances and omits edge-on faces',()=>{
    const shape=surface3([[-2,-2,0],[2,-2,4],[2,2,4],[-2,2,0]],[[0,1,2,3]]);
    const hatch=hatch3(shape,[{id:'clip',spacing:mm(5),angle:31}]);
    const clipped=cameraFrame3({...camera,kind:'perspective',fovDegrees:70,eye:[0,0,3],near:1,far:8},frame.paper);
    const source=classifySceneCpu3(featureSnapshot3([{id:'mirror',surface:hatch.surface,hatch,transform:{scale:[-1,1.2,1],rotate:[0,0,12]}}],[],clipped));
    const curves=source.features.filter(r=>select(r.feature));expect(curves.length).toBeGreaterThan(5);
    const theta=31*Math.PI/180;
    for(const {feature:f} of curves)for(const point of [f.a,f.b]) {
      expect(-point[2]).toBeGreaterThanOrEqual(1-1e-10);expect(-point[2]).toBeLessThanOrEqual(8+1e-10);
      const p=toPaper3(clipped,point);expect(-Math.sin(theta)*p[0]+Math.cos(theta)*p[1]).toBeCloseTo(Number(f.attributes.hatchLine)*5,7);
    }
    const edgeOn=cameraFrame3({...camera,eye:[10,0,0],up:[0,0,1]},frame.paper);
    expect(classify(hatch3(quad(),[{id:'edge-on',spacing:mm(1),angle:0}]),edgeOn).features.filter(r=>select(r.feature))).toHaveLength(0);
    const concave=surface3([[0,0,0],[3,0,0],[3,1,0],[1,1,0],[1,3,0],[0,3,0]],[[0,1,2,3,4,5]]);
    const concaveRuns=constructStrokes3(classify(hatch3(concave,[{id:'concave',spacing:mm(10),angle:0}])),[{id:'hatch',stroke:'ink',select}]);
    expect(concaveRuns).toHaveLength(2);expect(concaveRuns.map(r=>Math.round(r.length))).toEqual([10,10]);
  });
  it('captures callbacks once, composes sections, and retains face attributes and occlusion',()=>{
    const source=quad();source.faces[0].attributes.density=10;
    const sections=section3(source,[{id:'section',origin:[0,0,0],normal:[1,0,0]}]);let calls=0;
    const hatch=hatch3(sections.surface,f=>{calls++;return [{id:'rows',spacing:mm(Number(f.attributes.density)),angle:0}];});
    expect(hatch.surface).toBe(sections.surface);
    const scene=lineArt3({camera,objects:[{id:'sheet',surface:hatch.surface,hatch,curves:sections},{id:'block',surface:box3([1,1,1],[0,0,1]),lineSource:false}],lineSets:[]});
    const result=classifySceneCpu3(featureSnapshot3(scene.objects,[],frame));
    classify(hatch,cameraFrame3({...camera,span:12},frame.paper));expect(calls).toBe(1);
    const curves=result.features.filter(r=>select(r.feature));expect(curves.some(r=>r.hidden.length)).toBe(true);
    expect(curves.every(r=>r.feature.faceAttributes[0].density===10)).toBe(true);
    expect(()=>lineArt3({camera,objects:[{id:'stale',surface:source,hatch}],lineSets:[]})).toThrow('different captured surface');
    expect(()=>hatch3(source,[{id:'bad',spacing:mm(0),angle:0}])).toThrow('positive');
    expect(()=>classify(hatch3(source,[{id:'too-many',spacing:mm(.001),angle:0}],{maxSegments:10}))).toThrow('capacity');
  });
});

import { describe, expect, it } from 'vitest';
import { box3, surface3, section3, lineArt3, FeatureKind3, constructStrokes3 } from '../src/index.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { featureSnapshot3 } from '../src/three/features/snapshot.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';
const plane={id:'middle',origin:[0,0,0] as const,normal:[0,0,1] as const};
const frame=cameraFrame3({kind:'orthographic',span:4,eye:[4,6,5],target:[0,0,0],near:.1,far:30},{x:0,y:0,width:100,height:100});
const select=(f:{flags:number})=>(f.flags&FeatureKind3.section)!==0;
describe('mesh-plane sections',()=>{
  it('connects the analytical cube section without triangulation seams',()=>{
    const curves=section3(box3([2,2,2]),[plane]);
    expect(curves.segments).toHaveLength(8);
    expect(curves.segments.reduce((n,s)=>n+Math.hypot(...s.a.position.map((v,i)=>v-s.b.position[i])),0)).toBeCloseTo(8);
    for(const segment of curves.segments)for(const p of [segment.a,segment.b])expect(p.position[2]).toBe(0);
    const classified=classifySceneCpu3(featureSnapshot3([{id:'cube',surface:curves.surface,curves,occluder:false}],[],frame));
    const runs=constructStrokes3(classified,[{id:'sections',stroke:'ink',select}]);
    expect(runs).toHaveLength(1);expect(runs[0].closed).toBe(true);expect(runs[0].parts).toHaveLength(8);
    expect(runs[0].reference.arclength.at(-1)).toBeCloseTo(runs[0].length);
  });
  it('emits only coplanar patch boundaries and omits isolated tangent points',()=>{
    const cube=box3([2,2,2]);
    const cap=section3(cube,[{...plane,origin:[0,0,1]}]);
    expect(cap.segments).toHaveLength(4);
    expect(cap.segments.every(s=>s.triangles.length===2)).toBe(true);
    expect(section3(cube,[{...plane,origin:[1,1,1],normal:[1,1,1]}]).segments).toHaveLength(0);
    expect(section3(cube,[{...plane,origin:[0,0,2]}]).segments).toHaveLength(0);
  });
  it('matches the analytical oblique hexagon at different model scales',()=>{
    for(const scale of [1e-9,1,1e9]) {
      const cube=box3([2*scale,2*scale,2*scale]);
      const a=section3(cube,[{...plane,normal:[1,1,1]}]);
      const b=section3(cube,[{...plane,normal:[-1,-1,-1]}]);
      expect(a.segments).toEqual(b.segments);
      const length=a.segments.reduce((n,s)=>n+Math.hypot(...s.a.position.map((v,i)=>v-s.b.position[i])),0);
      expect(length/scale).toBeCloseTo(6*Math.sqrt(2));
      for(const s of a.segments)for(const p of [s.a,s.b])expect(p.position.reduce((n,v)=>n+v,0)/scale).toBeCloseTo(0);
    }
  });
  it('preserves face attributes, instance placement, and same-object occlusion',()=>{
    const cube=box3([2,2,2]);cube.faces.forEach(f=>{f.attributes.importance=7;});
    const curves=section3(cube,[{...plane,attributes:{layer:4}}]);
    const scene=lineArt3({camera:frame.camera,viewport:frame.paper,objects:[{id:'cube',surface:curves.surface,curves,transform:{scale:[-1,1,1],translate:[.2,0,0]}}],lineSets:[]});
    const source=classifySceneCpu3(featureSnapshot3(scene.objects,[],frame));
    const sections=source.features.filter(r=>select(r.feature));
    expect(sections).toHaveLength(8);
    expect(sections.every(r=>r.feature.support.length===r.feature.curve!.triangles.length && r.feature.faceAttributes.every(a=>a.importance===7) && r.feature.attributes.layer===4)).toBe(true);
    expect(sections.some(r=>r.hidden.length>0)).toBe(true);
    expect(sections.some(r=>r.visible.length>0)).toBe(true);
    expect(scene.objects[0].curves!.surface).toBe(scene.objects[0].surface);
    expect(()=>lineArt3({camera:frame.camera,objects:[{id:'stale',surface:cube,curves}],lineSets:[]})).toThrow('different captured surface');
    const first=curves.segments[0];
    const invalid={...curves,segments:[{...first,a:{...first.a,position:[100,100,100] as const}}]};
    expect(()=>lineArt3({camera:frame.camera,objects:[{id:'invalid',surface:curves.surface,curves:invalid}],lineSets:[]})).toThrow('source weights');
    cube.points[0].position=[99,99,99];expect(curves.surface.points[0].position).not.toEqual([99,99,99]);
  });
  it('handles concave faces and folded fixed triangulation with bounded candidates',()=>{
    const surface=surface3([[0,0,0],[3,0,0],[3,1,0],[1,1,0],[1,3,0],[0,3,0]],[[0,1,2,3,4,5]]);
    const curves=section3(surface,[{id:'cut',origin:[0,2,0],normal:[0,1,0]}]);
    expect(curves.segments.reduce((n,s)=>n+Math.hypot(...s.a.position.map((v,i)=>v-s.b.position[i])),0)).toBeCloseTo(1);
    const folded=surface3([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],[[0,1,2,3]]);
    folded.points[2].position=[1,1,1];
    const bent=section3(folded,[{id:'fold',origin:[0,0,.3],normal:[0,0,1]}]);
    expect(bent.segments.length).toBeGreaterThan(0);
    for(const s of bent.segments)for(const p of [s.a,s.b]) {
      expect(p.position[2]).toBeCloseTo(.3);
      const reconstructed=p.vertices.reduce((sum,v,i)=>sum.map((n,k)=>n+folded.points[v].position[k]*p.weights[i]),[0,0,0]);
      p.position.forEach((n,k)=>expect(n).toBeCloseTo(reconstructed[k]));
    }
    expect(()=>section3(box3(),[plane],{maxSegments:1})).toThrow('capacity');
    expect(()=>section3(box3(),[{...plane,normal:[0,0,0]}])).toThrow('nonzero');
    expect(()=>section3(box3(),[plane,plane])).toThrow('unique');
  });
});

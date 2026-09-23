import {describe,expect,it} from 'vitest';
import {sketch,compileSketchAsync,pen,mm} from 'occlude';
import {cameraFrame3} from '../src/three/camera.js';
import {cross3,dot3,sub3,unit3,type Vec3} from '../src/three/math.js';
import {featureSnapshot3,FeatureKind3} from '../src/three/features/snapshot.js';
import {suggestiveSegments3} from '../src/three/features/suggestive.js';
import type {ClassifiedScene3} from '../src/three/visibility/scene.js';
import {projectedLines} from '../src/three/api/projected.js';
import {sphere,torus} from '../src/three/api/primitives.js';
import {box,plane} from '../src/three/api/mesh.js';
import {style} from '../src/three/api/style.js';
import {view} from '../src/three/api/view.js';
import type {Surface3} from '../src/three/geometry/surface.js';
import type {Drawing3} from '../src/three/drawing.js';

const frame=(eye:Vec3,span=6)=>cameraFrame3({kind:'orthographic',span,eye,target:[0,0,0],near:.1,far:80},{x:0,y:0,width:200,height:200});
// A blob: one lobe folded over another, the shape a silhouette alone cannot state.
const blob=()=>sphere(1.2,{segments:48,rings:24,creaseAngle:180}).displace(p=>.35*Math.sin(p.x*2.4)*Math.cos(p.z*3.6)+.18*Math.sin(p.y*5));
const eye:Vec3=[3,-7,2.5];
const count=(scene:ClassifiedScene3)=>scene.features.filter(row=>(row.feature.flags&FeatureKind3.suggestive)!==0).length;
const drawn=async(drawing:Drawing3):Promise<ClassifiedScene3>=>{
  const run=await compileSketchAsync(sketch({pens:{ink:pen({width:mm(.3),color:'#111'})}},()=>drawing));
  return [...run.scenes3.values()][0];
};
const facingOf=(surface:Surface3,triangle:number,back:Vec3)=>{
  const [a,b,c]=surface.triangles[triangle].vertices.map(v=>surface.points[v].position);
  return dot3(unit3(cross3(sub3(b,a),sub3(c,a))),back);
};

describe('suggestive contours',()=>{
  it('draws none on a sphere, whose radial curvature never reaches zero',()=>{
    const surface=sphere(1,{segments:48,rings:24}).surface;
    expect(suggestiveSegments3(surface,frame([4,-4,2]),{threshold:0})).toHaveLength(0);
    const near=cameraFrame3({kind:'perspective',fovDegrees:50,eye:[3,-3,2],target:[0,0,0],near:.1,far:40},{x:0,y:0,width:200,height:200});
    expect(suggestiveSegments3(surface,near,{threshold:0})).toHaveLength(0);
  });
  it('draws none on a plane, and none where there is nothing to read',()=>{
    expect(suggestiveSegments3(plane(3,3).subdivide(3).surface,frame([3,-3,3]),{threshold:0})).toHaveLength(0);
    // Dead-on: the view vector is the normal, so no radial direction exists.
    const above=cameraFrame3({kind:'orthographic',span:6,eye:[0,0,4],up:[0,1,0],target:[0,0,0],near:.1,far:40},{x:0,y:0,width:200,height:200});
    expect(suggestiveSegments3(plane(3,3).subdivide(2).surface,above,{threshold:0})).toHaveLength(0);
    // An eye inside the mesh sees only surface turned away: nothing to suggest.
    const inside=cameraFrame3({kind:'perspective',fovDegrees:60,eye:[0,0,0],target:[1,0,0],near:.01,far:20},{x:0,y:0,width:200,height:200});
    expect(suggestiveSegments3(blob().surface,inside,{threshold:0})).toHaveLength(0);
  });
  it('draws them on a torus seen obliquely, where the surface is nearly turned away',()=>{
    const surface=torus(1,.4,{segments:64,tubeSegments:24}).surface,f=frame([3,-3,2.4]);
    const segments=suggestiveSegments3(surface,f);
    expect(segments.length).toBeGreaterThan(8);
    for(const segment of segments){
      const facing=facingOf(surface,segment.triangle,f.back);
      expect(facing).toBeGreaterThan(.02);
      expect(facing).toBeLessThan(.7);
    }
  });
  it('is off until an object asks for it, and then the threshold keeps fewer',{timeout:60000},async()=>{
    const camera=frame(eye,7).camera;
    expect(count(await drawn(view(blob(),{camera,pen:'ink'})))).toBe(0);
    const on=await drawn(view(style(blob(),{suggestive:{}}),{camera,pen:'ink'}));
    expect(count(on)).toBeGreaterThan(0);
    // The whole view can ask instead, and an object can refuse.
    expect(count(await drawn(view(blob(),{camera,pen:'ink',suggestive:{}})))).toBe(count(on));
    expect(count(await drawn(view(style(blob(),{suggestive:false}),{camera,pen:'ink',suggestive:{}})))).toBe(0);
    const surface=blob().surface,f=frame(eye,7);
    const counts=[0,12,40,400].map(threshold=>featureSnapshot3([{id:'blob',surface,suggestive:{threshold}}],[],f).features.filter(row=>(row.flags&FeatureKind3.suggestive)!==0).length);
    expect(counts).toEqual([...counts].sort((a,b)=>b-a));
    expect(counts[0]).toBeGreaterThan(counts[3]);
    expect(counts[3]).toBe(0);
  });
  it('selects by kind and carries visible and hidden intervals',async()=>{
    const camera=frame(eye,7).camera;
    const wall=box([.2,2,2]).translate([.6,-2.2,.2]).withKey('wall');
    const lines=projectedLines(await drawn(view([style(blob(),{suggestive:{}}),wall],{camera,pen:'ink'})));
    expect(lines.visible.kind('suggestive').length).toBeGreaterThan(0);
    expect(lines.hidden.kind('suggestive').length).toBeGreaterThan(0);
    expect([...lines.visible.kind('suggestive')].every(row=>row.kinds.has('suggestive'))).toBe(true);
    expect([...lines.visible.except('suggestive')].some(row=>row.kinds.has('suggestive'))).toBe(false);
    expect(lines.visible.kind('suggestive').length+lines.visible.except('suggestive').length).toBe(lines.visible.length);
  });
  it('is the same lines for the same mesh, camera and threshold',()=>{
    const f=frame(eye,7);
    const first=suggestiveSegments3(blob().surface,f),second=suggestiveSegments3(blob().surface,f);
    expect(first.length).toBeGreaterThan(0);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const ink=(surface:Surface3)=>featureSnapshot3([{id:'blob',surface,suggestive:{}}],[],f).features.filter(row=>(row.flags&FeatureKind3.suggestive)!==0).map(row=>[row.id,row.a,row.b,row.endpoints]);
    expect(JSON.stringify(ink(blob().surface))).toBe(JSON.stringify(ink(blob().surface)));
  });
});

/** Analytical acceptance fixtures shared by CPU tests and the hardware worker. */
import { cameraFrame3, type Camera3 } from '../src/three/camera.js';
import { surface3, type Surface3 } from '../src/three/geometry/surface.js';
import { transformSurface3 } from '../src/three/geometry/model.js';
import { featureSnapshot3, type FeatureSnapshot3 } from '../src/three/features/snapshot.js';
import type { Vec3 } from '../src/three/math.js';
import type { Interval3 } from '../src/three/visibility/interval.js';
export interface PrecisionFixture3 { id:string;snapshot:FeatureSnapshot3;hidden:readonly Interval3[];features?:number;triangles?:number;sourceRange?:Interval3 }
export function precisionFixtures3():PrecisionFixture3[] {
  const out:PrecisionFixture3[]=[];
  for(const perspective of [false,true]){
    const projection=perspective?'perspective':'orthographic';
    const camera:Camera3={...(perspective?{kind:'perspective' as const,fovDegrees:90}:{kind:'orthographic' as const,span:4}),eye:[0,0,0],target:[0,0,-1],up:[0,1,0],near:.1,far:100};
    const triangle=()=>surface3([[-1,-1,-2],[1,-1,-2],[0,1,-2]],[[0,1,2]]);
    const partial:Interval3=perspective?[.25,.75]:[.375,.625];
    const add=(id:string,surfaces:Surface3[],points:Vec3[],hidden:readonly Interval3[],extra:Partial<PrecisionFixture3>={},view:Camera3=camera)=>{
      const snapshot=featureSnapshot3(surfaces.map((surface,i)=>({id:`occluder-${i}`,surface,lineSource:false})),[{id:'wire',points}],cameraFrame3(view,{x:0,y:0,width:100,height:100}));
      out.push({id:`${projection}/${id}`,snapshot,hidden,...extra});
    };
    for(const scale of [1e-9,1,1e9]){
      const scaled=(p:Vec3):Vec3=>p.map(v=>v*scale) as unknown as Vec3;
      const view:Camera3={...camera,eye:scaled(camera.eye),target:scaled(camera.target),near:camera.near*scale,far:camera.far*scale,...(perspective?{}:{span:4*scale})};
      add(`scale-${scale}`,[transformSurface3(triangle(),{scale:[scale,scale,scale]})],[scaled([-2,0,-4]),scaled([2,0,-4])],[partial],{},view);
    }
    const offset:Vec3=[1e12,-1e12,1e12],shift=(p:Vec3):Vec3=>p.map((v,i)=>v+offset[i]) as unknown as Vec3;
    add('translated-1e12',[transformSurface3(triangle(),{translate:offset})],[shift([-2,0,-4]),shift([2,0,-4])],[partial],{},{...camera,eye:shift(camera.eye),target:shift(camera.target)});
    add('thin-occluder',[transformSurface3(triangle(),{scale:[1e-9,1,1]})],[[-2,0,-4],[2,0,-4]],[[.5-(perspective?2.5e-10:1.25e-10),.5+(perspective?2.5e-10:1.25e-10)]]);
    add('overlapping-occluders',[triangle(),transformSurface3(triangle(),{translate:[.5,0,0]})],[[-2,0,-4],[2,0,-4]],[perspective?[.25,1]:[.375,.75]]);
    add('positive-subnib-gap',[transformSurface3(triangle(),{translate:[-.50000001,0,0]}),transformSurface3(triangle(),{translate:[.50000001,0,0]})],[[-2,0,-4],[2,0,-4]],perspective?[[0,.499999995],[.500000005,1]]:[[.2499999975,.4999999975],[.5000000025,.7500000025]]);
    add('coincident-occluders',[triangle(),triangle()],[[-2,0,-4],[2,0,-4]],[partial]);
    add('coplanar-distinct-source',[triangle(),triangle()],[[-.1,0,-2],[.1,0,-2]],[]);
    add('near-coplanar-behind',[triangle()],[[-.1,0,-2-1e-10],[.1,0,-2-1e-10]],[[0,1]]);
    add('near-coplanar-front',[triangle()],[[-.1,0,-2+1e-10],[.1,0,-2+1e-10]],[]);
    add('vertex-tangent',[triangle()],[[-2,perspective?2:1,-4],[2,perspective?2:1,-4]],[]);
    add('projected-edge-contact',[triangle()],[[-2,perspective?-2:-1,-4],[2,perspective?-2:-1,-4]],[perspective?[0,1]:[.25,.75]]);
    add('zero-length-wire',[triangle()],[[0,0,-4],[0,0,-4]],[],{features:0});
    add('mirrored-nonuniform',[transformSurface3(triangle(),{scale:[-2,3,.5]})],[[-4,0,-2],[4,0,-2]],[partial]);
    add('strong-depth-slope',[triangle()],[[-3,0,-1],[3,0,-20]],[perspective?[11/43,1]:[5/12,7/12]]);
    add('through-eye',[triangle()],[[-2,0,1],[2,0,-5]],[perspective?[.25,.55]:[.25,.4375]],{sourceRange:[1/3,1]},{...camera,near:1});
    add('near-plane-split',[surface3([[-1,-1,-.5],[1,-1,-2],[0,1,-2]],[[0,1,2]])],[[-2,0,-4],[2,0,-4]],[perspective?[.1,.75]:[.375,.625]],{triangles:2},{...camera,near:1});
  }
  return out;
}

/** Deliberately demanding paper/nib combinations expose a fixed parameter budget. */
export function paperBudgetFixtures3() {
  return [false, true].flatMap(perspective => [
    { size: 1e7, nib: .3, name: 'large-paper' },
    { size: 100, nib: 1e-6, name: 'thin-nib' },
  ].map(({ size, nib, name }) => {
    const camera: Camera3 = { ...(perspective ? { kind: 'perspective' as const, fovDegrees: 90 } : { kind: 'orthographic' as const, span: 4 }), eye: [0,0,0], target: [0,0,-1], up: [0,1,0], near: .1, far: 100 };
    return {
      id: `${camera.kind}/${name}`, nib,
      hidden: [perspective ? [.25,.75] : [.375,.625]] as Interval3[],
      snapshot: featureSnapshot3([{ id: 'occluder', lineSource: false, surface: surface3([[-1,-1,-2],[1,-1,-2],[0,1,-2]],[[0,1,2]]) }], [{ id: 'wire', points: [[-2,0,-4],[2,0,-4]] }], cameraFrame3(camera,{x:0,y:0,width:size,height:size})),
    };
  }));
}

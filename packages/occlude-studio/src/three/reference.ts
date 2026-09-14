import { surface3 } from 'occlude/src/three/geometry/surface.js';
import { cameraFrame3, toPaper3, type Camera3 } from 'occlude/src/three/camera.js';
import { featureSnapshot3, FeatureKind3 } from 'occlude/src/three/features/snapshot.js';
import { classifySceneGpu3 } from 'occlude/src/three/visibility/scene.js';
import { GpuIntervals3 } from 'occlude/src/compute/webgpu/interval.js';
import { lerp3, type Vec3 } from 'occlude/src/three/math.js';
interface Fixture { id:string;camera:Camera3;features:(keyof typeof FeatureKind3)[];visibility:('visible'|'hidden')[];objects:{id:string;positions:Vec3[];polygons:number[][];marked?:[number,number][]}[] }
/** Hardware fixture runner, used only by the development reference/benchmark worker. */
export async function reference3(fixtures:Fixture[]) {
  const gpu=await GpuIntervals3.create(navigator.gpu,{requireHardware:true});
  try{
    const cases=[];
    for(const fixture of fixtures){
      const frame=cameraFrame3(fixture.camera,{x:0,y:0,width:100,height:100});
      const objects=fixture.objects.map(source=>{
        const surface=surface3(source.positions,source.polygons);
        for(const edge of surface.edges)if(source.marked?.some(([a,b])=>edge.vertices.includes(a)&&edge.vertices.includes(b)))edge.attributes.marked=true;
        return {id:source.id,surface};
      });
      const classified=await classifySceneGpu3(featureSnapshot3(objects,[],frame),gpu);
      const flags=fixture.features.reduce((mask,kind)=>mask|FeatureKind3[kind],0);
      for(const visibility of fixture.visibility)cases.push({id:fixture.id,visibility,stats:classified.stats,segments:classified.features.filter(f=>f.feature.flags&flags).flatMap(f=>f[visibility].map(([lo,hi])=>[
        toPaper3(frame,lerp3(f.feature.a,f.feature.b,lo)),toPaper3(frame,lerp3(f.feature.a,f.feature.b,hi)),
      ]))});
    }
    const info=gpu.adapterInfo;
    return {adapter:{vendor:info.vendor,architecture:info.architecture,isFallbackAdapter:info.isFallbackAdapter},cases};
  }finally{await gpu.dispose();}
}

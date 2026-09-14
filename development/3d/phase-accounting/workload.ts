import {sketchAsync,paper,pen,mm} from 'occlude';
import {plane,box,mesh,pointCloud,view,orthographic,query} from 'occlude/3d';
import {featureSnapshot3,cameraFrame3,classifySceneCpu3} from 'occlude/3d/advanced';

export default sketchAsync({seed:42,paper:paper({width:mm(100),height:mm(100)}),margin:0,pens:{ink:pen({width:mm(.25)}),shade:pen({width:mm(.15),color:'#A84932'})}},async t=>{
  console.info('phase-model');
  const terrain=plane(4).subdivide(4).translate([0,0,1]);
  const surface=await t.deform3(terrain.surface,{iterations:12,relaxation:0,displacements:terrain.points.map(()=>[0,0,.01])});
  await t.deform3(terrain.surface,{iterations:0,relaxation:0});
  const moved=mesh(surface),prepared=query(plane(8)),batch=prepared.batch(t);
  const [cold,warm]=await Promise.all([batch.nearest(moved.points),batch.nearest(moved.points)]);
  const rays=await batch.rays(moved.points,{origin:p=>[p.x,p.y,3],direction:[0,0,-2]});
  const segments=await batch.segments(moved.points,{to:p=>[p.x,p.y,-1]});
  const empty=await batch.nearest(pointCloud([]).points);
  const hitProof=cold.every((r,i)=>r.source===moved.points.at(i)&&r.hit&&warm[i].hit&&Math.abs(r.hit.position[2])<1e-8&&Math.abs(r.hit.distance-r.source.z)<1e-8&&Math.abs(warm[i].hit.distance-r.hit.distance)<1e-8);
  const rayProof=rays.every(r=>r.hit&&Math.abs(r.hit.distance-3)<1e-8&&Math.abs(r.hit.t-1.5)<1e-8);
  const segmentProof=segments.every(r=>r.hit&&Math.abs(r.hit.distance-r.source.z)<1e-8&&Math.abs(r.hit.t-r.source.z/(r.source.z+1))<1e-8);
  const deformProof=moved.points.map(p=>p.z).every(z=>Math.abs(z-1.12)<1e-6);
  const camera=orthographic({eye:[5,7,6],span:7}),viewport={x:0,y:0,width:100,height:100};
  const captureStart=performance.now();
  const drawing=view([moved,box(1.5).translate([0,0,1])],{camera,viewport,hatch:{spacing:mm(2),stroke:'shade'}});
  const viewCaptureMs=performance.now()-captureStart;
  const gpuStart=performance.now(),gpu=await t.classify3(drawing.scene),gpuCallMs=performance.now()-gpuStart;
  const snapshotStart=performance.now(),snapshot=featureSnapshot3(drawing.scene.objects,drawing.scene.wires,cameraFrame3(camera,viewport)),cpuSnapshotMs=performance.now()-snapshotStart;
  const cpu=classifySceneCpu3(snapshot);
  const agreement=cpu.features.length===gpu.features.length&&cpu.features.every((c,i)=>c.feature.id===gpu.features[i].feature.id&&c.hidden.length===gpu.features[i].hidden.length&&c.hidden.every((r,j)=>r.every((v,k)=>Math.abs(v-gpu.features[i].hidden[j][k])<1e-5)));
  console.info('phase-proof:'+JSON.stringify({points:moved.points.length,hitProof,rayProof,segmentProof,deformProof,empty:empty.length,agreement,viewCaptureMs,gpuCallMs,cpuSnapshotMs,cpu:cpu.stats,gpu:gpu.stats}));
  return drawing;
});

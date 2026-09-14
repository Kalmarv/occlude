// Executable acceptance sketch: shared prototypes until explicit realization.
import {sketch,pen,mm} from 'occlude';
import {pointCloud,cone,instanceOnPoints,view,perspective} from 'occlude/3d';
export default sketch({ ...({seed:42,pens:{ink:pen({width:mm(.25),color:'#18202A'})}}), cameras3: {
    "@1": {"eye":[8,10,8],"target":[0,0,0.5],"kind":"orthographic","near":0.1,"far":100,"up":[0,0,1],"span":13.840777978118613}
  } },t=>{
  console.info('mesh-model'); const sites=pointCloud(Array.from({length:36},(_,i)=>[(i%6-2.5)*1.2,(Math.floor(i/6)-2.5)*1.2,0]))
    .attribute('height',()=>t.rnd(.5,1.8));
  const forms=instanceOnPoints(cone(.4,1),sites.points,{scale:p=>[1,1,p.height]});
  return (drawing=>{console.info('instance-shared:'+new Set(drawing.scene.objects.map(o=>o.surface)).size);return drawing;})(view(forms,{camera:perspective({eye:[8,10,8],target:[0,0,.5],fovDegrees:50}),stroke:'ink'}));
});

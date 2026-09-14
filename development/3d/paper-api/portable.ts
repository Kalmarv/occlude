// Acceptance target: interval selection keeps hatch/support/source phase.
import {sketch,paper,pen,mm,inch,strokes,clip,rect,mask,label} from 'occlude';
import {box,view,orthographic} from 'occlude/3d';
export default sketch({ ...({seed:42,paper:paper({width:inch(8.5),height:inch(11),color:'#F5F0E6'}),margin:5,pens:{ink:pen({width:mm(.3),color:'#18202A'}),shade:pen({width:mm(.18),color:'#A84932'})}}), cameras3: {
    "@1": {"eye":[5,7,6],"target":[0,0,0.4],"kind":"perspective","near":0.1,"far":100,"up":[0,0,1],"fovDegrees":25.259663139265612}
  } },()=>{
  console.info('paper-model'); const relief=box([2.8,1.5,1.6]).faceAttribute('decorate',f=>f.normal[2]>=0);
  const tower=box([1,1,2.8]).translate([.6,.3,.6]);
  return [clip(rect(4,6,92,112),view([relief,tower],{
    camera:orthographic({eye:[5,7,6],target:[0,0,.4],span:4.6}),
    hatch:{spacing:mm(1.8),angle:35,select:f=>f.decorate===true},
  },lines=>{
    const hatch=[...lines.visible,...lines.hidden].filter(c=>c.kinds.has('hatch'));
    console.info('paper-lines:'+JSON.stringify({visible:lines.visible.length,hidden:lines.hidden.filter(c=>c.kinds.has('crease')).length,hatch:hatch.length,supported:hatch.every(c=>c.support.length>0&&c.faceAttributes.some(a=>a.decorate===true))}));
    return [
    strokes(lines.visible.filter(c=>!c.kinds.has('hatch')),{stroke:'ink'}),
    strokes(lines.visible.filter(c=>c.kinds.has('hatch')),{stroke:'shade'}),
    strokes(lines.hidden.filter(c=>c.kinds.has('crease')),{stroke:'shade'}),
  ];})),mask(rect(52,76,44,17)),label('SOLID / PAPER',54,78,3,{stroke:'ink'})];
});

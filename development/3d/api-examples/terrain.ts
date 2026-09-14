// Acceptance target: promote to a live example when occlude/3d is implemented.
import {sketch,paper,pen,mm,inch} from 'occlude';
import {plane,sphere,view,orthographic} from 'occlude/3d';
export default sketch({seed:42,paper:paper({width:inch(8.5),height:inch(11),color:'#F5F0E6'}),margin:5,pens:{ink:pen({width:mm(.3),color:'#18202A'}),shade:pen({width:mm(.18),color:'#A84932'})}},t=>{
  const terrain=plane(6,6).subdivide(5)
    .attribute('mobility',p=>Math.max(0,1-Math.hypot(p.x,p.y)/3))
    .displace(p=>[0,0,t.noise(p.x*.7,p.y*.7)*.8])
    .steps(8,(current,next,k)=>next.move(current.points,p=>[0,0,Math.sin(p.x+k*.1)*p.mobility*.01]));
  return view([terrain,sphere(.8).translate([0,0,1.6])],{
    camera:orthographic({eye:[6,8,5],target:[0,0,0],span:12}),stroke:'ink',
    hatch:{spacing:mm(1.4),angle:35,stroke:'shade'},
  });
});

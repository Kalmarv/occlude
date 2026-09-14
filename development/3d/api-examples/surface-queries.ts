import {sketchAsync,pen,mm} from 'occlude';
import {plane,query,force,view,orthographic} from 'occlude/3d';
export default sketchAsync({seed:42,pens:{ink:pen({width:mm(.3),color:'#18202A'}),shade:pen({width:mm(.18),color:'#A84932'})}},async t=>{
  const pull=force.attract([0,0,.4],{strength:.015});
  const ceiling=force.plane({origin:[0,0,.8],normal:[0,0,1],side:'below'});
  let terrain=plane(4,4).subdivide(4).displace(p=>[0,0,t.noise(p.x,p.y)*.9])
    .steps(4,(current,next)=>next.move(current.points,pull),(current,next)=>next.move(current.points,ceiling));
  const roof=plane(3,3).rotate([0,15,0]).translate([0,0,.4]).faceAttribute('roof',true);
  const target=query(roof),batch=target.batch(t);
  const roofHits=await batch.rays(terrain.points,{origin:p=>[p.x,p.y,3],direction:[0,0,-2]});
  const nearby=await batch.nearest(terrain.points,{within:.35});
  const limits=new Map(roofHits.map(r=>[r.source.id,r.hit?.position[2]??2]));
  const nearIds=new Set(nearby.filter(r=>r.hit!==null).map(r=>r.source.id));
  terrain=terrain.displace(p=>[0,0,Math.min(0,(limits.get(p.id)??p.z)-p.z)]);
  const drawing=terrain.faceAttribute('shade',f=>f.vertices.some(i=>nearIds.has(terrain.points.at(i)?.id??'')));
  return view(drawing,{camera:orthographic({eye:[6,8,5],target:[0,0,.2],span:7.5}),stroke:'ink',hatch:{spacing:mm(1.8),angle:35,stroke:'shade',select:f=>f.shade}});
});

import {sketchAsync,pen,mm} from 'occlude';
import {plane,query,force,view,orthographic} from 'occlude/3d';
export default sketchAsync({ ...({seed:42,pens:{ink:pen({width:mm(.3),color:'#18202A'}),shade:pen({width:mm(.18),color:'#A84932'})}}), cameras3: {
    "@1": {"eye":[6,8,5],"target":[0,0,0.2],"kind":"perspective","near":0.1,"far":100,"up":[0,0,1],"fovDegrees":37.35782324544728}
  } },async t=>{
  console.info('mesh-model'); const pull=force.attract([0,0,.4],{strength:.015});
  const ceiling=force.plane({origin:[0,0,.8],normal:[0,0,1],side:'below'});
  let terrain=plane(4,4).subdivide(4).displace(p=>[0,0,t.noise(p.x,p.y)*.9])
    .steps(4,(current,next)=>next.move(current.points,pull),(current,next)=>next.move(current.points,ceiling));
  const roof=plane(3,3).rotate([0,15,0]).translate([0,0,.4]).faceAttribute('roof',true);
  const target=query(roof),batch=target.batch(t);
  const roofHits=await batch.rays(terrain.points,{origin:p=>[p.x,p.y,3],direction:[0,0,-2]});
  const nearby=await batch.nearest(terrain.points,{within:.35});
  console.info('query-proof:'+JSON.stringify({rows:roofHits.length,misses:roofHits.filter(r=>r.hit===null).length,nearestMisses:nearby.filter(r=>r.hit===null).length,identity:roofHits.every(r=>r.source===terrain.points.at(r.source.index)),typedFaces:roofHits.every(r=>!r.hit||r.hit.face.roof===true),distanceVsT:roofHits.every(r=>!r.hit||Math.abs(r.hit.distance-2*r.hit.t)<1e-10),rayOracle:roofHits.every(r=>{const x=r.source.x,y=r.source.y,z=.4-Math.tan(Math.PI/12)*x,inside=Math.abs(x)<=1.5*Math.cos(Math.PI/12)&&Math.abs(y)<=1.5;return inside?!!r.hit&&Math.abs(r.hit.position[2]-z)<1e-10&&Math.abs(r.hit.distance-(3-z))<1e-10:r.hit===null;}),nearestOracle:nearby.every(r=>{const p=r.source,c=Math.cos(Math.PI/12),s=Math.sin(Math.PI/12),x=c*p.x-s*(p.z-.4),z=s*p.x+c*(p.z-.4),d=Math.hypot(z,Math.max(0,Math.abs(x)-1.5),Math.max(0,Math.abs(p.y)-1.5));return d<=.35?!!r.hit&&Math.abs(r.hit.distance-d)<1e-10:r.hit===null;})})); const limits=new Map(roofHits.map(r=>[r.source.id,r.hit?.position[2]??2]));
  const nearIds=new Set(nearby.filter(r=>r.hit!==null).map(r=>r.source.id));
  terrain=terrain.displace(p=>[0,0,Math.min(0,(limits.get(p.id)??p.z)-p.z)]);
  const drawing=terrain.faceAttribute('shade',f=>f.vertices.some(i=>nearIds.has(terrain.points.at(i)?.id??'')));
  return view(drawing,{camera:orthographic({eye:[6,8,5],target:[0,0,.2],span:7.5}),stroke:'ink',hatch:{spacing:mm(1.8),angle:35,stroke:'shade',select:f=>f.shade}});
});

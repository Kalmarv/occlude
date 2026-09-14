import { sketch, pen, mm } from 'occlude';
import { plane, cone, sphere, instanceOnPoints, view, orthographic } from 'occlude/3d';

export default sketch({ ...({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.15), color: '#647767' }),
} }), cameras3: {
    "@1": {"eye":[6,8,6],"target":[0,0,0.2],"kind":"perspective","near":0.1,"far":100,"up":[0,0,1],"fovDegrees":44.6745226124568}
  } }, t => {
  console.info('mesh-model'); const terrain = plane(5).subdivide(4)
    .displace(p => [0, 0, 0.6 * t.noise(p.x * 0.5, p.y * 0.5)])
    .faceAttribute('ground', true);
  const sites = t.scatter(terrain, {
    spacing: 0.45, maxPoints: 70, maxAttempts: 4000,
    weight: f => f.normal[2] > 0.85 ? 1 : 0,
  }).attribute('height', p => 0.8 + 0.4 * t.noise(p.x, p.y));
  const trees = instanceOnPoints(cone(0.14, 0.7, { segments: 8 }).translate([0, 0, 0.35]), sites.points, {
    scale: p => [1, 1, p.height],
    rotate: p => {
      const n = p.sample.normal;
      return [0, Math.acos(Math.max(-1, Math.min(1, n[2]))) * 180 / Math.PI,
        Math.atan2(n[1], n[0]) * 180 / Math.PI];
    },
  });
  const marks = t.sample(terrain, { count: 12 });
  const stones = instanceOnPoints(sphere(0.08, { segments: 8, rings: 4 }), marks.points);
  console.info('sampling-proof:'+JSON.stringify({count:sites.points.length,samples:marks.points.length,generation:sites.generation,typedFace:sites.points.map(p=>p.sample.face.ground).every(v=>v===true),identity:trees.rows.every(r=>r.source===sites.points.at(r.source.index)),onSurface:sites.points.map(p=>Math.hypot(p.x-p.sample.position[0],p.y-p.sample.position[1],p.z-p.sample.position[2])).every(d=>d===0),spacing:sites.points.map((p,i)=>sites.points.map((q,j)=>i<j?Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z):Infinity)).flat().every(d=>d>=.45),aligned:trees.rows.every(r=>{const b=r.transform.rotate[1]*Math.PI/180,c=r.transform.rotate[2]*Math.PI/180,n=r.source.sample.normal;return Math.hypot(Math.cos(c)*Math.sin(b)-n[0],Math.sin(c)*Math.sin(b)-n[1],Math.cos(b)-n[2])<1e-12;})})); return view([terrain, trees, stones], {
    camera: orthographic({ eye: [6, 8, 6], target: [0, 0, 0.2], span: 9.5 }),
    stroke: 'ink',
    hatch: { spacing: mm(3), angle: 35, stroke: 'shade', select: f => f.ground === true },
  });
});

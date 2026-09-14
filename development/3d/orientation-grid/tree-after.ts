import { sketch, pen, mm } from 'occlude';
import { plane, cone, sphere, alignAxis, instanceOnPoints, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.15), color: '#647767' }),
} }, t => {
  const terrain = plane(5).subdivide(4)
    .displace(p => [0, 0, 0.6 * t.noise(p.x * 0.5, p.y * 0.5)])
    .faceAttribute('ground', true);
  const sites = t.scatter(terrain, {
    spacing: 0.45, maxPoints: 70, maxAttempts: 4000,
    weight: f => f.normal[2] > 0.85 ? 1 : 0,
  }).attribute('height', p => 0.8 + 0.4 * t.noise(p.x, p.y));
  const trees = instanceOnPoints(cone(0.14, 0.7, { segments: 8 }).translate([0, 0, 0.35]), sites.points, {
    scale: p => [1, 1, p.height],
    rotate: p => alignAxis('z', p.sample.normal),
  });
  const marks = t.sample(terrain, { count: 12 });
  const stones = instanceOnPoints(sphere(0.08, { segments: 8, rings: 4 }), marks.points);
  return view([terrain, trees, stones], {
    camera: orthographic({ eye: [6, 8, 6], target: [0, 0, 0.2], span: 9.5 }),
    stroke: 'ink',
    hatch: { spacing: mm(3), angle: 35, stroke: 'shade', select: f => f.ground === true },
  });
});

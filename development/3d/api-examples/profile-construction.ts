import { sketch, pen, mm } from 'occlude';
import { polyline, circle, curve, revolve, sweep, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#A84932' }),
} }, () => {
  const vessel = revolve(polyline([
    [0, 0, -1.3], [0.8, 0, -1.3], [1, 0, -0.6],
    [0.7, 0, 0.3], [0.45, 0, 0.7], [0.5, 0, 1.3],
  ]), { segments: 40 }).translate([-1.7, 0, 0])
    .faceAttribute('shade', f => f.normal[2] > 0);
  const route = curve(t => [
    0.7 * Math.cos(t * Math.PI * 4),
    0.7 * Math.sin(t * Math.PI * 4),
    (t - 0.5) * 3,
  ], { segments: 64 }).attribute('radius', p => 0.8 + 0.2 * Math.cos(p.z * 2));
  const tube = sweep(circle(0.16, { segments: 16 }), route, {
    caps: true, scale: p => p.radius,
  }).translate([1.4, 0, 0]);
  const ribbon = sweep(polyline([[-0.25, 0, 0], [0.25, 0, 0]]),
    curve(t => [t * 3 - 1.5, 1.6, 0.3 * Math.cos(t * Math.PI * 2)], { segments: 24 }),
    { twist: 180 }).translate([0, 0, -1.5]);
  return view([vessel, tube, ribbon], {
    camera: orthographic({ eye: [7, 10, 7], target: [0, 0, 0], span: 9.5 }),
    stroke: 'ink',
    hatch: { spacing: mm(2), angle: 35, stroke: 'shade', select: f => f.shade === true },
  });
});

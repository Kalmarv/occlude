import { sketch, pen, mm } from 'occlude';
import { box, circle, curve, polyline, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
} }, () => {
  const block = box([1.6, 1.6, 2]);
  const spiral = curve(t => [
    1.5 * Math.cos(t * Math.PI * 6),
    1.5 * Math.sin(t * Math.PI * 6),
    (t - 0.5) * 3.5,
  ], { segments: 180 });
  const ring = circle(1.2, { segments: 64 }).translate([0, 0, 2.1]);
  const path = polyline([[-2, -1, -1.5], [0, 0, -1.5], [2, 1, -1.5]])
    .attribute('lift', p => p.index === 1 ? 0.25 : 0)
    .steps(3, (current, next) => next.move(current.points, p => [0, 0, p.lift]));
  const frame = box([4.4, 4.4, 4.4]).edges
    .filter(e => e.a.z < 0 && e.b.z < 0).extract();
  return view([block, spiral, ring, path, frame], {
    camera: orthographic({ eye: [6, 8, 5], target: [0, 0, 0], span: 9.5 }),
    stroke: 'ink',
  });
});

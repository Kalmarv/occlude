import { sketch, pen, mm } from 'occlude';
import { plane, box, instanceOnPoints, alignAxis, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
} }, t => {
  const rest = plane(2.6, 2.6).subdivide(3).cornerAttributes({
    uv: c => [(c.point.x + 1.3) / 2.6, (c.point.y + 1.3) / 2.6],
    chart: 'sheet',
  });
  const sites = t.sample(rest, { count: 70 });
  const bent = rest.displace(p => [0, 0, 0.45 * Math.sin(p.x * 2) * Math.cos(p.y)]);
  const attached = sites.rebind(bent);
  const pin = box([0.06, 0.06, 0.25]).translate([0, 0, 0.125]);
  const flatPins = instanceOnPoints(pin, sites.points, {
    scale: p => [1, 1, 0.6 + p.sample.cornerAttributes.uv[0]],
    rotate: p => alignAxis('z', p.sample.normal),
  });
  const bentPins = instanceOnPoints(pin, attached.points, {
    scale: p => [1, 1, 0.6 + p.sample.cornerAttributes.uv[0]],
    rotate: p => alignAxis('z', p.sample.normal),
  });
  return view([
    rest.translate([-1.6, 0, 0]), flatPins.translate([-1.6, 0, 0]),
    bent.translate([1.6, 0, 0]), bentPins.translate([1.6, 0, 0]),
  ], {
    camera: orthographic({ eye: [5, 9, 8], target: [0, 0, 0.2], span: 7.2 }),
    stroke: 'ink',
  });
});

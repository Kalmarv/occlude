import { sketchAsync, label, pen, mm } from 'occlude';
import { plane, curvature, across, light, view, perspective } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#56626A' }),
  cross: pen({ width: mm(0.18), color: '#A84932' }),
} }, async t => {
  const relief = plane(5, 4).subdivide(4)
    .displace(p => [0, 0, 0.6 * Math.sin(p.x * 1.4) * Math.cos(p.y * 1.1) + 0.15 * t.noise(p.x, p.y)]);
  const sun = light({ direction: [-2, 1, 3], ambient: 0.05 });
  const marks = await t.hatch(relief, {
    spacing: 0.12,
    families: [
      { id: 'form', direction: curvature('max'), tone: sun, stroke: 'shade' },
      { id: 'cross', direction: across(curvature('max')), tone: s => Math.max(0, 2 * sun(s) - 1), stroke: 'cross' },
    ],
    fallback: s => s.tangentU,
  });
  return [
    view([relief, marks], { camera: perspective({ eye: [6, -8, 6], target: [0, 0, 0], fovDegrees: 38 }), stroke: 'ink' }),
    label('CURVATURE / CROSSHATCH', 8, 94, 4, { stroke: 'ink' }),
  ];
});

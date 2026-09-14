import { sketch, curve, label, pen, mm } from 'occlude';
import { plane, mapSurface, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, t => {
  const sheet = plane(4).subdivide(4)
    .displace(p => [0, 0, 0.4 * Math.sin(p.x) * Math.cos(p.y)]);
  const stripes = t.times(16, (_, u) => curve([[0, u], [1, u]], { closed: false }));
  const marks = mapSurface(sheet, stripes);
  return [
    view([sheet, marks], { camera: orthographic({ eye: [5, 7, 5], span: 6 }), stroke: 'ink' }),
    label('MAPPED STRIPES', 8, 94, 4, { stroke: 'ink' }),
  ];
});

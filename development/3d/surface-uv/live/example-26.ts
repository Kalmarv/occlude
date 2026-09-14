import { sketch, label, pen, mm, strokes } from 'occlude';
import { plane, box, instanceOnPoints, alignAxis, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  outline: pen({ width: mm(0.25), color: '#18202A' }),
  marks: pen({ width: mm(0.2), color: '#A84932' }),
} }, t => {
  const rest = plane(4, 3).subdivide(3);
  const sites = t.sample(rest, { count: 320 }).points
    .filter(p => Math.floor(p.sample.cornerAttributes.uv[0] * 8) % 2 === 0).extract();
  const sheet = rest.displace(p => [0, 0, 0.45 * Math.sin(p.x * 1.8) * Math.cos(p.y)]);
  const marks = instanceOnPoints(box([0.04, 0.04, 0.08]).faceAttribute('mark', true), sites.rebind(sheet).points, {
    rotate: p => alignAxis('z', p.sample.normal),
  });
  return [
    view([sheet, marks], {
      key: 'rest-coordinates',
      camera: orthographic({ eye: [5, 7, 6], span: 5.3 }),
    }, lines => [
      strokes(lines.visible.filter(c => !c.faceAttributes.some(a => a.mark)), { stroke: 'outline' }),
      strokes(lines.visible.filter(c => c.faceAttributes.some(a => a.mark)), { stroke: 'marks' }),
    ]),
    label('REST / COORDINATES', 8, 94, 4, { stroke: 'outline' }),
  ];
});

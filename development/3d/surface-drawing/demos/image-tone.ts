import { sketchAsync, label, pen, mm } from 'occlude';
import { plane, view, orthographic } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: { ink: pen({ width: mm(0.2), color: '#18202A' }) } }, async t => {
  const sheet = plane(6, 4).subdivide(3).displace(p => [0, 0, 0.3 * Math.sin(p.x * 0.9)]);
  const ivy = t.image('ivy.png').surface({ channel: 'dark', area: 0.01 });
  const marks = await t.hatch(sheet, { direction: [1, 0.35, 0], spacing: 0.07, tone: ivy });
  return [
    view([sheet, marks], { camera: orthographic({ eye: [1, -6, 7], target: [0, 0, 0], span: 6.5 }), stroke: 'ink' }),
    label('IMAGE TONE', 8, 94, 4, { stroke: 'ink' }),
  ];
});

import { sketchAsync, label, pen, mm } from 'occlude';
import { sphere, gradient, across, light, view, perspective } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  warm: pen({ width: mm(0.18), color: '#A84932' }),
  cool: pen({ width: mm(0.18), color: '#2A6F8A' }),
} }, async t => {
  const ball = sphere(1.6, { segments: 40, rings: 24 });
  const height = gradient(s => s.position[2]);
  const sun = light({ direction: [-1, -2, 2], ambient: 0.1, ramp: 'smooth' });
  const marks = await t.hatch(ball, { spacing: 0.09, families: [
    { id: 'meridians', direction: height, tone: s => 0.25 + 0.75 * sun(s), stroke: 'warm' },
    { id: 'parallels', direction: across(height), tone: s => Math.max(0, 1.6 * sun(s) - 0.6), stroke: 'cool' },
  ] });
  return [
    view([ball, marks], { camera: perspective({ eye: [4, -6, 3], target: [0, 0, 0], fovDegrees: 36 }), stroke: 'ink' }),
    label('GRADIENT / ACROSS / LIGHT', 8, 94, 4, { stroke: 'ink' }),
  ];
});

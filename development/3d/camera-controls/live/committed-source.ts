import { sketchAsync, label, pen, mm } from 'occlude';
import { plane, light, view, orthographic } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#56626A' }),
} }, async t => {
  const sheet = plane(4, 4).subdivide(3)
    .faceAttributes({ heat: f => Math.exp(-3 * (f.center[0] ** 2 + f.center[1] ** 2)) })
    .steps(4, (current, next) => {
      next.setFaces(current.faces(), f => ({
        heat: 0.5 * f.heat + 0.5 * f.adjacent.map(a => a.heat).reduce((a, b) => a + b, 0) / Math.max(1, f.adjacent.length),
      }));
    });
  const warm = sheet.faces().filter(f => f.heat > 0.2);
  const model = sheet.extrude(warm, { distance: 0.7 }, { key: 'plateau' });
  const marks = await t.hatch(model, {
    direction: s => s.tangentU, spacing: 0.1, stroke: 'shade',
    tone: light({ direction: [-1, -1, 2], ambient: 0.1 }),
  });
  return [
    view([model, marks], { camera: orthographic({ eye: [-0.00859175, -0.00601513, 10.8381], target: [0, 0, 0.35], span: 6.27 }), stroke: 'ink' }),
    label('DIFFUSED / EXTRUDED', 8, 94, 4, { stroke: 'ink' }),
  ];
});

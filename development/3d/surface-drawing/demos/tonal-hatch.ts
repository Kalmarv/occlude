import { sketchAsync, paper, label, pen, mm, inch } from 'occlude';
import { torus, view, orthographic } from 'occlude/3d';

export default sketchAsync({
  seed: 42,
  paper: paper({ width: inch(8.5), height: inch(11), color: '#F5F0E6' }),
  pens: { ink: pen({ width: mm(0.2), color: '#18202A' }) },
}, async t => {
  const model = torus(1.4, 0.45, { segments: 36, tubeSegments: 14 });
  // Lit from above: the top keeps every other lane (tone 0.3), the sides and
  // the inner throat fill in as the surface turns away.
  const marks = await t.hatch(model, {
    direction: s => s.tangentU,
    spacing: 0.1,
    tone: s => 0.3 + 0.7 * (1 - Math.max(0, s.normal[2])),
  });
  return [
    view([model, marks], { camera: orthographic({ eye: [5, 7, 5], span: 5 }), stroke: 'ink' }),
    label('TONAL HATCH', 8, 94, 4, { stroke: 'ink' }),
  ];
});

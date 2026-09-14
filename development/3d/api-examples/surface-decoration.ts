import { sketch, pen, mm } from 'occlude';
import { box, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.15), color: '#56626A' }),
  section: pen({ width: mm(0.25), color: '#A84932' }),
} }, () => {
  const model = box([2.4, 1.8, 2.8])
    .faceAttribute('spacing', f => f.normal[2] > 0 ? 2 : 3);
  return view(model, {
    camera: orthographic({ eye: [5, 7, 6], span: 5 }), stroke: 'ink',
    hatch: [
      { spacing: f => mm(f.spacing), angle: 35, stroke: 'shade' },
      { spacing: f => mm(f.spacing * 2), angle: -35, stroke: 'shade', select: f => f.normal[2] > 0 },
    ],
    sections: [-0.8, 0, 0.8].map(height => ({
      origin: [0, 0, height], normal: [0, 0, 1], stroke: 'section',
    })),
  });
});

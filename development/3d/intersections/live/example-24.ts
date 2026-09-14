import { sketchAsync, strokes, label, pen, mm } from 'occlude';
import { box, view, orthographic } from 'occlude/3d';

export default sketchAsync({
  seed: 42,
  pens: {
    outline: pen({ width: mm(0.3), color: '#18202A' }),
    seam: pen({ width: mm(0.5), color: '#A84932' }),
  },
}, async t => {
  const block = box([2.8, 1.5, 1.6]).withKey('block');
  const tower = box([1, 1, 2.8]).translate([0.6, 0.3, 0.6]).withKey('tower');
  const seams = await t.intersections(block, tower, { key: 'seams' });
  return [
    view([block, tower, seams], {
      key: 'crossing-forms',
      camera: orthographic({ eye: [5, 7, 6], target: [0, 0, 0.4], span: 4.6 }),
    }, lines => [
      strokes(lines.visible.filter(c => !c.kinds.has('intersection')), { stroke: 'outline' }),
      strokes(lines.visible.filter(c => c.kinds.has('intersection')), { stroke: 'seam' }),
    ]),
    label('CROSSING / FORMS', 8, 94, 4, { stroke: 'outline' }),
  ];
});

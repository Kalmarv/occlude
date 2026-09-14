import { sketchAsync, label, pen, mm } from 'occlude';
import { box, view, orthographic, instanceOnPoints, alignAxis } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
} }, async t => {
  const block = box([2.8, 1.5, 1.6]).withKey('block');
  const tower = box([1, 1, 2.8]).translate([0.6, 0.3, 0.6]).withKey('tower');
  const seams = await t.intersections(block, tower);
  const sites = t.sample(seams, { spacing: 0.3 });
  const markers = instanceOnPoints(box([0.08, 0.08, 0.12]), sites.points, {
    rotate: p => alignAxis('z', p.sample.tangent),
  });
  return [
    view([block, tower, markers], {
      key: 'sampled-seams',
      camera: orthographic({ eye: [5, 7, 6], target: [0, 0, 0.4], span: 4.6 }),
      stroke: 'ink',
    }),
    label('FOLLOW / THE SEAM', 8, 94, 4, { stroke: 'ink' }),
  ];
});

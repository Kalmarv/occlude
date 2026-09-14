import { sketch, pen, mm } from 'occlude';
import { box, pointCloud, axisAngle, alignAxis, instanceOnPoints, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
} }, t => {
  const sites = pointCloud(t.times(7, (_, u) => [4 * (u - 0.5), 0, 0]));
  const fin = box([0.12, 0.55, 0.8]).translate([0, 0, 0.4]);
  const fins = instanceOnPoints(fin, sites.points, {
    rotate: p => alignAxis('z', [p.x * 0.5, 0.3, 1], {
      localUp: [0, 1, 0], up: [0, 1, 0], twist: p.index * 10,
    }),
  });
  const base = box([4.8, 0.8, 0.12])
    .rotate(axisAngle('z', 4)).translate([0, 0, -0.12]);
  return view([base, fins], {
    camera: orthographic({ eye: [5, 7, 5], target: [0, 0, 0.3], span: 6.2 }),
    stroke: 'ink',
  });
});

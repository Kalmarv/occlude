import { sketch, label, pen, mm } from 'occlude';
import { plane, cylinder, isolines, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, () => {
  const relief = plane(3, 3).subdivide(4)
    .displace(p => [0, 0, 0.5 * Math.sin(p.x * 2) * Math.cos(p.y * 1.5)])
    .attributes({ height: p => p.z });
  const heights = isolines(relief, 'height', { levels: { count: 7 } });
  const tube = cylinder(0.6, 2.2, { segments: 24 }).translate([2.6, 0, 1.1]);
  const rings = isolines(tube, c => c.chart === 'side' ? c.uv[1] : -1, { levels: { count: 8 } });
  return [
    view([relief, heights, tube, rings], { camera: orthographic({ eye: [5, 7, 6], span: 6 }), stroke: 'ink' }),
    label('ISOLINES / CROSS-CONTOURS', 8, 94, 4, { stroke: 'ink' }),
  ];
});

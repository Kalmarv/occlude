import { sketch, pen, mm, meanBy } from 'occlude';
import { plane, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  warm: pen({ width: mm(0.2), color: '#A84932' }),
} }, () => {
  const sheet = plane(4, 4).subdivide(3)
    .cornerAttributes({
      heat: c => Math.max(0, 1 - Math.hypot(c.face.center[0] + 0.7, c.point.y) / 2),
    })
    .steps(4, (current, next) => {
      next.setCorners(current.corners, c => ({
        heat: 0.5 * meanBy(c.point.corners, p => p.heat)
          + 0.5 * meanBy(c.face.corners, p => p.heat),
      }));
    })
    .faceAttributes({ heat: f => meanBy(f.corners, c => c.heat) })
    .displace(p => [0, 0, meanBy(p.corners, c => c.heat)]);
  return view(sheet, {
    camera: orthographic({ eye: [5, 7, 6], target: [0, 0, 0.3], span: 5.5 }),
    stroke: 'ink',
    hatch: { spacing: mm(1.5), angle: 35, stroke: 'warm', select: f => f.heat > 0.3 },
  });
});

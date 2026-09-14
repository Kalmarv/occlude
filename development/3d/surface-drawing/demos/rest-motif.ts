import { sketch, curve, strokes, label, pen, mm } from 'occlude';
import { plane, mapSurface, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  motif: pen({ width: mm(0.2), color: '#A84932' }),
} }, t => {
  const rest = plane(4).subdivide(4);
  const ring = (cx, cy, r) =>
    curve(t.times(40, k => [cx + r * Math.cos(k * Math.PI / 20), cy + r * Math.sin(k * Math.PI / 20)]));
  const motif = t.times(5, (_, u) => t.times(5, (_, v) => ring(0.1 + 0.8 * u, 0.1 + 0.8 * v, 0.07))).flat();
  const attached = mapSurface(rest, motif);
  const sheet = rest.displace(p => [0, 0, 0.5 * Math.sin(p.x * 1.5) * Math.cos(p.y)]);
  const marks = attached.rebind(sheet);
  return [
    view([sheet, marks], { camera: orthographic({ eye: [5, 7, 5], span: 6 }) }, lines => [
      strokes(lines.visible.filter(c => !c.kinds.has('mapped')), { stroke: 'ink' }),
      strokes(lines.visible.filter(c => c.kinds.has('mapped')), { stroke: 'motif' }),
    ]),
    label('REST MOTIF / REBOUND', 8, 94, 4, { stroke: 'ink' }),
  ];
});

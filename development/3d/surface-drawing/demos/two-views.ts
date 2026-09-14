import { sketch, paper, curve, strokes, clip, mask, rect, label, pen, mm } from 'occlude';
import { plane, box, grid, instanceOnPoints, mapSurface, view, orthographic, perspective } from 'occlude/3d';

export default sketch({ seed: 42, paper: paper({ width: mm(210), height: mm(148) }), pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  pattern: pen({ width: mm(0.18), color: '#A84932' }),
  note: pen({ width: mm(0.3), color: '#2A6F8A' }),
} }, t => {
  const rest = plane(3).subdivide(3);
  const waves = t.times(9, (_, u) => curve(t.times(24, (_, v) => [v, 0.1 + 0.8 * u + 0.03 * Math.sin(v * Math.PI * 4)]), { closed: false }));
  const sheet = rest.displace(p => [0, 0, 0.35 * Math.sin(p.x * 2) * Math.cos(p.y * 2)]);
  const marks = mapSurface(rest, waves).rebind(sheet);
  const tile = box([0.5, 0.5, 0.2]);
  const tileMarks = mapSurface(tile, t.times(4, (_, u) => curve([[0.15 + 0.7 * u, 0.1], [0.15 + 0.7 * u, 0.9]], { closed: false })), { chart: 'f1' });
  const tiles = instanceOnPoints(tile, grid({ cols: 4, rows: 2, spacing: 0.7 }).translate([0, -2.4, 0]).points, { rotate: p => [0, 0, p.i * 15] });
  const model = [sheet, marks, tiles, tileMarks.place(tiles)];
  const draw = lines => [
    strokes(lines.visible.filter(c => !c.kinds.has('mapped')), { stroke: 'ink' }),
    strokes(lines.visible.filter(c => c.kinds.has('mapped')), { stroke: 'pattern' }),
  ];
  // The plan is a zoomed detail clipped to its framed panel; the oblique view
  // shows the whole model. Both read the same captured geometry and marks.
  const panel = rect(3, 4, 44, 88);
  return [
    clip(panel, view(model, { key: 'plan', camera: orthographic({ eye: [0, -0.4, 10], target: [0, -0.4, 0], up: [0, 1, 0], span: 4.2 }), viewport: { x: 5, y: 8, width: 95, height: 130 } }, draw)),
    panel,
    view(model, { key: 'oblique', camera: perspective({ eye: [5, -7, 5], target: [0, -0.6, 0], fovDegrees: 40 }), viewport: { x: 110, y: 8, width: 95, height: 130 } }, draw),
    mask(rect(56, 86, 20, 7)),
    label('PLAN DETAIL', 6, 96, 3, { stroke: 'note' }),
    label('OBLIQUE', 58, 90, 3, { stroke: 'note' }),
    label('ONE MODEL / TWO VIEWS', 58, 96, 3, { stroke: 'ink' }),
  ];
});

import { sketch, paper, pen, mm, strokes, group, label, dash, wobble } from 'occlude';
import { box, plane, polyline, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, paper: paper({ width: mm(300), height: mm(150) }), margin: 0, pens: {
  outline: pen({ width: mm(0.3), color: '#18202A' }),
  hidden: pen({ width: mm(0.2), color: '#A84932' }),
} }, () => {
  const model = [
    box(0.8).translate([-1.5, -1, 0]).withKey('cube'),
    plane(4.5, 4).translate([0, 0, -0.8]).withKey('open-plane'),
    box([2.6, 0.7, 0.8]).translate([0.3, 0.1, 0]).withKey('cross-wide'),
    box([0.7, 1.4, 1.9]).translate([0.3, 0.1, 0.1]).withKey('cross-tall'),
    polyline([[-2.2, 0, 0.2], [2.2, 0, 0.2], [2.2, 1.5, 0.5]], { key: 'authored-wire' }),
  ];
  return view(model, {
    key: 'visibility-laboratory',
    camera: orthographic({ span: 7.2, eye: [5, 7, 6], near: 0.1, far: 30 }),
    viewport: { x: 5, y: 10, width: 90, height: 110 },
  }, lines => {
    const { visible, hidden } = lines;
    const contour = visible.filter(c => c.kinds.has('silhouette') || c.kinds.has('boundary') || c.kinds.has('wire'));
    // These are classified intervals; all three styles reuse the same result.
    console.info('visibility-laboratory', JSON.stringify({
      visible: visible.length, hidden: hidden.length, contour: contour.length,
      inspected: visible.rows.slice(0, 3).map(c => ({ id: c.id, range: c.range, support: c.support, objectId: c.feature.objectId, sourceId: c.feature.sourceId })),
    }));
    return [
      strokes(visible, { stroke: 'outline' }),
      strokes(hidden, { stroke: 'hidden', modifiers: [dash(mm(2), mm(1))] }),
      group({ translate: [mm(100), 0] }, [
        strokes(visible, { stroke: 'outline', modifiers: [dash(mm(3), mm(1)), wobble({ amount: mm(0.25), wavelength: mm(7) })] }),
        strokes(hidden, { stroke: 'hidden', modifiers: [dash(mm(1), mm(1.5))] }),
      ]),
      group({ translate: [mm(200), 0] }, strokes(contour, { stroke: 'outline' })),
      // label() takes numeric drawable units: 1 unit = 1.5 mm on this sheet.
      label('CLEAN / HIDDEN', 6, 89, 2.5),
      label('DASH / WOBBLE', 109 / 1.5, 89, 2.5),
      label('CONTOUR / WIRE', 209 / 1.5, 89, 2.5),
    ];
  });
});

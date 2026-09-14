import { sketch, paper, pen, mm, box3, grid3, transformSurface3, lineArt3, drawing3, FeatureSelection3, FeatureKind3, constructStrokes3, group, label, dash, wobble } from 'occlude';

export default sketch({ seed: 42, paper: paper({ width: mm(300), height: mm(150) }), margin: 0, pens: {
  outline: pen({ width: mm(0.3), color: '#18202A' }),
  hidden: pen({ width: mm(0.2), color: '#A84932' }),
} }, () => {
  const scene = lineArt3({ id: 'visibility-laboratory',
    objects: [
      { id: 'cube', surface: box3([0.8, 0.8, 0.8], [-1.5, -1, 0]) },
      { id: 'open-plane', surface: transformSurface3(grid3(1, 1, [4.5, 4]), { translate: [0, 0, -0.8] }) },
      { id: 'cross-wide', surface: box3([2.6, 0.7, 0.8], [0.3, 0.1, 0]) },
      { id: 'cross-tall', surface: box3([0.7, 1.4, 1.9], [0.3, 0.1, 0.1]) },
    ],
    wires: [{ id: 'authored-wire', points: [[-2.2, 0, 0.2], [2.2, 0, 0.2], [2.2, 1.5, 0.5]] }],
    camera: { kind: 'orthographic', span: 7.2, eye: [5, 7, 6], target: [0, 0, 0], near: 0.1, far: 30 },
    viewport: { x: 5, y: 10, width: 90, height: 110 }, lineSets: [],
  });
  return drawing3(scene, (classified, t) => {
    const features = new FeatureSelection3(classified);
    const dispatches = classified.stats.dispatches;
    const visible = constructStrokes3(classified, [{ id: 'edges', stroke: 'outline', select: features }]);
    const hidden = constructStrokes3(classified, [{ id: 'hidden', stroke: 'hidden', visibility: 'hidden', select: features }]);
    const contour = constructStrokes3(classified, [{ id: 'contour', stroke: 'outline', select: features.filter(row => (row.feature.flags & (FeatureKind3.silhouette | FeatureKind3.boundary | FeatureKind3.wire)) !== 0) }]);
    // Inspect source IDs, parameter ranges and break reasons in the console.
    console.info('visibility-laboratory', JSON.stringify({
      dispatchesBeforeStyles: dispatches, dispatchesAfterStyles: classified.stats.dispatches,
      selected: features.length, visible: visible.length, hidden: hidden.length, contour: contour.length,
      inspected: visible.slice(0, 3).map(stroke => ({ id: stroke.id, length: stroke.length, parts: stroke.parts, breaks: stroke.breaks })),
    }));
    return [
      t.strokes3(visible), t.strokes3(hidden, { modifiers: [dash(mm(2), mm(1))] }),
      group({ translate: [mm(100), 0] }, [
        t.strokes3(visible, { modifiers: [dash(mm(3), mm(1)), wobble({ amount: mm(0.25), wavelength: mm(7) })] }),
        t.strokes3(hidden, { modifiers: [dash(mm(1), mm(1.5))] }),
      ]),
      group({ translate: [mm(200), 0] }, t.strokes3(contour)),
      // label() takes numeric drawable units: 1 unit = 1.5 mm on this sheet.
      label('CLEAN / HIDDEN', 6, 89, 2.5),
      label('DASH / WOBBLE', 109 / 1.5, 89, 2.5),
      label('CONTOUR / WIRE', 209 / 1.5, 89, 2.5),
    ];
  });
});

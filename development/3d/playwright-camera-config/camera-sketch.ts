import { sketchAsync, grid3, FaceSelection3, extrudeFaces3, transformSurface3, section3, hatch3, lineArt3, drawing3, FeatureKind3, constructStrokes3, clip, rect, mask, label, paper, pen, mm } from 'occlude';

export default sketchAsync({ ...({ seed: 42, paper: paper({ width: mm(200), height: mm(200) }), margin: 5, pens: {
  outline: pen({ width: mm(0.3), color: '#18202A' }),
  fine: pen({ width: mm(0.18), color: '#56626A' }),
  accent: pen({ width: mm(0.25), color: '#A84932' }),
} }), cameras3: {
    "@1": {"kind":"orthographic","span":5.5,"eye":[6.94517638420231,1.0535457258548449,7.884287968527898],"target":[0,0,0.4],"near":0.1,"far":30,"up":[0,0,1]}
  } }, async t => {
  let surface = grid3(6, 6, [4, 4]);
  surface.faces.forEach(face => {
    face.attributes.height = t.rnd(0.5, 1.5);
    face.attributes.spacing = t.rnd(1.5, 2.5);
  });
  const selected = new FaceSelection3(surface).filter(f => f.index % 6 % 2 === 0 && Math.floor(f.index / 6) % 2 === 0);
  surface = extrudeFaces3(surface, selected, f => Number(f.attributes.height), { operation: 'hatched-towers' });
  surface = await t.deform3(surface, { iterations: 8, relaxation: 0,
    displacements: surface.points.map(p => p.position[2] > 0 ? [0.003 * Math.sin(p.position[1]), 0.002 * Math.cos(p.position[0]), 0] : [0, 0, 0]),
  });
  const ceiling = transformSurface3(grid3(1, 1, [8, 8]), { translate: [0, 0, 1.1] });
  const hits = await t.querySurface3(ceiling, { nearest: surface.points.map(p => ({ point: p.position })) });
  surface.points.forEach((p, i) => { const hit = hits.nearest[i]; if (hit && p.position[2] > hit.point[2]) p.position = hit.point; });
  const sections = section3(surface, [0.2, 0.4, 0.6, 0.8].map((height, i) => ({ id: `level-${i}`, origin: [0, 0, height], normal: [0, 0, 1] })));
  const hatch = hatch3(sections.surface, face => {
    if (face.attributes.role !== 'side' && face.attributes.role !== 'cap') return [];
    const spacing = Number(face.attributes.spacing);
    return [
      { id: 'shade', spacing: mm(spacing), angle: face.normal[2] > 0.5 ? 35 : -35 },
      ...(face.normal[2] > 0.5 ? [{ id: 'cross', spacing: mm(spacing * 2), angle: -35 }] : []),
    ];
  });
  const scene = lineArt3({
    objects: [{ id: 'relief', surface: hatch.surface, hatch, curves: sections }],
    camera: { kind: 'orthographic', span: 5.5, eye: [5, 7, 6], target: [0, 0, 0.4], near: 0.1, far: 30 }, lineSets: [],
  });
  return drawing3(scene, (classified, t) => {
    const strokes = constructStrokes3(classified, [
      { id: 'edges', stroke: 'outline', select: f => (f.flags & (FeatureKind3.crease | FeatureKind3.silhouette | FeatureKind3.boundary)) !== 0 },
      { id: 'hatch', stroke: 'fine', select: f => (f.flags & FeatureKind3.hatch) !== 0 },
      { id: 'sections', stroke: 'accent', select: f => (f.flags & FeatureKind3.section) !== 0 },
    ]);
    return [
      clip(rect(4, 4, 92, 84), t.strokes3(strokes)),
      mask(rect(60, 75, 32, 13)),
      label('HATCH / SECTIONS', 61, 78, 2.5, { stroke: 'outline' }),
      label('PAPER SPACING', 61, 83, 2, { stroke: 'outline' }),
      label('SURFACE STUDY', 8, 94, 4, { stroke: 'outline' }),
    ];
  });
});

import { sketchAsync, box3, hatch3, lineArt3, drawing3, constructStrokes3, FeatureKind3, clip, rect, mask, label, pen, mm } from 'occlude';
import { pigma_01_black as fineliner } from '@user/pens';
import { Letter } from '@user/papers';

// US Letter: 8.5 × 11 inches. Download in Studio bundles both library imports.
export default sketchAsync({ seed: 42, paper: Letter({ color: '#F5F0E6' }), margin: 5, pens: {
  graphite: fineliner({ color: '#18202A' }),
  rust: fineliner({ color: '#A84932' }),
  caption: pen({ width: mm(0.4), color: '#234B65', feed: 2100, penDelay: 140 }),
} }, async () => {
  const hatch = hatch3(box3([2.8, 1.5, 1.6]), [{ id: 'ruling', spacing: mm(1.8), angle: 35 }]);
  const scene = lineArt3({ id: 'paper-study',
    objects: [{ id: 'block', surface: hatch.surface, hatch }, { id: 'tower', surface: box3([1, 1, 2.8], [0.6, 0.3, 0.6]) }],
    camera: { kind: 'orthographic', span: 4.6, eye: [5, 7, 6], target: [0, 0, 0.4], near: 0.1, far: 30 },
    lineSets: [],
  });
  return drawing3(scene, (view, t) => [
    clip(rect(4, 6, 92, 112), t.strokes3(constructStrokes3(view, [
      { id: 'edges', stroke: 'graphite', select: f => (f.flags & (FeatureKind3.crease | FeatureKind3.silhouette | FeatureKind3.boundary)) !== 0 },
      { id: 'hatch', stroke: 'rust', select: f => (f.flags & FeatureKind3.hatch) !== 0 },
    ]))),
    mask(rect(52, 76, 44, 17)),
    label('SOLID / PAPER', 54, 79, 3.3, { stroke: 'caption' }),
    label('LETTER - STUDY 03', 54, 86, 2.2, { stroke: 'caption' }),
    label('OCCLUDE', 6, 116, 4, { stroke: 'graphite' }),
    label('TWO INKS / ONE MODEL', 6, 123, 2.3, { stroke: 'rust' }),
  ]);
});

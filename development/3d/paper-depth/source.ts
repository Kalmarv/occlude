import { sketchAsync, box3, hatch3, lineArt3, drawing3, constructStrokes3, FeatureKind3, clip, rect, mask, label, pen, mm, penModel, paperModel } from 'occlude';
// ---- @user/pens bundled: pigma-01-black ----
const fineliner = penModel({"name":"pigma-01-black","width":0.25,"color":"#111111","feed":3000,"penDown":0,"penUp":5,"penDelay":100});
// ---- @user/papers bundled: Letter ----
const Letter = paperModel({"w":215.9,"h":279.4,"color":"#f6f2ea"});

// US Letter: 8.5 × 11 inches. Download in Studio bundles both library imports.
export default sketchAsync({ ...({ seed: 42, paper: Letter({ color: '#F5F0E6' }), margin: 5, pens: {
  graphite: fineliner({ color: '#18202A' }),
  rust: fineliner({ color: '#A84932' }),
  caption: pen({ width: mm(0.4), color: '#234B65', feed: 2100, penDelay: 140 }),
} }), cameras3: {
    "paper-study": {"kind":"orthographic","span":4.6,"eye":[7.002452800089903,3.921911867185166,6.798770357540987],"target":[0,0,0.4],"near":0.1,"far":30,"up":[0,0,1]}
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

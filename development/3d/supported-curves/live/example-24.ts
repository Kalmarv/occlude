import { sketch, strokes, label, pen, mm } from 'occlude';
import { mesh, view, orthographic } from 'occlude/3d';
import { SurfaceCurves, surfaceBinding3, surfaceCurveNetwork3 } from 'occlude/3d/advanced';

export default sketch({
  seed: 42,
  pens: {
    outline: pen({ width: mm(0.3), color: '#18202A' }),
    seam: pen({ width: mm(0.4), color: '#A84932' }),
  },
}, () => {
  const a = mesh([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 1, 2]]);
  const b = mesh([[0, 0, 0], [1, 1, 0], [0, 0, 1]], [[0, 1, 2]]);
  const seam = new SurfaceCurves(surfaceCurveNetwork3({
    sources: [
      { id: 'a', binding: surfaceBinding3(a.surface) },
      { id: 'b', binding: surfaceBinding3(b.surface) },
    ],
    nodes: [
      { id: 'top', point: [0n, 0n, 1n, 1n] },
      { id: 'thirds', point: [1n, 1n, 1n, 3n] },
      { id: 'base', point: [1n, 1n, 0n, 2n] },
    ],
    segments: [
      { id: 'upper', kind: 'intersection', a: 'top', b: 'thirds',
        chainId: 'seam', range: [0, 2 / 3],
        supports: [{ source: 0, triangle: 0 }, { source: 1, triangle: 0 }] },
      { id: 'lower', kind: 'intersection', a: 'thirds', b: 'base',
        chainId: 'seam', range: [2 / 3, 1],
        supports: [{ source: 0, triangle: 0 }, { source: 1, triangle: 0 }] },
    ],
  }));
  return [
    view([a, b, seam], {
      camera: orthographic({ eye: [3, 4, 3], target: [0.4, 0.4, 0.4], span: 1.8 }),
    }, lines => [
      strokes(lines.visible.filter(c => c.kinds.has('boundary')), { stroke: 'outline' }),
      strokes(lines.visible.filter(c => c.kinds.has('intersection')), { stroke: 'seam' }),
    ]),
    label('EXACT / SHARED SEAM', 8, 94, 4, { stroke: 'outline' }),
  ];
});

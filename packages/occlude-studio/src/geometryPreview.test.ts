import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';
import {
  material,
  circle,
  path,
  sketch,
  compileSketch,
  inspectIfMaterial,
  getInspectionIndex,
  setInspectHint,
  DEFAULT_PENS,
} from 'occlude';
import { sketchFrame } from '../../occlude/src/record.js';
import {
  sampleField,
  geometryPreview,
  defaultFieldBounds,
} from './geometryPreview.js';
import { fieldColor } from './geometryPreviewPanel.js';
import { analyzeGeometry } from './geometryAnalysis.js';
import { emitInspection } from './inspectionEmit.js';
import { runSketch, currentDraws } from './runner.js';

const options = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  skipLibCheck: true,
  strict: true,
};
function compile(source: string) {
  const file = resolve('inspection-fixture.ts'),
    host = ts.createCompilerHost(options),
    read = host.readFile.bind(host),
    exists = host.fileExists.bind(host);
  host.readFile = (p) => (p === file ? source : read(p));
  host.fileExists = (p) => p === file || exists(p);
  const program = ts.createProgram([file], options, host),
    annotations = analyzeGeometry(ts, program, file, [
      { start: 0, end: source.length },
    ]);
  return {
    js: emitInspection(ts, source, file, '4', options, annotations),
    annotations,
  };
}
const cfg = {
  pens: DEFAULT_PENS,
  paper: 'A4',
  landscape: false,
  defaultMarginPct: 5,
  coarsen: 1,
  draws: true,
};
describe('field grids', () => {
  it('samples cell centres once and reports signed extrema', () => {
    let calls = 0;
    const p = sampleField(
      (x, y) => {
        calls++;
        return x - y;
      },
      false,
      { xMin: 0, xMax: 32, yMin: 0, yMax: 32 },
      32,
    );
    expect(calls).toBe(1024);
    expect(p.min).toBe(-31);
    expect(p.max).toBe(31);
    expect(p.values[0]).toBe(0);
  });
  it('keeps invalid and thrown samples distinct from zero', () => {
    const p = sampleField(
      (x) => {
        if (x < 0) throw Error('outside');
        return x > 0.5 ? NaN : 0;
      },
      false,
      { xMin: -1, xMax: 1, yMin: -1, yMax: 1 },
      16,
    );
    expect(p.errors).toBe(128);
    expect(p.invalid).toBe(192);
    expect(p.min).toBe(0);
    expect(p.max).toBe(0);
    expect(fieldColor(NaN, 0, 0)).not.toBe(fieldColor(0, 0, 0));
  });
  it('retains vector components and uses magnitude for color', () => {
    const p = sampleField(
      () => [3, 4],
      true,
      { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      16,
    );
    expect(p.min).toBe(5);
    expect(p.max).toBe(5);
    expect(p.u![0]).toBe(3);
    expect(p.v![0]).toBe(4);
  });
  it('rejects invalid grids before calling the function', () => {
    let calls = 0;
    expect(() =>
      sampleField(() => ++calls, false, { xMin: 1, xMax: 0, yMin: 0, yMax: 1 }),
    ).toThrow(/bounds/);
    expect(() =>
      sampleField(
        () => ++calls,
        false,
        { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
        10000,
      ),
    ).toThrow(/grid/);
    expect(calls).toBe(0);
  });
});
describe('geometry captures', () => {
  it('captures module fields and nested inline selections without changing scene or draw addresses', () => {
    const source = `import {sketch,circle,strokes,type FieldFn} from 'occlude';
   const density:FieldFn=(x,y)=>x-y;
   export default sketch({seed:42},t=>{
    const m=t.sample(circle(50,50,t.rnd(20,30)),{count:8});
    return strokes(m.points.filter(p=>p.x>50).inducedEdges());
   });`;
    const compiled = compile(source),
      plain = runSketch(
        ts.transpileModule(source, { compilerOptions: options }).outputText,
        cfg,
      ),
      draws = currentDraws();
    const inspected = runSketch(compiled.js, {
      ...cfg,
      inspect: true,
      inspectionCompiled: true,
    });
    expect(inspected.error).toBeNull();
    expect(inspected.scene).toEqual(plain.scene);
    expect(currentDraws()).toEqual(draws);
    const entries = getInspectionIndex();
    expect(
      entries.some((e) => e.source?.label === 'density' && e.kind === 'scalar'),
    ).toBe(true);
    for (const label of ['filter', 'points', 'inducedEdges', 'circle'])
      expect(
        entries.some((e) => e.source?.label === label && e.source.expression),
        label,
      ).toBe(true);
    const field = entries.find((e) => e.kind === 'scalar')!;
    expect(() => geometryPreview(field.name, sketchFrame())).toThrow(
      /Sample field/,
    );
    expect(
      geometryPreview(field.name, sketchFrame(), { sample: true }).kind,
    ).toBe('field');
    setInspectHint(false);
  });
  it('preserves write targets, callback parameters and directive prologues', () => {
    const source = `import {sketch,circle,strokes,type Vertex} from 'occlude';
   export default sketch({seed:42},t=>{
    const m=t.sample(circle(50,50,20),{count:8});
    const box={points:m.points};
    ({value:box.points}={value:m.points.filter(p=>p.x>50)});
    const test=function(p:Vertex){"use strict"; return this===undefined && p.x>0;};
    if(!test(box.points.at(0)))throw Error('directive lost');
    return strokes(box.points.inducedEdges());
   });`;
    const compiled = compile(source),
      plain = runSketch(
        ts.transpileModule(source, { compilerOptions: options }).outputText,
        cfg,
      );
    const inspected = runSketch(compiled.js, {
      ...cfg,
      inspect: true,
      inspectionCompiled: true,
    });
    expect(inspected.error).toBeNull();
    expect(inspected.scene).toEqual(plain.scene);
    expect(
      getInspectionIndex().some(
        (e) =>
          e.kind === 'vertex' && e.source?.label === 'p' && e.occurrences === 8,
      ),
    ).toBe(true);
    setInspectHint(false);
  });
  it('preserves face holes, areas and source walls', () => {
    setInspectHint(true);
    compileSketch(
      sketch({ seed: 42 }, () => {
        const m = material(
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [3, 3],
            [7, 3],
            [7, 7],
            [3, 7],
          ],
          {
            edges: [
              [0, 1],
              [1, 2],
              [2, 3],
              [3, 0],
              [4, 5],
              [5, 6],
              [6, 7],
              [7, 4],
            ],
          },
        );
        inspectIfMaterial('faces', m.faces());
        return circle(50, 50, 20);
      }),
    );
    const p = geometryPreview('faces', sketchFrame());
    expect(p.kind).toBe('faces');
    if (p.kind === 'faces') {
      expect(
        p.faces.some((f) => f.area === 84 && f.contours.length === 2),
      ).toBe(true);
      expect(p.faces.every((f) => f.sourceEdges.length > 0)).toBe(true);
    }
    setInspectHint(false);
  });
  it('preserves selection source rows and column values', () => {
    setInspectHint(true);
    compileSketch(
      sketch({ seed: 42 }, () => {
        const m = material(
          [
            [1, 2],
            [3, 4],
            [5, 6],
          ],
          {
            edges: [
              [0, 1],
              [1, 2],
            ],
            weight: [0, 1, 2],
          },
        );
        inspectIfMaterial(
          'sel',
          m.edges.filter((e) => e.index === 1),
        );
        return circle(50, 50, 20);
      }),
    );
    const p = geometryPreview('sel', sketchFrame());
    expect(p.kind).toBe('graph');
    if (p.kind === 'graph') {
      expect(p.sourcePoints).toEqual([1, 2]);
      expect(p.sourceEdges).toEqual([1]);
      expect(Array.from(p.material.attrs.weight)).toEqual([1, 2]);
    }
    setInspectHint(false);
  });
  it('retains native cubics rather than flattening into material', () => {
    setInspectHint(true);
    compileSketch(
      sketch({ seed: 42 }, () => {
        inspectIfMaterial(
          'native',
          path().moveTo(10, 10).bezierTo(20, 0, 30, 40, 50, 50).build(),
        );
        return circle(50, 50, 20);
      }),
    );
    const p = geometryPreview('native', sketchFrame());
    expect(p.kind).toBe('native');
    if (p.kind === 'native')
      expect(p.contours.flat().some((p) => p.t === 'cubic')).toBe(true);
    setInspectHint(false);
  });
  it('keeps station point and edge columns separate', () => {
    setInspectHint(true);
    compileSketch(
      sketch({ seed: 42 }, () => {
        const m = material(
          [
            [0, 0],
            [10, 0],
          ],
          { edges: [[0, 1]], same: 2 },
        ).edgeAttribute('same', 7);
        inspectIfMaterial('stations', m.along({ count: 3 }));
        return circle(50, 50, 20);
      }),
    );
    const p = geometryPreview('stations', sketchFrame());
    expect(p.kind).toBe('graph');
    if (p.kind === 'graph') {
      expect(p.material.attrs['point.same'][0]).toBe(2);
      expect(p.material.attrs['edge.same'][0]).toBe(7);
      expect(p.directions).toHaveLength(3);
    }
    setInspectHint(false);
  });
  it('uses centered bounds in centered sketches', () => {
    compileSketch(
      sketch({ seed: 42, origin: 'center', aspect: [2, 1] }, () =>
        circle(0, 0, 20),
      ),
    );
    expect(defaultFieldBounds(sketchFrame())).toEqual({
      xMin: -100,
      xMax: 100,
      yMin: -50,
      yMax: 50,
    });
  });
});

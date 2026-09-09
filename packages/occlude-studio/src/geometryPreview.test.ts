import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  getInspectionValues,
  getInspectionPlacements,
} from '../../occlude/src/state.js';
import {
  initOcclude,
  render,
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
import { decodeFragments } from '../../occlude/src/render.js';
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
  pens: [...DEFAULT_PENS, { ...DEFAULT_PENS[0], name: 'micron-01' }],
  seed: 42,
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
  it('retains every loop occurrence, separates graph connectivity, and records final placements', async () => {
    await initOcclude(
      readFileSync(
        resolve('../../crates/occlude-core/pkg/occlude_core_bg.wasm'),
      ),
    );
    const source = `import {sketch,circle,polygon,smooth} from 'occlude';
      export default sketch({seed:42},t=>{
        const stations=t.sample(circle(50,50,20),{count:8}).along({count:8});
        const pieces=stations.map(s=>{
          const ring=t.sample(circle(s.x,s.y,2),{count:3});
          const piece=polygon([[0,0],[4,0],[0,4]],{translate:[s.x,s.y],opaque:true});
          return [smooth(2,piece)];
        });
        return t.group({translate:[10,20],scale:0.5},pieces);
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
    const entries = getInspectionIndex(),
      piece = entries.find((e) => e.source?.label === 'piece')!,
      ring = entries.find((e) => e.source?.label === 'ring')!,
      pieces = entries.find((e) => e.source?.label === 'pieces')!;
    expect(piece.retainedOccurrences).toBe(8);
    expect(getInspectionValues(piece.name)).toHaveLength(8);
    expect(
      getInspectionPlacements(getInspectionValues(piece.name)[0])[0].transforms,
    ).toContainEqual({ translate: [10, 20], rotate: undefined, scale: 0.5 });
    const graph = geometryPreview(ring.name, sketchFrame());
    expect(graph.kind).toBe('graph');
    if (graph.kind === 'graph') {
      expect(graph.material.n).toBe(24);
      expect(graph.material.edges.length).toBe(48);
      expect(graph.occurrences).toEqual(
        Array.from({ length: 24 }, (_, i) => Math.floor(i / 3) + 1),
      );
    }
    const native = geometryPreview(piece.name, sketchFrame());
    expect(native.kind).toBe('native');
    if (native.kind === 'native') {
      expect(native.items).toHaveLength(8);
      expect(native.shapeIds).toHaveLength(8);
      expect(JSON.parse(native.items[0].options).opaque).toBe(true);
      const actual = render({ paper: 'A4' }),
        ids = new Set(native.shapeIds);
      const visible = decodeFragments(
        actual.raw.prims,
        actual.raw.frags,
        ids,
        100000,
      ).frags;
      expect(visible).toEqual(actual.frags.filter((f) => ids.has(f.shape)));
      expect(visible.length).toBeGreaterThan(native.contours.flat().length);
      expect(() =>
        decodeFragments(actual.raw.prims, actual.raw.frags, ids, 1),
      ).toThrow(/exceeds/);
    }
    expect(geometryPreview(pieces.name, sketchFrame()).kind).toBe('native');
    setInspectHint(false);
  });
  it('captures the saved along sketch, including its nested map and every polygon', () => {
    const source = readFileSync(resolve('sketches/along.ts'), 'utf8'),
      compiled = compile(source);
    const plain = runSketch(
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
    const entries = getInspectionIndex(),
      polygon = entries.find((e) => e.source?.label === 'polygon')!,
      mapped = entries.find((e) => e.source?.label === 'map')!;
    expect(mapped).toBeDefined();
    expect(polygon.retainedOccurrences).toBe(polygon.occurrences);
    expect(polygon.occurrences).toBeGreaterThan(2);
    const p = geometryPreview(polygon.name, sketchFrame());
    expect(p.kind).toBe('native');
    if (p.kind === 'native') {
      expect(p.items).toHaveLength(polygon.occurrences!);
      expect(p.shapeIds).toHaveLength(polygon.occurrences!);
    }
    setInspectHint(false);
  });
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

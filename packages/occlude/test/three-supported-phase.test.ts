import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import * as core from '../../../crates/occlude-core/pkg/occlude_core.js';
import {
  compileSketchAsync,
  constructStrokes3,
  dash,
  decodePlanBuffer,
  evalPrim,
  initOcclude,
  lineArt3,
  mm,
  pen,
  render,
  sketchAsync,
  wobble,
} from '../src/index.js';
import { pensToJson } from '../src/render.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { featureSnapshot3 } from '../src/three/features/snapshot.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';
import { point } from '../src/three/geometry/exact.js';
import { mesh } from '../src/three/api/mesh.js';
import { surfaceBinding3, surfaceCurveNetwork3, selectSurfaceCurveNetwork3, type SurfaceCurveNetwork3 } from '../src/three/curves/network.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

const frame = cameraFrame3({ kind: 'orthographic', span: 12, eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], near: .1, far: 10 }, { x: 0, y: 0, width: 120, height: 120 });
const binding = surfaceBinding3(mesh([[0, 0, 0], [10, 0, 0], [0, 10, 0]], [[0, 1, 2]]).surface);
const objects = [{ id: 'sheet', surface: binding.source, lineSource: false }];
const p = (id: string, x: number, y: number) => ({ id, point: point([x, y, 0]), supports: [{ source: 0, triangle: 0 }] });

function graph(subdivided = false, order: number[] = []): SurfaceCurveNetwork3 {
  const nodes = subdivided
    ? [p('a', 1, 1), p('b', 3, 1), p('c', 5, 1), p('d', 7, 1), p('e', 9, 1)]
    : [p('a', 1, 1), p('c', 5, 1), p('e', 9, 1)];
  const rows = subdivided
    ? [['s0', 'a', 'b', 0, .25], ['s1', 'b', 'c', .25, .5], ['s2', 'c', 'd', .5, .75], ['s3', 'd', 'e', .75, 1]]
    : [['s0', 'a', 'c', 0, .5], ['s1', 'c', 'e', .5, 1]];
  const segments = rows.map(([id, a, b, lo, hi]) => ({ id: id as string, kind: 'mapped' as const, a: a as string, b: b as string, chainId: 'main', range: [lo as number, hi as number] as [number, number], supports: [{ source: 0, triangle: 0 }], attributes: { role: id === 's0' ? 'keep' : 'other' } }));
  return surfaceCurveNetwork3({ sources: [{ id: 'sheet', binding }], nodes, segments: order.length ? order.map(i => segments[i]) : segments });
}

function classify(network: SurfaceCurveNetwork3) {
  const scene = lineArt3({ objects, curves: [{ id: 'marks', network }], camera: frame.camera, lineSets: [] });
  return classifySceneCpu3(featureSnapshot3(scene.objects, [], frame, undefined, scene.curves));
}

const set = [{ id: 'ink', stroke: 'ink' }];
const shape = (strokes: readonly ReturnType<typeof constructStrokes3>[number][]) => strokes.map(s => ({ id: s.id, reference: s.reference, sourceRanges: s.sourceRanges, points: s.points, breaks: s.breaks }));

describe('supported graph phase identity', () => {
  it('gives plain and collinearly subdivided chains the same reference identity and points', () => {
    const plain = constructStrokes3(classify(graph()), set);
    const subdivided = constructStrokes3(classify(graph(true)), set);
    expect(subdivided).toHaveLength(1);
    expect(subdivided[0].reference).toEqual(plain[0].reference);
    expect(subdivided[0].reference.points).toEqual(plain[0].reference.points);
    expect(subdivided[0].sourceRanges).toEqual(plain[0].sourceRanges);
  });

  it('keeps phase after extracting one edge and retains branches without joining distinct chains', () => {
    const full = graph();
    const selected = selectSurfaceCurveNetwork3(full, [1]);
    const before = constructStrokes3(classify(full), set);
    const after = constructStrokes3(classify(selected), set);
    expect(after[0].reference).toEqual(before[0].reference);
    expect(after[0].sourceRanges[0][0]).toBeCloseTo(.5, 12);
    expect(after[0].sourceRanges[0][1]).toBe(1);

    const branched = surfaceCurveNetwork3({
      sources: [{ id: 'sheet', binding }],
      nodes: [p('o', 1, 1), p('a', 3, 1), p('b', 1, 3), p('c', 9, 1)],
      segments: [
        { id: 'oa', kind: 'trace', a: 'o', b: 'a', chainId: 'branch-a', supports: [{ source: 0, triangle: 0 }] },
        { id: 'ob', kind: 'trace', a: 'o', b: 'b', chainId: 'branch-b', supports: [{ source: 0, triangle: 0 }] },
        { id: 'ce', kind: 'trace', a: 'a', b: 'c', chainId: 'separate', supports: [{ source: 0, triangle: 0 }] },
      ],
    });
    const branches = constructStrokes3(classify(branched), set);
    expect(branches).toHaveLength(3);
    expect(new Set(branches.map(s => s.reference.id)).size).toBe(3);
  });

  it('keeps the full source reference through an attribute based style filter and options', () => {
    const classified = classify(graph());
    const all = constructStrokes3(classified, set);
    const filtered = constructStrokes3(classified, [{ ...set[0], select: f => f.attributes.role === 'keep' }]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].reference).toEqual(all[0].reference);
    const unchained = constructStrokes3(classified, set, { chain: false });
    expect(unchained).toHaveLength(2);
    expect(unchained.every(s => s.reference)).toBe(true);
    expect(unchained[0].reference).toEqual(all[0].reference);
    expect(unchained[1].reference).toEqual(all[0].reference);
    expect(unchained[0].reference).toBe(unchained[1].reference);
    const corner = constructStrokes3(classified, set, { cornerDegrees: 0 });
    expect(corner[0].reference).toEqual(all[0].reference);
  });

  it('keeps loop start and direction stable when graph segments are reordered', () => {
    const loop = (order: number[]) => surfaceCurveNetwork3({
      sources: [{ id: 'sheet', binding }],
      nodes: [p('a', 1, 1), p('b', 3, 1), p('c', 3, 3), p('d', 1, 3)],
      segments: order.map(i => [
        { id: 'ab', kind: 'mapped' as const, a: 'a', b: 'b', chainId: 'loop', range: [0, .25] as [number, number] },
        { id: 'bc', kind: 'mapped' as const, a: 'b', b: 'c', chainId: 'loop', range: [.25, .5] as [number, number] },
        { id: 'cd', kind: 'mapped' as const, a: 'c', b: 'd', chainId: 'loop', range: [.5, .75] as [number, number] },
        { id: 'da', kind: 'mapped' as const, a: 'd', b: 'a', chainId: 'loop', range: [.75, 1] as [number, number] },
      ][i]).map(segment => ({ ...segment, supports: [{ source: 0, triangle: 0 }] })),
    });
    const a = constructStrokes3(classify(loop([0, 1, 2, 3])), set);
    const b = constructStrokes3(classify(loop([2, 0, 3, 1])), set);
    expect(shape(b)).toEqual(shape(a));
  });

  it('produces equal planned wobble and dash output for equivalent graph subdivisions', async () => {
    const planned = async (network: SurfaceCurveNetwork3) => {
      const execution = await compileSketchAsync(sketchAsync({ seed: 42, margin: 0, pens: { ink: pen({ width: mm(.2) }) } }, async t => {
        const classified = await t.classify3(lineArt3({ objects, curves: [{ id: 'marks', network }], camera: frame.camera, lineSets: [] }));
        return t.strokes3(constructStrokes3(classified, set), { modifiers: [wobble({ amount: mm(.15), wavelength: mm(4) }), dash(mm(2), mm(1))] });
      }), { paper: { w: 120, h: 120 } });
      const output = render(execution);
      const plan = core.wasm_plan(output.raw.prims, output.raw.frags, pensToJson(output.pens), 200000, .01);
      return decodePlanBuffer(plan).map(chain => chain.prims.map(prim => [prim.t, evalPrim(prim, 0), evalPrim(prim, 1)]));
    };
    expect(await planned(graph(true))).toEqual(await planned(graph()));
  });
});

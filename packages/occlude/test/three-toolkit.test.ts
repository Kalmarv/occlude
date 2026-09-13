import { describe, expect, it } from 'vitest';
import { compileSketch, compileSketchAsync, grid3, sketch, sketchAsync, type Surface3 } from '../src/index.js';
import { deformSurfaceCpu3 } from '../src/three/geometry/deform.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';

describe('3D modeling toolkit', () => {
  it('materializes deformation before batched queries and keeps input geometry owned', async () => {
    const original = grid3(2, 2, [2,2]);
    let result!: Surface3;
    const run = await compileSketchAsync(sketchAsync({ seed: 42 }, async t => {
      const pending = t.deform3(original, { iterations: 4, relaxation: .1, displacements: original.points.map(() => [0,0,.1]), pinned: [0] });
      original.points[1].position = [100,100,100];
      result = await pending;
      const hits = await t.querySurface3(grid3(1,1,[10,10]), {
        rays: [{ origin: [0,0,1], direction: [0,0,-1] }],
        segments: [[[0,0,1],[0,0,-1]]],
        nearest: result.points.map(p => ({ point: p.position })),
      });
      expect(hits.rays[0]?.distance).toBe(1);
      expect(hits.segments[0]?.distance).toBe(.5);
      expect(hits.nearest).toHaveLength(9);
      for (const hit of hits.nearest) { expect(hit).not.toBeNull(); expect(hit!.point[2]).toBeCloseTo(0, 12); }
      return null;
    }));
    const reference = grid3(2,2,[2,2]);
    expect(result.points).toEqual(deformSurfaceCpu3(reference, { iterations: 4, relaxation: .1, displacements: reference.points.map(() => [0,0,.1]), pinned: [0] }).points);
    expect(run.modeling3.map(s => [s.operation,s.backend])).toEqual([['deform','cpu'],['query','cpu']]);
  });
  it('rejects synchronous use and never silently substitutes CPU for a missing host operation', async () => {
    expect(() => compileSketch(sketch({}, t => { void t.deform3(grid3(1,1), { iterations: 1, relaxation: 0 }); return null; }))).toThrow('require sketchAsync');
    await expect(compileSketchAsync(sketchAsync({}, async t => { await t.deform3(grid3(1,1), { iterations: 1, relaxation: 0 }); return null; }), undefined, { compute3: { async classify(s) { return classifySceneCpu3(s); } } })).rejects.toThrow('does not provide GPU deformation');
  });
  it('does not adopt a cancelled host operation', async () => {
    const controller = new AbortController();
    await expect(compileSketchAsync(sketchAsync({}, async t => { await t.deform3(grid3(1,1), { iterations: 1, relaxation: 0 }); return null; }), undefined, {
      signal: controller.signal,
      compute3: { async classify(s) { return classifySceneCpu3(s); }, async deform(surface) { controller.abort(); return { surface, stats: { dispatches: 1, transferBytes: 0 } }; } },
    })).rejects.toThrow();
  });
});

it('closes a retained modeling toolkit when its execution finishes', async () => {
  let toolkit!: import('../src/api.js').Toolkit;
  await compileSketchAsync(sketchAsync({}, async t => { toolkit = t; return null; }));
  expect(() => toolkit.deform3(grid3(1,1), { iterations: 1, relaxation: 0 })).toThrow('execution has finished');
});

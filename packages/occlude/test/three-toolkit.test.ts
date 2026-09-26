import { describe, expect, it } from 'vitest';
import { sketch } from '../src/index.js';
import { compileSketch, compileSketchAsync } from '../src/host.js';
import { plane, pointCloud, query } from '../src/three/api/index.js';
import { QUERY_HOST3 } from '../src/three/queries/surface.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';

// The surface-query host is the one batch the toolkit runs for `occlude/3d`:
// `query(mesh).batch(t)` reads it, under a symbol no sketch can name.
describe('3D modeling toolkit', () => {
  it('runs batched queries on the CPU reference and records them', async () => {
    const run = await compileSketchAsync(sketch({ seed: 42 }, async t => {
      const batch = query(plane(10)).batch(t), probe = pointCloud([[0, 0, 1]]);
      const rays = await batch.rays(probe.points, { direction: [0, 0, -1] });
      const segments = await batch.segments(probe.points, { to: [0, 0, -1] });
      const nearest = await batch.nearest(plane(2).subdivide(1).points);
      expect(rays[0].hit?.distance).toBe(1);
      expect(segments[0].hit?.t).toBe(.5);
      expect(nearest).toHaveLength(9);
      for (const row of nearest) { expect(row.hit).not.toBeNull(); expect(row.hit!.position[2]).toBeCloseTo(0, 12); }
      return null;
    }));
    expect(run.modeling3.map(s => [s.operation, s.backend])).toEqual([['query', 'cpu'], ['query', 'cpu'], ['query', 'cpu']]);
  });
  it('is no word of the toolkit', () => {
    compileSketch(sketch({}, t => { expect(Object.keys(t)).not.toContain('querySurface3'); expect(typeof (t as unknown as Record<symbol, unknown>)[QUERY_HOST3]).toBe('function'); return null; }));
  });
  it('rejects synchronous use and never silently substitutes CPU for a missing host operation', async () => {
    let pending!: Promise<unknown>;
    compileSketch(sketch({}, t => { pending = query(plane(1)).batch(t).nearest(pointCloud([[0, 0, 1]]).points); return null; }));
    await expect(pending).rejects.toThrow('require an async sketch');
    await expect(compileSketchAsync(sketch({}, async t => { await query(plane(1)).batch(t).nearest(pointCloud([[0, 0, 1]]).points); return null; }), undefined, { compute3: { async classify(s) { return classifySceneCpu3(s); } } })).rejects.toThrow('does not provide GPU surface queries');
  });
  it('does not adopt a cancelled host operation', async () => {
    const controller = new AbortController();
    await expect(compileSketchAsync(sketch({}, async t => { await query(plane(1)).batch(t).nearest(pointCloud([[0, 0, 1]]).points); return null; }), undefined, {
      signal: controller.signal,
      compute3: { async classify(s) { return classifySceneCpu3(s); }, async query() { controller.abort(); return { result: { rays: [], segments: [], nearest: [null] }, stats: { dispatches: 1, transferBytes: 0 } }; } },
    })).rejects.toThrow();
  });
});

it('closes a retained modeling toolkit when its execution finishes', async () => {
  let toolkit!: import('../src/api.js').Toolkit;
  await compileSketchAsync(sketch({}, async t => { toolkit = t; return null; }));
  await expect(query(plane(1)).batch(toolkit).nearest(pointCloud([[0, 0, 1]]).points)).rejects.toThrow('execution has finished');
});

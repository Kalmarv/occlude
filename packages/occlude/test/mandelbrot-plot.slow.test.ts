/**
 * Caleb's Mandelbrot plot, as a standing check. The night of 2026-09-23
 * two landings took this drawing away — one quadrupled its points, one
 * refused them — and nothing in the suite or the docs corpus draws at this
 * scale. So the sketch itself is pinned: it renders, its level lines are
 * what they were before the level sets closed (1 517 081 edges at step
 * 0.067, from the tree at bf815f8), and its plan with a 1 mm bridge on
 * Letter is about 219 minutes (the studio's own estimator). A landing that
 * moves either by more than the margin stops here.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { complex, escape, estimatePlanMs, initOcclude, mm, pen, plan, planToolpath, render, selectAll, sketch, strokes, type EstimateOpts, type SketchDef } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

const timing: EstimateOpts = { travelFeed: 6000, acceleration: 1000, travelAcceleration: 2000, junctionDeviation: 0.02, minimumCruiseRatio: 0.5 };

describe('the Mandelbrot escape-count plot (22 × 28, step 0.067)', () => {
  it('renders, keeps its level lines, and plans to about 219 minutes on Letter with a 1 mm bridge', { timeout: 600_000 }, async () => {
    let lines = 0;
    let rims = 0;
    const def = sketch({ aspect: [22, 28], seed: 21, pens: { fine: pen({ width: mm(0.2), color: '#000000', feed: 4000 }) } }, (t) => {
      t.plan({ bridge: 1 });
      const step = (z: [number, number], c: [number, number]) => complex.add(complex.mul(z, z), c);
      const field = escape(step, { input: 'c', iterations: 64, bailout: 1e9 });
      const count = (x: number, y: number) => field((x - 320) / 500, (y - 350) / 500);
      const m = t.isolines(count, { spacing: 1 }, { step: 0.067 });
      for (let e = 0; e < m.edgeCount; e++) if (m.edgeAttrs.cut[e] === 0) lines++; else rims++;
      return strokes(m, { pen: 'fine' });
    });
    const r = render(def as SketchDef, { paper: 'Letter' });
    // The level lines, before the level sets closed: 1 517 081 edges.
    expect(Math.abs(lines - 1_517_081) / 1_517_081).toBeLessThan(0.02);
    expect(r.frags.length).toBeGreaterThan(100_000);
    const p = await plan(r);
    const minutes = estimatePlanMs(planToolpath(p, selectAll(p), 0.025), (i) => r.pens[i] && { feed: r.pens[i].feed, penDelay: r.pens[i].penDelay }, timing).totalMs / 60000;
    expect(minutes).toBeGreaterThan(180);
    expect(minutes).toBeLessThan(260);
  });
});

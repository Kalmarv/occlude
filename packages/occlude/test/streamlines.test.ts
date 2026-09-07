import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { curl, grad, initOcclude, render, sketch, strokes, vectorField, within, circle } from '../src/index.js';
import type { IsoEnv } from '../src/isolines.js';
import { streamlinesOf } from '../src/streamlines.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

/** Bare-units env: 100×100 drawable, lengths taken at face value. */
const env: IsoEnv = {
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  len: (l) => (typeof l === 'number' ? l : l.value),
};

const uniform = vectorField(() => [1, 0.3]); // straight lines, one direction
const swirl = vectorField((x, y) => [-(y - 50), x - 50]); // circles about the centre

const length = (pts: [number, number][]): number =>
  pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/** Smallest distance between a point and any point on another line. */
function minGapBetweenLines(lines: [number, number][][]): number {
  let best = Infinity;
  for (let i = 0; i < lines.length; i++) {
    for (let j = 0; j < lines.length; j++) {
      if (i === j) continue;
      for (const p of lines[i]) {
        for (const q of lines[j]) {
          best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
        }
      }
    }
  }
  return best;
}

describe('streamlines', () => {
  it('is deterministic and returns open contours', () => {
    const a = streamlinesOf(env, swirl, { spacing: 4 });
    const b = streamlinesOf(env, swirl, { spacing: 4 });
    expect(a.length).toBeGreaterThan(5);
    expect(a.every((c) => !c.closed && c.pts.length >= 2)).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps neighbouring lines at least half a spacing apart and covers the drawable', () => {
    const lines = streamlinesOf(env, uniform, { spacing: 5 }).map((c) => c.pts);
    // Coverage: lines exist near every edge.
    const ys = lines.map((l) => l[0][1]);
    expect(Math.min(...ys)).toBeLessThan(6);
    expect(Math.max(...ys)).toBeGreaterThan(94);
    // Separation: the paper's dTest is half the spacing.
    expect(minGapBetweenLines(lines)).toBeGreaterThan(5 * 0.5 - 1e-6);
    // Spacing: about 100/5 lines across, give or take the ends.
    expect(lines.length).toBeGreaterThan(14);
    expect(lines.length).toBeLessThan(30);
  });

  it('the separation grid holds at its edges and in degenerate drawables', () => {
    // A grid one cell wide, one cell tall, and one where the separation
    // radius spans the whole grid: the neighbour walk must clamp, not skip.
    for (const [w, h, spacing] of [[2, 200, 5], [200, 2, 5], [7, 7, 3], [40, 40, 60]] as const) {
      const e: IsoEnv = { bounds: { x: 0, y: 0, w, h }, len: (l) => (typeof l === 'number' ? l : l.value) };
      const lines = streamlinesOf(e, uniform, { spacing }).map((c) => c.pts);
      for (const l of lines) {
        for (const [x, y] of l) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(w);
          expect(y).toBeLessThanOrEqual(h);
        }
      }
      if (lines.length > 1) expect(minGapBetweenLines(lines)).toBeGreaterThan(spacing * 0.5 - 1e-6);
    }
    // Lines that run right along the drawable's edge still separate: seeds
    // on the boundary, and a field that pushes straight at it.
    const edge: IsoEnv = { bounds: { x: -50, y: -50, w: 100, h: 100 }, len: (l) => (typeof l === 'number' ? l : l.value) };
    const out = streamlinesOf(edge, uniform, { spacing: 4, seeds: [[-50, -50], [-50, 50], [50, -50], [50, 50], [0, 0]] }).map((c) => c.pts);
    expect(out.length).toBeGreaterThan(3);
    expect(minGapBetweenLines(out)).toBeGreaterThan(4 * 0.5 - 1e-6);
  });

  it('variable spacing: lines crowd where the spacing field is small', () => {
    // Tight on the left half, loose on the right.
    const spacing = (x: number) => (x < 50 ? 2 : 8);
    const lines = streamlinesOf(env, vectorField(() => [0, 1]), { spacing, minSpacing: 1 });
    const left = lines.filter((c) => c.pts[0][0] < 50).length;
    const right = lines.filter((c) => c.pts[0][0] >= 50).length;
    expect(left).toBeGreaterThan(right * 2.5);
    // And separation follows the LOCAL spacing on each side.
    const leftLines = lines.filter((c) => c.pts[0][0] < 45).map((c) => c.pts);
    expect(minGapBetweenLines(leftLines)).toBeGreaterThan(2 * 0.5 - 1e-6);
  });

  it('the spacing floor stops a zero-spacing request from asking for infinite ink', () => {
    const lines = streamlinesOf(env, uniform, { spacing: () => 0, minSpacing: 5 });
    expect(lines.length).toBeLessThan(40);
    expect(minGapBetweenLines(lines.map((c) => c.pts))).toBeGreaterThan(2.4);
  });

  it('stops at a within() bound and at absence', () => {
    const bounded = vectorField((x, y) => (Math.hypot(x - 50, y - 50) < 30 ? [1, 0] : [NaN, NaN]));
    const lines = streamlinesOf(env, bounded, { spacing: 5 });
    expect(lines.length).toBeGreaterThan(3);
    for (const c of lines) for (const [x, y] of c.pts) {
      expect(Math.hypot(x - 50, y - 50)).toBeLessThan(30 + 1.5);
    }
  });

  it('grad points uphill and curl runs along the contours', () => {
    const f = (x: number, y: number) => x * x + y * y; // bowl
    const g = grad(f, 0.5)(3, 4);
    expect(g[0]).toBeCloseTo(6, 3);
    expect(g[1]).toBeCloseTo(8, 3);
    const c = curl(f, 0.5)(3, 4);
    // Perpendicular to the gradient, same length.
    expect(c[0] * g[0] + c[1] * g[1]).toBeCloseTo(0, 6);
    expect(Math.hypot(c[0], c[1])).toBeCloseTo(10, 3);
  });

  it('streamlines of curl(f) hold f constant — they are isolines of f', () => {
    const f = (x: number, y: number) => Math.hypot(x - 50, y - 50);
    const lines = streamlinesOf(env, curl(f, 0.25), { spacing: 6, step: 0.5 });
    expect(lines.length).toBeGreaterThan(5);
    for (const c of lines) {
      const vals = c.pts.map(([x, y]) => f(x, y));
      const spread = Math.max(...vals) - Math.min(...vals);
      expect(spread).toBeLessThan(0.6); // a tenth of the spacing
    }
  });

  it('within() on the scalar carries to grad/curl and the toolkit stamps the result as ink', () => {
    const def = sketch({ seed: 1 }, (t) => {
      const field = within((x: number, y: number) => t.noise(x / 20, y / 20), circle(50, 50, 35));
      return strokes(t.streamlines(curl(field), { spacing: 3 }));
    });
    const out = render(def, { paper: 'Square20' });
    expect(out.frags.length).toBeGreaterThan(50);
    const total = out.frags.reduce((a, fr) => {
      const g = fr.geom as { t: string; x0?: number; y0?: number; x1?: number; y1?: number };
      return g.t === 'line' ? a + Math.hypot((g.x1 ?? 0) - (g.x0 ?? 0), (g.y1 ?? 0) - (g.y0 ?? 0)) : a;
    }, 0);
    expect(total).toBeGreaterThan(200);
    // Nothing outside the bound: every fragment midpoint within the circle (paper mm, 200mm sheet).
    for (const fr of out.frags) {
      const g = fr.geom as { t: string; x0?: number; y0?: number; x1?: number; y1?: number };
      if (g.t !== 'line') continue;
      const mx = ((g.x0 ?? 0) + (g.x1 ?? 0)) / 2;
      const my = ((g.y0 ?? 0) + (g.y1 ?? 0)) / 2;
      expect(Math.hypot(mx - 100, my - 100)).toBeLessThan(72);
    }
    void length;
  });
});

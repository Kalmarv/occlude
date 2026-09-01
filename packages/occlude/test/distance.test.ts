import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { distanceTo, initOcclude, render, sketch } from '../src/index.js';
import type { RenderOptions, SketchDef } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

const sq = (def: SketchDef, opts: RenderOptions = {}) =>
  render(def, { paper: 'Square20', ...opts });

const square = (x0: number, y0: number, s: number): [number, number][] => [
  [x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s],
];

describe('distanceTo: signed distance field', () => {
  it('is positive inside, negative outside, ~zero on the boundary', () => {
    const d = distanceTo([square(10, 10, 20)]);
    expect(d(20, 20)).toBeCloseTo(10, 12); // centre: 10 from every wall
    expect(d(12, 20)).toBeCloseTo(2, 12); // 2 in from the left wall
    expect(d(5, 20)).toBeCloseTo(-5, 12); // 5 outside the left wall
    expect(d(10, 20)).toBeCloseTo(0, 12);
    expect(d(0, 0)).toBeCloseTo(-Math.hypot(10, 10), 12); // corner diagonal
  });

  it('holes flip the sign back (even-odd, like region)', () => {
    const d = distanceTo([square(0, 0, 30), square(10, 10, 10)]);
    expect(d(5, 15)).toBeCloseTo(5, 12); // in the band
    expect(d(15, 15)).toBeCloseTo(-5, 12); // centre of the hole: outside
    expect(d(15, 11)).toBeCloseTo(-1, 12); // just inside the hole
  });

  it('open loops get their closing chord, no usable loops give -Infinity', () => {
    // Two points: the chord back makes a degenerate sliver — everywhere is
    // "outside" with distance to the segment.
    const d = distanceTo([[[0, 0], [10, 0]]]);
    expect(d(5, 3)).toBeCloseTo(-3, 12);
    expect(distanceTo([])(1, 2)).toBe(-Infinity);
    expect(distanceTo([[[4, 4]]])(1, 2)).toBe(-Infinity);
  });

  it('matches the brute-force scan on a jagged loop', () => {
    const loop: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * 2 * Math.PI;
      const r = 20 + 7 * Math.sin(5 * a);
      loop.push([50 + r * Math.cos(a), 50 + r * Math.sin(a)]);
    }
    const d = distanceTo([loop]);
    const brute = (x: number, y: number): number => {
      let best = Infinity;
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = loop[i];
        const [bx, by] = loop[(i + 1) % n];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
      }
      return best;
    };
    for (let y = 20; y <= 80; y += 7) {
      for (let x = 20; x <= 80; x += 7) {
        expect(Math.abs(d(x, y))).toBeCloseTo(brute(x, y), 9);
      }
    }
  });

  it('isolines(distanceTo(loop), k) insets: nested rings, halo at negative k', () => {
    const capture: { level: number; count: number; span: number }[] = [];
    const def = sketch({ seed: 1 }, (t) => {
      const d = t.distanceTo([square(20, 20, 60)]);
      for (const level of [5, 15, -5]) {
        const cs = t.isolines(d, level, { step: 0.5 });
        let minX = Infinity;
        let maxX = -Infinity;
        for (const c of cs) for (const [x] of c.pts) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
        capture.push({ level, count: cs.length, span: maxX - minX });
      }
      return [t.rect(0, 0, 1, 1)];
    });
    sq(def);
    const [inset5, inset15, halo] = capture;
    expect(inset5.count).toBe(1);
    expect(inset5.span).toBeCloseTo(50, 0); // 60 − 2·5
    expect(inset15.count).toBe(1);
    expect(inset15.span).toBeCloseTo(30, 0); // 60 − 2·15
    expect(halo.count).toBe(1);
    expect(halo.span).toBeCloseTo(70, 0); // 60 + 2·5, rounded corners
  });
});

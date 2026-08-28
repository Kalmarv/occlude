import { describe, expect, test } from 'vitest';

import { backlashSquares, cornerRinging, registrationProbe } from './diagnostics.js';

/** Mirror of ebb.plot()'s plan parser. */
function parse(plan: Float64Array): { pen: number; pts: [number, number][] }[] {
  const chains: { pen: number; pts: [number, number][] }[] = [];
  for (let i = 0; i < plan.length; ) {
    const pen = plan[i++];
    const dot = plan[i++];
    expect(dot).toBe(0);
    const n = plan[i++];
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) pts.push([plan[i + k * 2], plan[i + k * 2 + 1]]);
    i += n * 2;
    chains.push({ pen, pts });
  }
  return chains;
}

const mid = (pts: [number, number][]): [number, number] => [
  (pts[0][0] + pts[pts.length - 1][0]) / 2,
  (pts[0][1] + pts[pts.length - 1][1]) / 2,
];

describe('machine diagnostics', () => {
  test('registration probe draws + first and ✕ last on the same center', () => {
    const d = registrationProbe();
    const chains = parse(d.plan);
    expect(chains.every((c) => c.pen < d.pens.length)).toBe(true);
    const [h, v] = chains.slice(0, 2);
    const [d1, d2] = chains.slice(-2);
    // + strokes are axis-aligned, ✕ strokes diagonal — all share a center.
    expect(h.pts[0][1]).toBe(h.pts[1][1]);
    expect(v.pts[0][0]).toBe(v.pts[1][0]);
    expect(Math.abs(d1.pts[1][0] - d1.pts[0][0])).toBeCloseTo(
      Math.abs(d1.pts[1][1] - d1.pts[0][1]),
    );
    for (const c of [h, v, d1, d2]) expect(mid(c.pts)).toEqual(mid(h.pts));
    // The stress batch between them alternates sides — long travels.
    const stress = chains.slice(2, -2);
    expect(stress.length).toBeGreaterThanOrEqual(20);
    const spans = stress.map((c) => c.pts[0][0]);
    expect(Math.max(...spans) - Math.min(...spans)).toBeGreaterThan(80);
  });

  test('backlash squares: one-way edges doubled, there-and-back palindromes', () => {
    const chains = parse(backlashSquares().plan);
    const uni = chains.filter((c) => c.pts.length === 2);
    const bi = chains.filter((c) => c.pts.length === 3);
    expect(uni).toHaveLength(8);
    expect(bi).toHaveLength(4);
    // Unidirectional edges come in identical pairs (same start = same
    // approach direction both times).
    for (let i = 0; i < uni.length; i += 2) {
      expect(uni[i].pts).toEqual(uni[i + 1].pts);
    }
    for (const c of bi) expect(c.pts[0]).toEqual(c.pts[2]);
  });

  test('corner ringing: three feeds ascending, counted by ticks, right-angle combs', () => {
    const d = cornerRinging();
    const chains = parse(d.plan);
    const feeds = d.pens.map((p) => p.feed);
    expect(feeds).toEqual([...feeds].sort((a, b) => a - b));
    for (let row = 0; row < d.pens.length; row++) {
      const mine = chains.filter((c) => c.pen === row);
      const ticks = mine.filter((c) => c.pts.length === 2);
      const combs = mine.filter((c) => c.pts.length > 2);
      expect(ticks).toHaveLength(row + 1);
      expect(combs).toHaveLength(1);
      // Every comb segment is axis-aligned: consecutive segments turn 90°.
      const pts = combs[0].pts;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0];
        const dy = pts[i][1] - pts[i - 1][1];
        expect(dx === 0 || dy === 0).toBe(true);
        expect(Math.abs(dx) + Math.abs(dy)).toBeGreaterThan(0);
      }
    }
  });
});

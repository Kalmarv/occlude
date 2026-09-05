import { describe, expect, test } from 'vitest';

import {
  backlashSquares, cornerRinging, downSweep, liftGrid, liftTraverse, registrationProbe, settleLift,
} from './diagnostics.js';

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
  test('patterns inherit the physical pen’s tuning', () => {
    const base = {
      name: 'micron-03', width: 0.35, color: '#111', feed: 3500,
      penDown: 0, penUp: 5, penDelay: 500,
    };
    for (const d of [registrationProbe(base), backlashSquares(base), cornerRinging(base)]) {
      for (const p of d.pens) {
        expect(p.penDelay).toBe(500);
        expect(p.width).toBe(0.35);
      }
    }
    // The ringing feeds stay a fixed sweep — that IS the diagnostic.
    expect(cornerRinging(base).pens.map((p) => p.feed)).toEqual([2000, 4000, 6000]);
    expect(registrationProbe(base).pens[0].feed).toBe(3500);
    // Bases with a settle below the physical floor are floored, not obeyed.
    expect(registrationProbe({ ...base, penDelay: 100 }).pens[0].penDelay).toBe(300);
  });

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

describe('pen-height cards', () => {
  const base = {
    name: 'micron-01', width: 0.45, color: '#111', feed: 3500,
    penDown: 0, penUp: 5, penDelay: 600,
  };
  const pulses = [8600, 10000, 11400, 12800, 14200, 16000];

  test('lift grid: framed cells cover the bed, one pen per pulse, frame pen unpinned', () => {
    const d = liftGrid(base, { bedW: 300, bedH: 218, pulses, cols: 5, rows: 4 });
    expect(d.pens).toHaveLength(pulses.length + 1);
    expect(d.servo?.[0]).toBeUndefined();
    expect(d.servo?.slice(1).map((s) => s?.up)).toEqual(pulses);
    const chains = parse(d.plan);
    for (const c of chains) for (const [x, y] of c.pts) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(300);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(218);
    }
    // 20 frames, and every strip alternates direction so each hop travel is a diagonal.
    expect(chains.filter((c) => c.pen === 0)).toHaveLength(20);
    const strip = chains.filter((c) => c.pen === 1).slice(0, 2);
    expect(Math.sign(strip[0].pts[1][0] - strip[0].pts[0][0]))
      .toBe(-Math.sign(strip[1].pts[1][0] - strip[1].pts[0][0]));
    for (const p of d.pens) expect(p.penDelay).toBe(600);
  });

  test('settle × lift: one pen per cell carrying its row settle and column lift', () => {
    const settles = [200, 400, 600];
    const d = settleLift(base, { pulses, settles });
    expect(d.pens).toHaveLength(pulses.length * settles.length);
    expect(d.pens.map((p) => p.penDelay)).toEqual(settles.flatMap((s) => pulses.map(() => s)));
    expect(d.servo?.map((s) => s?.up)).toEqual(settles.flatMap(() => pulses));
    // 9 dashes per cell.
    expect(parse(d.plan)).toHaveLength(9 * d.pens.length);
  });

  test('down sweep: one hatch patch per landing pulse, lifts untouched', () => {
    const d = downSweep(base, { pulses: [12000, 14000, 16000, 18000] });
    expect(d.servo?.map((s) => s?.down)).toEqual([12000, 14000, 16000, 18000]);
    expect(d.servo?.every((s) => s?.up === undefined)).toBe(true);
    expect(parse(d.plan).filter((c) => c.pen === 2)).toHaveLength(19);
  });
});

describe('lift traverse', () => {
  test('two ticks per sweep, both on the pulse’s pen, spanning the bed', () => {
    const pulses = [8600, 11000, 14000];
    const d = liftTraverse(undefined, { bedW: 304.8, bedH: 431.8, pulses, rows: 12, cols: 8 });
    expect(d.servo?.map((s) => s?.up)).toEqual(pulses);
    const chains = parse(d.plan);
    expect(chains).toHaveLength((12 + 8) * pulses.length * 2);
    // A horizontal sweep: left tick ends near the left edge, right tick near the right edge.
    const row0 = chains.filter((c) => c.pen === 0).slice(0, 2);
    expect(row0[0].pts[0][0]).toBeLessThan(10);
    expect(row0[1].pts[1][0]).toBeGreaterThan(294);
    expect(row0[0].pts[0][1]).toBe(row0[1].pts[0][1]); // same y: the travel between them is the sweep
    for (const c of chains) for (const [x, y] of c.pts) {
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(304.8);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(431.8);
    }
  });
});

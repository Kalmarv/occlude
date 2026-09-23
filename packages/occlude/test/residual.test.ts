/**
 * `t.residual` — ink as a budget.
 *
 * The contract, in order: the surface a field asks for, what a stroke takes
 * off it and in what unit, the ledger's arithmetic, dots, the floor at zero,
 * the debt read back as a field, the frozen copy, a greedy loop that is
 * monotone and reproducible, and the degenerate inputs that must take
 * nothing rather than throw.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { circle, curve, initOcclude, material, mm } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

const disc = (cx: number, cy: number, r: number, n = 128): [number, number][] =>
  Array.from({ length: n }, (_, k) => {
    const a = (2 * Math.PI * k) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });

/** The one tone everything below is measured against: every cell owes all. */
const all = (): number => 1;

describe('the surface a field asks for', () => {
  it('owes the target darkness inside the area and nothing outside it', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1, area: disc(50, 50, 20) });
    expect(r(50, 50)).toBeCloseTo(1, 6);
    expect(r(62, 50)).toBeCloseTo(1, 6);
    expect(r(31, 31)).toBe(0); // in the grid's box, outside the disc
    expect(r(5, 5)).toBe(0);   // outside the box altogether
    // The debt is the area's own: a disc of radius 20 in cells of 1.
    expect(r.total()).toBeGreaterThan(Math.PI * 400 * 0.97);
    expect(r.total()).toBeLessThan(Math.PI * 400 * 1.03);
    expect(r.peek(50, 50)).toBe(r(50, 50));
  });

  it('reads the field at cell centres, clamped to 0…1', () => {
    const t = toolkit();
    const r = t.residual((x) => (x - 50) / 25, { spacing: 1 });
    expect(r(20, 50)).toBe(0);            // the field is negative there
    expect(r(90, 50)).toBeCloseTo(1, 6);  // and over one there
    expect(r(62.5, 50)).toBeCloseTo(0.5, 2);
    // A field that answers with nonsense owes nothing, and does not spread.
    const bad = t.residual(() => NaN, { spacing: 2 });
    expect(bad(50, 50)).toBe(0);
    expect(bad.total()).toBe(0);
  });

  it('defaults its spacing to the grid step isolines uses', () => {
    const t = toolkit();
    const coarse = t.residual(all);
    // mm(1) on this paper, which is finer than the long side over 256.
    expect(coarse.total()).toBeCloseTo((100 * 100) / t.len(mm(1)) ** 2, 0);
  });

  it('takes a shape as its area, which the toolkit lowers', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1, area: circle(50, 50, 20) });
    expect(r(50, 50)).toBeCloseTo(1, 6);
    expect(r(10, 10)).toBe(0);
  });
});

describe('what a stroke takes, and in what unit', () => {
  it('zeroes a band the width of the nib, and answers in cell areas', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1 });
    // Right across the drawable, so the footprint inside the grid is a clean
    // rectangle: 100 long, 4 wide, on cell boundaries. No end caps to round.
    const took = r.spend([[-10, 50], [110, 50]], { width: 4 });
    expect(took).toBeCloseTo(400, 3);
    expect(r(50, 50)).toBe(0);
    expect(r(50, 48.5)).toBe(0);
    expect(r(50, 45)).toBeCloseTo(1, 6);
    // The same marks again: the band owes nothing now.
    expect(r.spend([[-10, 50], [110, 50]], { width: 4 })).toBe(0);
  });

  it('measures a slanted stroke by its area, whichever way it runs', () => {
    const t = toolkit();
    const area = (ax: number, ay: number, bx: number, by: number): number => {
      const r = t.residual(all, { spacing: 1 });
      return r.spend([[ax, ay], [bx, by]], { width: 3 });
    };
    const length = Math.hypot(60, 60);
    const expected = length * 3 + Math.PI * 1.5 ** 2; // a stadium: body + caps
    expect(area(20, 20, 80, 80)).toBeCloseTo(expected, -0.5);
    expect(area(80, 20, 20, 80)).toBeCloseTo(expected, -0.5);
    // Within 3% of the true footprint, whatever the angle.
    for (const [ax, ay, bx, by] of [[20, 20, 80, 80], [80, 20, 20, 80], [20, 50, 80, 50], [50, 20, 50, 80]] as const) {
      const got = area(ax, ay, bx, by);
      const want = Math.hypot(bx - ax, by - ay) * 3 + Math.PI * 1.5 ** 2;
      expect(Math.abs(got - want) / want).toBeLessThan(0.03);
    }
  });

  it('takes a chain material, a contour record and a bare polyline alike', () => {
    const t = toolkit();
    const line: [number, number][] = [[20, 40], [80, 40]];
    const fromArray = t.residual(all, { spacing: 1 }).spend(line, { width: 2 });
    const fromMaterial = t.residual(all, { spacing: 1 }).spend(curve(line, { closed: false }), { width: 2 });
    const fromRecord = t.residual(all, { spacing: 1 }).spend({ pts: line, closed: false }, { width: 2 });
    expect(fromMaterial).toBeCloseTo(fromArray, 6);
    expect(fromRecord).toBeCloseTo(fromArray, 6);
    // A closed chain comes back to where it started: four walls, not three.
    const square: [number, number][] = [[30, 30], [70, 30], [70, 70], [30, 70]];
    const closed = t.residual(all, { spacing: 1 }).spend(curve(square, { closed: true }), { width: 2 });
    const open = t.residual(all, { spacing: 1 }).spend(square, { width: 2 });
    expect(closed / open).toBeGreaterThan(1.3);
  });

  it('spends a width given as a length', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 0.5 });
    const took = r.spend([[-10, 50], [110, 50]], { width: mm(2) });
    expect(took).toBeCloseTo((100 * t.len(mm(2))) / 0.25, -0.5);
  });
});

describe('the ledger', () => {
  it('loses exactly what spend says it took', () => {
    const t = toolkit();
    const r = t.residual((x, y) => 0.4 + 0.3 * Math.sin(x / 11) * Math.cos(y / 13), { spacing: 1 });
    let owed = r.total();
    expect(owed).toBeGreaterThan(100);
    for (const y of [20, 40, 60, 80]) {
      const took = r.spend([[5, y], [95, y]], { width: 2.5 });
      expect(took).toBeGreaterThan(0);
      expect(r.total()).toBeCloseTo(owed - took, 3);
      owed = r.total();
    }
  });

  it('dots a point set, one disc per point', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 0.5 });
    const dots = material([[25, 25], [50, 50], [75, 75]]);
    const took = r.spend(dots, { width: 6 });
    const want = (3 * Math.PI * 9) / 0.25; // three discs of radius 3, in cells
    expect(Math.abs(took - want) / want).toBeLessThan(0.03);
    expect(r(50, 50)).toBe(0);
    expect(r(50, 56)).toBeCloseTo(1, 6);
    // One position on its own is a dot too.
    const one = t.residual(all, { spacing: 0.5 });
    expect(one.spend([[50, 50]], { width: 6 })).toBeCloseTo(took / 3, -0.5);
  });

  it('never goes below zero, and takes nothing where nothing is owed', () => {
    const t = toolkit();
    const r = t.residual((x) => (x < 50 ? 1 : 0), { spacing: 1 });
    const took = r.spend([[-10, 50], [110, 50]], { width: 4 });
    // Only the left half owed anything: the right half of the band is free.
    expect(took).toBeCloseTo(200, 0);
    expect(r(75, 50)).toBe(0);
    for (const [x, y] of [[10, 50], [75, 50], [30, 20], [90, 90]] as const) expect(r(x, y)).toBeGreaterThanOrEqual(0);
    // A second pass over ground that owes nothing takes nothing.
    expect(r.spend([[60, 20], [60, 80]], { width: 4 })).toBe(0);
  });

  it('is a field the rest of the library reads: a hole has a contour', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1 });
    r.spend([[50, 50]], { width: 20 });
    // The owed ground is an area closed along the paper's edge (those edges
    // are cut); the hole is the level line, a ring of its own.
    const rings = t.isolines(r, 0.5).edges.filter((e) => !e.attrs.cut).curves().filter((c) => c.closed);
    expect(rings.length).toBe(1);
    const ring = rings[0];
    for (const [x, y] of ring.pts) expect(Math.hypot(x - 50, y - 50)).toBeGreaterThan(9);
    for (const [x, y] of ring.pts) expect(Math.hypot(x - 50, y - 50)).toBeLessThan(11);
  });

  it('hands out a snapshot that later spends do not touch', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1 });
    const before = r.snapshot();
    expect(before(50, 50)).toBeCloseTo(1, 6);
    r.spend([[-10, 50], [110, 50]], { width: 6 });
    expect(r(50, 50)).toBe(0);
    expect(before(50, 50)).toBeCloseTo(1, 6);
    const after = r.snapshot();
    expect(after(50, 50)).toBe(0);
    r.spend([[-10, 20], [110, 20]], { width: 6 });
    expect(after(50, 20)).toBeCloseTo(1, 6);
  });
});

describe('a greedy loop, written in the sketch', () => {
  /** The PINTR idea in nine lines: from where the pen is, look at K chords,
   * take the one with the most tone left along it, draw it, pay for it. */
  const run = (seed: number): { totals: number[]; taken: number[]; pts: number[] } => {
    const t = toolkit({ seed });
    const tone = (x: number, y: number): number => 0.5 + 0.45 * Math.sin(x / 9) * Math.cos(y / 11);
    const r = t.residual(tone, { spacing: 1 });
    const totals: number[] = [r.total()];
    const taken: number[] = [];
    const pts: number[] = [];
    let at: [number, number] = [50, 50];
    for (let k = 0; k < 300; k++) {
      let best: [number, number] | null = null;
      let bestTone = -1;
      for (let c = 0; c < 8; c++) {
        const a = t.rnd(0, Math.PI * 2);
        const len = t.rnd(4, 16);
        const end: [number, number] = [at[0] + Math.cos(a) * len, at[1] + Math.sin(a) * len];
        let sum = 0;
        for (let s = 1; s <= 6; s++) sum += r(at[0] + (end[0] - at[0]) * (s / 6), at[1] + (end[1] - at[1]) * (s / 6));
        if (sum / 6 > bestTone) { bestTone = sum / 6; best = end; }
      }
      if (!best) break;
      taken.push(r.spend([at, best], { width: 0.6 }));
      totals.push(r.total());
      pts.push(best[0], best[1]);
      at = best;
    }
    return { totals, taken, pts };
  };

  it('only ever lowers the debt, and never below zero', () => {
    const { totals, taken } = run(7);
    expect(totals.length).toBe(301);
    for (let k = 1; k < totals.length; k++) expect(totals[k]).toBeLessThanOrEqual(totals[k - 1] + 1e-9);
    expect(totals[totals.length - 1]).toBeGreaterThanOrEqual(0);
    expect(totals[totals.length - 1]).toBeLessThan(totals[0]);
    expect(taken.filter((v) => v > 0).length).toBeGreaterThan(200);
  });

  it('is the same drawing twice, and a different one on another seed', () => {
    const a = run(7);
    const b = run(7);
    expect(b.pts).toEqual(a.pts);
    expect(b.taken).toEqual(a.taken);
    expect(b.totals).toEqual(a.totals);
    expect(run(8).pts).not.toEqual(a.pts);
  });
});

describe('degenerate input takes nothing, and a mistake says so', () => {
  it('holds no debt with no spacing, no area and no extent', () => {
    const t = toolkit();
    for (const r of [
      t.residual(all, { spacing: 0 }),
      t.residual(all, { spacing: -2 }),
      t.residual(all, { spacing: 1, area: [] }),
      t.residual(all, { spacing: 1, area: [[[10, 10], [10, 10]]] }),
    ]) {
      expect(r(50, 50)).toBe(0);
      expect(r.total()).toBe(0);
      expect(r.spend([[0, 50], [100, 50]], { width: 2 })).toBe(0);
      expect(r.snapshot()(50, 50)).toBe(0);
    }
  });

  it('takes nothing for empty marks or a nib with no width', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1 });
    const owed = r.total();
    expect(r.spend([], { width: 2 })).toBe(0);
    expect(r.spend(material([]), { width: 2 })).toBe(0);
    expect(r.spend([[20, 20], [80, 80]], { width: 0 })).toBe(0);
    expect(r.spend([[20, 20], [80, 80]], { width: -1 })).toBe(0);
    expect(r.spend([[20, 20], [80, 80]], { width: NaN })).toBe(0);
    expect(r.spend([[NaN, 20], [80, 80]], { width: 2 })).toBe(0);
    expect(r.total()).toBe(owed);
  });

  it('refuses what is not a field, not marks, and a missing nib', () => {
    const t = toolkit();
    expect(() => t.residual(0.5 as never)).toThrow(/target darkness/);
    expect(() => t.residual(null as never)).toThrow(/target darkness/);
    const r = t.residual(all, { spacing: 2 });
    expect(() => r.spend([[20, 20], [80, 80]], {} as never)).toThrow(/width/);
    expect(() => r.spend(42 as never, { width: 1 })).toThrow(/cannot say where its marks are/);
    expect(() => r.spend(circle(50, 50, 10) as never, { width: 1 })).toThrow(/t\.material\(shape\)/);
    expect(() => t.residual(all, { spacing: 0.001 })).toThrow(/cells \(spacing too fine\)/);
  });
});

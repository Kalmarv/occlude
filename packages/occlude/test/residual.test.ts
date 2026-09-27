/**
 * `t.residual` — ink as a budget: a lattice whose one column, `owed`, the
 * lattice's `spend` pays down.
 *
 * The contract, in order: the surface a field asks for, what a stroke takes
 * off it and in what unit, the ledger as a sequence of values (nothing
 * mutates, a spend copies only the column it pays), dots, the floor at
 * zero, the debt read back as a field, a greedy loop that is monotone and
 * reproducible, and the degenerate inputs that must take nothing rather
 * than throw.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { circle, curve, material, mm, type Lattice } from '../src/index.js';
import { initOcclude } from '../src/host.js';
import { rec } from './helpers/xy.js';

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

/** What is still owed, in face areas: the debt a loop watches. */
const owed = (r: Lattice): number => r.faces.sum('owed');
/** What a spend took: the drop in the debt. */
const pay = (r: Lattice, marks: Parameters<Lattice['spend']>[0], width: number): { after: Lattice; took: number } => {
  const after = r.spend(marks, { width });
  return { after, took: owed(r) - owed(after) };
};

describe('the surface a field asks for', () => {
  it('owes the target darkness inside the area and nothing outside it', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1, area: disc(50, 50, 20) });
    expect(r.channels).toEqual(['owed']);
    const f = r.field();
    expect(f(50, 50)).toBeCloseTo(1, 6);
    expect(f(62, 50)).toBeCloseTo(1, 6);
    // Outside the area the lattice has no face: the field is absent there.
    expect(Number.isNaN(f(31, 31))).toBe(true); // in the grid's box, outside the disc
    expect(Number.isNaN(f(5, 5))).toBe(true);   // outside the box altogether
    // The debt is the area's own: a disc of radius 20 in faces of 1.
    expect(owed(r)).toBeGreaterThan(Math.PI * 400 * 0.97);
    expect(owed(r)).toBeLessThan(Math.PI * 400 * 1.03);
  });

  it('reads the field at face centres, clamped to 0…1', () => {
    const t = toolkit();
    const f = t.residual((x) => (x - 50) / 25, { spacing: 1 }).field();
    expect(f(20, 50)).toBe(0);            // the field is negative there
    expect(f(90, 50)).toBeCloseTo(1, 6);  // and over one there
    expect(f(62.5, 50)).toBeCloseTo(0.5, 2);
    // A field that answers with nonsense owes nothing, and does not spread.
    const bad = t.residual(() => NaN, { spacing: 2 });
    expect(bad.field()(50, 50)).toBe(0);
    expect(owed(bad)).toBe(0);
  });

  it('defaults its spacing to the grid step isolines uses', () => {
    const t = toolkit();
    const coarse = t.residual(all);
    // mm(1) on this paper, which is finer than the long side over 256.
    expect(owed(coarse)).toBeCloseTo((100 * 100) / t.len(mm(1)) ** 2, 0);
  });

  it('takes a shape as its area, which the toolkit lowers', () => {
    const t = toolkit();
    const f = t.residual(all, { spacing: 1, area: circle(50, 50, 20) }).field();
    expect(f(50, 50)).toBeCloseTo(1, 6);
    expect(Number.isNaN(f(10, 10))).toBe(true);
  });
});

describe('what a stroke takes, and in what unit', () => {
  it('zeroes a band the width of the nib, and takes it in face areas', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1 });
    // Right across the drawable, so the footprint inside the grid is a clean
    // rectangle: 100 long, 4 wide, on face boundaries. No end caps to round.
    const { after, took } = pay(r, [[-10, 50], [110, 50]], 4);
    expect(took).toBeCloseTo(400, 3);
    const f = after.field();
    expect(f(50, 50)).toBe(0);
    expect(f(50, 48.5)).toBe(0);
    expect(f(50, 45)).toBeCloseTo(1, 6);
    // The same marks again: the band owes nothing now.
    expect(pay(after, [[-10, 50], [110, 50]], 4).took).toBe(0);
  });

  it('measures a slanted stroke by its area, whichever way it runs', () => {
    const t = toolkit();
    const area = (ax: number, ay: number, bx: number, by: number): number =>
      pay(t.residual(all, { spacing: 1 }), [[ax, ay], [bx, by]], 3).took;
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
    const r = t.residual(all, { spacing: 1 });
    const line: [number, number][] = [[20, 40], [80, 40]];
    const fromArray = pay(r, line, 2).took;
    const fromMaterial = pay(r, curve(line, { closed: false }), 2).took;
    const fromRecord = pay(r, { pts: line, closed: false }, 2).took;
    expect(fromMaterial).toBeCloseTo(fromArray, 6);
    expect(fromRecord).toBeCloseTo(fromArray, 6);
    // A closed chain comes back to where it started: four walls, not three.
    const square: [number, number][] = [[30, 30], [70, 30], [70, 70], [30, 70]];
    const closed = pay(r, curve(square, { closed: true }), 2).took;
    const open = pay(r, square, 2).took;
    expect(closed / open).toBeGreaterThan(1.3);
  });

  it('spends a nib resolved from a length, and refuses an unresolved one by name', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 0.5 });
    const { took } = pay(r, [[-10, 50], [110, 50]], t.len(mm(2)));
    expect(took).toBeCloseTo((100 * t.len(mm(2))) / 0.25, -0.5);
    expect(() => r.spend([[-10, 50], [110, 50]], { width: mm(2) as never })).toThrow(/t\.len\(mm/);
  });
});

describe('the ledger', () => {
  it('is a sequence of values: each spend returns the next, and the last is untouched', () => {
    const t = toolkit();
    const r0 = t.residual(all, { spacing: 1 });
    const before = Array.from(r0.values.owed);
    const r1 = r0.spend([[-10, 50], [110, 50]], { width: 6 });
    const r2 = r1.spend([[-10, 20], [110, 20]], { width: 6 });
    // Nothing earlier changed: what a snapshot was for, every value is.
    expect(Array.from(r0.values.owed)).toEqual(before);
    expect(r0.field()(50, 50)).toBeCloseTo(1, 6);
    expect(r1.field()(50, 50)).toBe(0);
    expect(r1.field()(50, 20)).toBeCloseTo(1, 6);
    expect(r2.field()(50, 20)).toBe(0);
    expect(r1.values.owed).not.toBe(r0.values.owed);
    // A spend that takes nothing shares the column it did not change.
    expect(r2.spend([[-10, 20], [110, 20]], { width: 6 }).values.owed).toBe(r2.values.owed);
  });

  it('pays one column and shares the rest', () => {
    const t = toolkit();
    const two = t.lattice({ spacing: 1, channels: ['owed', 'trail'] }, () => ({ owed: 1, trail: 3 }));
    const paid = two.spend([[20, 40], [80, 40]], { width: 2 });
    expect(paid.values.trail).toBe(two.values.trail);
    expect(owed(paid)).toBeLessThan(owed(two));
    // A named column is the one that pays; it never goes below zero.
    const trail = two.spend([[20, 40], [80, 40]], { width: 2 }, 'trail');
    expect(trail.values.owed).toBe(two.values.owed);
    expect(trail.faces.min('trail')).toBeGreaterThanOrEqual(2);
    expect(() => two.spend([[20, 40]], { width: 2 }, 'nope')).toThrow(/no channel 'nope'/);
  });

  it('loses exactly what the faces held', () => {
    const t = toolkit();
    let r = t.residual((x, y) => 0.4 + 0.3 * Math.sin(x / 11) * Math.cos(y / 13), { spacing: 1 });
    let debt = owed(r);
    expect(debt).toBeGreaterThan(100);
    for (const y of [20, 40, 60, 80]) {
      const { after, took } = pay(r, [[5, y], [95, y]], 2.5);
      expect(took).toBeGreaterThan(0);
      expect(owed(after)).toBeCloseTo(debt - took, 3);
      r = after;
      debt = owed(r);
    }
  });

  it('dots a point set, one disc per point', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 0.5 });
    const { after, took } = pay(r, material([[25, 25], [50, 50], [75, 75]]), 6);
    const want = (3 * Math.PI * 9) / 0.25; // three discs of radius 3, in faces
    expect(Math.abs(took - want) / want).toBeLessThan(0.03);
    expect(after.field()(50, 50)).toBe(0);
    expect(after.field()(50, 56)).toBeCloseTo(1, 6);
    // One position on its own is a dot too.
    expect(pay(r, [[50, 50]], 6).took).toBeCloseTo(took / 3, -0.5);
  });

  it('never goes below zero, and takes nothing where nothing is owed', () => {
    const t = toolkit();
    const r = t.residual((x) => (x < 50 ? 1 : 0), { spacing: 1 });
    const { after, took } = pay(r, [[-10, 50], [110, 50]], 4);
    // Only the left half owed anything: the right half of the band is free.
    expect(took).toBeCloseTo(200, 0);
    expect(after.field()(75, 50)).toBe(0);
    expect(after.faces.min('owed')).toBeGreaterThanOrEqual(0);
    // A second pass over ground that owes nothing takes nothing.
    expect(pay(after, [[60, 20], [60, 80]], 4).took).toBe(0);
  });

  it('is a field the rest of the library reads: a hole has a contour', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1 }).spend([[50, 50]], { width: 20 });
    // The owed ground is an area closed along the paper's edge (those edges
    // are cut); the hole is the level line, a ring of its own.
    const rings = t.isolines(r.field(), 0.5).edges.filter((e) => !e.cut).curves.map(rec).filter((c) => c.closed);
    expect(rings.length).toBe(1);
    const ring = rings[0];
    for (const [x, y] of ring.pts) expect(Math.hypot(x - 50, y - 50)).toBeGreaterThan(9);
    for (const [x, y] of ring.pts) expect(Math.hypot(x - 50, y - 50)).toBeLessThan(11);
  });
});

describe('a greedy loop, written in the sketch', () => {
  /** The PINTR idea in nine lines: from where the pen is, look at K chords,
   * take the one with the most tone left along it, draw it, pay for it. */
  const run = (seed: number): { totals: number[]; taken: number[]; pts: number[] } => {
    const t = toolkit({ seed });
    const tone = (x: number, y: number): number => 0.5 + 0.45 * Math.sin(x / 9) * Math.cos(y / 11);
    let r = t.residual(tone, { spacing: 1 });
    const totals: number[] = [owed(r)];
    const taken: number[] = [];
    const pts: number[] = [];
    let at: [number, number] = [50, 50];
    for (let k = 0; k < 300; k++) {
      const f = r.field();
      let best: [number, number] | null = null;
      let bestTone = -1;
      for (let c = 0; c < 8; c++) {
        const a = t.rnd(0, Math.PI * 2);
        const len = t.rnd(4, 16);
        const end: [number, number] = [at[0] + Math.cos(a) * len, at[1] + Math.sin(a) * len];
        let sum = 0;
        for (let s = 1; s <= 6; s++) {
          const v = f(at[0] + (end[0] - at[0]) * (s / 6), at[1] + (end[1] - at[1]) * (s / 6));
          sum += Number.isNaN(v) ? 0 : v;
        }
        if (sum / 6 > bestTone) { bestTone = sum / 6; best = end; }
      }
      if (!best) break;
      const { after, took } = pay(r, [at, best], 0.6);
      r = after;
      taken.push(took);
      totals.push(owed(r));
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
      expect(r.field()(50, 50)).toBe(0);
      expect(owed(r)).toBe(0);
      expect(r.faces.length).toBe(0);
      expect(owed(r.spend([[0, 50], [100, 50]], { width: 2 }))).toBe(0);
    }
  });

  it('takes nothing for empty marks or a nib with no width', () => {
    const t = toolkit();
    const r = t.residual(all, { spacing: 1 });
    for (const [marks, width] of [
      [[], 2], [material([]), 2], [[[20, 20], [80, 80]], 0], [[[20, 20], [80, 80]], -1],
      [[[20, 20], [80, 80]], NaN], [[[NaN, 20], [80, 80]], 2],
    ] as const) {
      const after = r.spend(marks as never, { width });
      expect(after.values.owed).toBe(r.values.owed);
    }
  });

  it('refuses what is not a field, not marks, and a missing nib', () => {
    const t = toolkit();
    expect(() => t.residual(0.5 as never)).toThrow(/target darkness/);
    expect(() => t.residual(null as never)).toThrow(/target darkness/);
    const r = t.residual(all, { spacing: 2 });
    expect(() => r.spend([[20, 20], [80, 80]], {} as never)).toThrow(/width/);
    expect(() => r.spend(42 as never, { width: 1 })).toThrow(/cannot say where its marks are/);
    expect(() => r.spend(circle(50, 50, 10) as never, { width: 1 })).toThrow(/t\.material\(shape\)/);
    expect(() => t.residual(all, { spacing: 0.001 })).toThrow(/does not fit a Float64Array — the spacing is too fine/);
  });
});

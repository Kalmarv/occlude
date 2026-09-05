import { describe, expect, test } from 'vitest';

import {
  cellCentre, curveMs, liftAt, liftForTravel, liftMapFromCounts, parseCounts, refineLiftMap,
  settleAtLift, travelLiftPulse,
} from '../src/liftmap.js';

const ladder = [12000, 12800, 13600, 14400, 15200, 16000];
const g = { cols: 3, rows: 2, bedW: 100, bedH: 70, margin: 5 };

describe('lift map', () => {
  test('diagonal counts become last-clean pulses; 0 is unresolved, all-failed is one rung low', () => {
    const m = liftMapFromCounts([[0, 1, 3], [2, 6, 0]], ladder, g);
    expect(m.thresholds).toEqual([null, 15200, 13600, 14400, 11200, null]);
    expect(m.unresolvedAbove).toBe(16000);
  });

  test('shape mismatch is an error, not a silent misalignment', () => {
    expect(() => liftMapFromCounts([[0, 1]], ladder, g)).toThrow(/expected 2 rows × 3/);
  });

  test('cell centres follow the card layout', () => {
    expect(cellCentre(g, 0, 0)).toEqual([20, 20]);
    expect(cellCentre(g, 1, 2)).toEqual([80, 50]);
  });

  test('liftAt is exact at centres, bilinear between, and extends the edge cells outward', () => {
    const m = liftMapFromCounts([[0, 1, 3], [2, 6, 0]], ladder, g);
    expect(liftAt(m, 20, 20)).toBe(16000); // unresolved → ladder top
    expect(liftAt(m, 50, 20)).toBe(15200);
    expect(liftAt(m, 35, 20)).toBe(15600); // halfway between 16000 and 15200
    expect(liftAt(m, 0, 0)).toBe(16000); // outside: nearest cell
    expect(liftAt(m, 200, 200)).toBe(16000);
  });

  test('a travel takes the least clearing threshold along it, minus the margin, never past full lift', () => {
    const m = liftMapFromCounts([[0, 1, 3], [2, 6, 0]], ladder, g);
    // Along row 0 from the unresolved cell to the 13600 cell: min is 13600.
    expect(liftForTravel(m, [20, 20], [80, 20], 800, 8600)).toBe(12800);
    // Across the 11200 cell in row 1: the margin would go below full lift → clamp.
    expect(liftForTravel(m, [20, 50], [80, 50], 800, 10600)).toBe(10600);
    // A zero-length travel samples once.
    expect(liftForTravel(m, [50, 20], [50, 20], 0, 8600)).toBe(15200);
  });

  test('refinement fills only unresolved cells', () => {
    const m = liftMapFromCounts([[0, 1, 3], [2, 6, 0]], ladder, g);
    const r = refineLiftMap(m, [[2, 9, 9], [9, 9, 0]], [16000, 16600, 17200, 17800]);
    expect(r.thresholds).toEqual([16600, 15200, 13600, 14400, 11200, null]);
    expect(r.unresolvedAbove).toBe(17800);
  });

  test('parseCounts accepts the way the card gets typed', () => {
    expect(parseCounts('0,0,1 - 2,3,0')).toEqual([[0, 0, 1], [2, 3, 0]]);
    expect(parseCounts('0 0 1\n2 3 0\n')).toEqual([[0, 0, 1], [2, 3, 0]]);
    expect(() => parseCounts('0,x')).toThrow(/bad count/);
  });
});

describe('settle by lift', () => {
  // The 2026-09-05 settle×lift card (micron-01, penDelay 600 at full lift).
  const curve = [
    { pulse: 8600, ms: 600 }, { pulse: 12000, ms: 600 }, { pulse: 12800, ms: 500 },
    { pulse: 13600, ms: 400 }, { pulse: 14400, ms: 300 }, { pulse: 15200, ms: 200 }, { pulse: 16000, ms: 200 },
  ];
  const model = { penUpPulse: 8600, marginPulses: 800, settleCurve: curve };

  test('the curve interpolates and clamps', () => {
    expect(curveMs(curve, 14400)).toBe(300);
    expect(curveMs(curve, 14000)).toBe(350);
    expect(curveMs(curve, 5000)).toBe(600);
    expect(curveMs(curve, 20000)).toBe(200);
  });

  test('a pen keeps its penDelay at full lift and scales down in proportion at smaller lifts', () => {
    expect(settleAtLift(600, 8600, model)).toBe(600);
    expect(settleAtLift(600, 15200, model)).toBe(200);
    expect(settleAtLift(900, 15200, model)).toBe(300); // wetter pen: same ratio
    expect(settleAtLift(300, 16000, model)).toBe(150); // never below the physical floor
  });

  test('without a curve the settle is the penDelay at every lift; without a map the lift is full', () => {
    const bare = { penUpPulse: 8600, marginPulses: 800 };
    expect(settleAtLift(600, 16000, bare)).toBe(600);
    expect(travelLiftPulse(bare, [0, 0], [100, 100])).toBe(8600);
  });

  test('with a map the travel lift comes from the map', () => {
    const map = liftMapFromCounts([[0, 1, 3], [2, 6, 0]], ladder, g);
    expect(travelLiftPulse({ ...model, map }, [50, 20], [50, 20])).toBe(14400); // 15200 − 800
  });
});

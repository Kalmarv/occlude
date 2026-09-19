import { describe, expect, it } from 'vitest';
import { connect, curve, material, type Material } from '../src/index.js';

const square = (s = 100): [number, number][] => [[0, 0], [s, 0], [s, s], [0, s]];
const at = (m: Material, i: number) => [m.x[i], m.y[i]] as [number, number];

describe('warp', () => {
  it('a cage that has not moved moves nothing, and an affine cage is that affine map', () => {
    const grid = material([[25, 25], [50, 50], [75, 25], [10, 90]]);
    // Same cage in and out: every row exactly where it was.
    const still = grid.warp({ from: square(), to: square() });
    for (let i = 0; i < grid.n; i++) {
      expect(at(still, i)[0]).toBeCloseTo(grid.x[i], 9);
      expect(at(still, i)[1]).toBeCloseTo(grid.y[i], 9);
    }
    // Mean value coordinates reproduce an affine map exactly, so a cage
    // scaled by two and shifted does precisely that to the drawing.
    const moved = square().map(([x, y]) => [x * 2 + 30, y * 2 - 10] as [number, number]);
    const scaled = grid.warp({ from: square(), to: moved });
    for (let i = 0; i < grid.n; i++) {
      expect(at(scaled, i)[0]).toBeCloseTo(grid.x[i] * 2 + 30, 6);
      expect(at(scaled, i)[1]).toBeCloseTo(grid.y[i] * 2 - 10, 6);
    }
  });

  it('a corner takes its corner with it, and an edge stays on its edge', () => {
    const pulled: [number, number][] = [[0, 0], [100, 0], [160, 140], [0, 100]];
    // A row sitting exactly on a cage corner goes exactly where that corner goes.
    const onCorner = material([[100, 100]]).warp({ from: square(), to: pulled });
    expect(at(onCorner, 0)[0]).toBeCloseTo(160, 9);
    expect(at(onCorner, 0)[1]).toBeCloseTo(140, 9);
    // A row on a cage edge stays on that edge, at the same fraction along it.
    const onEdge = material([[50, 0]]).warp({ from: square(), to: pulled });
    expect(at(onEdge, 0)[0]).toBeCloseTo(50, 9);
    expect(at(onEdge, 0)[1]).toBeCloseTo(0, 9);
    const far = material([[100, 50]]).warp({ from: square(), to: pulled });
    expect(at(far, 0)[0]).toBeCloseTo(130, 6);
    expect(at(far, 0)[1]).toBeCloseTo(70, 6);
  });

  it('keeps the drawing a drawing: structure, columns and shape', () => {
    const ring = connect.ring(material([[30, 40], [70, 40], [70, 60], [30, 60]], { weight: 5 }));
    const pulled: [number, number][] = [[0, 0], [100, 0], [130, 120], [0, 100]];
    const w = ring.warp({ from: square(), to: pulled });
    expect(w.n).toBe(ring.n);
    expect(Array.from(w.edgeList)).toEqual(Array.from(ring.edgeList));
    expect(Array.from(w.attrs.weight)).toEqual(Array.from(ring.attrs.weight));
    expect(Array.from(ring.x)).toEqual([30, 70, 70, 30]); // source untouched
    // A hatch that was evenly spaced comes out still evenly spaced, locally —
    // which is the thing a per-point field cannot promise. Neighbouring
    // rulings stay neighbouring: no two of them swap or collapse together.
    const rulings = Array.from({ length: 9 }, (_, k) => curve([[20, 15 + k * 8], [80, 15 + k * 8]]));
    const gaps = rulings.map((r) => r.warp({ from: square(), to: pulled })).map((r) => r.y[0]);
    for (let k = 1; k < gaps.length; k++) expect(gaps[k]).toBeGreaterThan(gaps[k - 1]);
  });

  it('refuses a cage it cannot use', () => {
    const m = material([[10, 10]]);
    expect(() => m.warp({ from: square(), to: square().slice(0, 3) })).toThrow(/corner for corner/);
    // A cage of fewer than three corners encloses nothing and bends nothing.
    expect(Array.from(m.warp({ from: square().slice(0, 2), to: square().slice(0, 2) }).x)).toEqual(Array.from(m.x));
    expect(() => m.warp({ from: 'box' as never, to: square() })).toThrow(/must be a loop of corners/);
    expect(() => m.warp({ from: [[0, 0], [1, 1], [NaN, 2]], to: square() })).toThrow(/not a finite/);
    // A material is a legal way to give a cage.
    const asMaterial = m.warp({ from: material(square()), to: material(square()) });
    expect(at(asMaterial, 0)).toEqual([10, 10]);
    // Deterministic.
    const twice = () => material([[33, 71]]).warp({ from: square(), to: [[0, 0], [100, 0], [140, 130], [0, 100]] });
    expect(at(twice(), 0)).toEqual(at(twice(), 0));
  });
});

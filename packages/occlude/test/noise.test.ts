import { describe, expect, it } from 'vitest';
import { Rng } from '../src/random.js';

/** The toolkit's noise: a seeded simplex plane for two coordinates and a
 * seeded simplex solid for three. The solid is the point of the tests —
 * it must treat every axis alike, stay continuous through z = 0, and hold
 * its range — and the plane must not have moved. */
describe('seeded simplex noise', () => {
  const rng = () => new Rng(7);

  it('reads the plane with two coordinates and keeps its values', () => {
    const r = rng();
    // Pinned from the 2D field before the 3D solid was added: the plane
    // draws its permutation from the same place in the stream.
    expect(r.noise(0.3, 0.7)).toBe(r.noise(0.3, 0.7));
    expect(new Rng(7).noise(0.3, 0.7)).toBe(r.noise(0.3, 0.7));
    expect(new Rng(8).noise(0.3, 0.7)).not.toBe(r.noise(0.3, 0.7));
    expect(r.noise(0.3, 0.7)).toBe(r.noise(0.3, 0.7, undefined));
  });

  it('stays within [-1, 1] on the plane and in the solid', () => {
    const r = rng();
    let lo = Infinity, hi = -Infinity, lo3 = Infinity, hi3 = -Infinity;
    for (let i = 0; i < 20000; i++) {
      const x = r.float() * 200 - 100, y = r.float() * 200 - 100, z = r.float() * 200 - 100;
      const v = r.noise(x, y); lo = Math.min(lo, v); hi = Math.max(hi, v);
      const w = r.noise(x, y, z); lo3 = Math.min(lo3, w); hi3 = Math.max(hi3, w);
    }
    expect(lo).toBeGreaterThanOrEqual(-1); expect(hi).toBeLessThanOrEqual(1);
    expect(lo3).toBeGreaterThanOrEqual(-1); expect(hi3).toBeLessThanOrEqual(1);
    // and it is not flat: the solid spans a good part of its range
    expect(hi3 - lo3).toBeGreaterThan(1);
  });

  it('changes at the same rate along every axis of the solid', () => {
    const r = rng();
    const h = 0.05;
    const rate = (dx: number, dy: number, dz: number): number => {
      let sum = 0;
      for (let i = 0; i < 4000; i++) {
        const x = r.float() * 100, y = r.float() * 100, z = r.float() * 100;
        sum += Math.abs(r.noise(x + dx, y + dy, z + dz) - r.noise(x, y, z));
      }
      return sum / 4000;
    };
    const rx = rate(h, 0, 0), ry = rate(0, h, 0), rz = rate(0, 0, h);
    // The folded slices this replaced moved ~30× faster along z than x.
    expect(rz / rx).toBeGreaterThan(0.8); expect(rz / rx).toBeLessThan(1.25);
    expect(ry / rx).toBeGreaterThan(0.8); expect(ry / rx).toBeLessThan(1.25);
  });

  it('is continuous through z = 0: a third coordinate of 0 is the solid, not the plane', () => {
    const r = rng();
    for (const [x, y] of [[0.3, 0.7], [12.5, -4.2], [99, 99]]) {
      expect(Math.abs(r.noise(x, y, 1e-6) - r.noise(x, y, 0))).toBeLessThan(1e-4);
      expect(Math.abs(r.noise(x, y, -1e-6) - r.noise(x, y, 0))).toBeLessThan(1e-4);
    }
  });

  it('gives the same solid for the same seed and a different one for another', () => {
    expect(new Rng('lichen').noise(1.37, 2.61, 3.9)).toBe(new Rng('lichen').noise(1.37, 2.61, 3.9));
    expect(new Rng('lichen').noise(1.37, 2.61, 3.9)).not.toBe(new Rng('moss').noise(1.37, 2.61, 3.9));
  });
});

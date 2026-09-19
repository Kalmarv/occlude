/**
 * `m.smooth(name)`: the 2D half of `mesh.smooth`.
 *
 * `force.relax` smooths POSITIONS. Nothing smoothed a COLUMN, so a tone
 * read off an image stayed speckled, and speckle in a density column is
 * banding on paper.
 */
import { describe, expect, it } from 'vitest';
import { curve, material } from '../src/material.js';

const chain = () => curve([[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]], { closed: false });

describe('m.smooth', () => {
  it('replaces a value by the mean of itself and its neighbours', () => {
    const m = chain().attribute('t', (p) => (p.index === 2 ? 3 : 0));
    const out = m.smooth('t');
    // Vertex 2 has two neighbours: (3 + 0 + 0) / 3 = 1. Its neighbours each
    // have two: (0 + 0 + 3) / 3 = 1. The ends have one: (0 + 0) / 2 = 0.
    expect([...out.attrs.t].map((v) => Math.round(v * 100) / 100)).toEqual([0, 1, 1, 1, 0]);
  });

  it('every pass reads the last one, so row order cannot matter', () => {
    const m = chain().attribute('t', (p) => (p.index === 0 ? 1 : 0));
    const once = m.smooth('t');
    expect([...m.smooth('t', { steps: 2 }).attrs.t]).toEqual([...once.smooth('t').attrs.t]);
  });

  it('widens a step into a ramp, which is what it is for', () => {
    const m = curve(Array.from({ length: 21 }, (_, i) => [i * 5, 0] as [number, number]), { closed: false })
      .attribute('tone', (p) => (p.index < 10 ? 0 : 1));
    const eased = m.smooth('tone', { steps: 8 });
    const t = [...eased.attrs.tone];
    // Still rising all the way across, and no longer a cliff.
    for (let i = 1; i < t.length - 1; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1] - 1e-12);
    expect(Math.max(...t.slice(1, -1).map((v, i) => v - t[i]))).toBeLessThan(0.5);
  });

  it('smooths an EDGE column over the edges that share a vertex', () => {
    const m = chain().edgeAttribute('w', (e) => (e.index === 0 ? 4 : 0));
    const out = m.smooth('w');
    // Edge 0 touches edge 1 only: (4 + 0) / 2 = 2. Edge 1 touches 0 and 2:
    // (0 + 4 + 0) / 3. Edge 3 touches edge 2 alone: (0 + 0) / 2 = 0.
    expect([...out.edgeAttrs.w].map((v) => Math.round(v * 100) / 100)).toEqual([2, 1.33, 0, 0]);
  });

  it('a row with no neighbours keeps what it had', () => {
    const lone = material([[0, 0], [50, 50]]).attribute('t', (p) => p.index);
    expect([...lone.smooth('t', { steps: 5 }).attrs.t]).toEqual([0, 1]);
  });

  it('keeps every identity, because it sets a column and moves nothing', () => {
    const m = chain().attribute('t', () => 1);
    const out = m.smooth('t', { steps: 3 });
    expect([...out.pointIds]).toEqual([...m.pointIds]);
    expect([...out.edgeIds]).toEqual([...m.edgeIds]);
    expect(out.pts).toEqual(m.pts);
  });

  it('keeps a declared transfer policy', () => {
    const m = chain().attribute('t', () => 1, { transfer: 'nearest' });
    expect(m.smooth('t').transfers.t).toBe('nearest');
  });

  it('zero passes is the material, and a missing column is refused by name', () => {
    const m = chain().attribute('t', () => 1);
    expect([...m.smooth('t', { steps: 0 }).attrs.t]).toEqual([...m.attrs.t]);
    expect(() => m.smooth('nope')).toThrow(/no point or edge column 'nope'/);
    expect(() => m.smooth('t', { steps: -1 })).toThrow(/whole number of passes/);
  });
});

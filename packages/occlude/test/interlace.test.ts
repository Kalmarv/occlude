import { describe, expect, it } from 'vitest';
import { append, curve, interlace, material, type Material } from '../src/index.js';

const ink = (m: Material) => {
  let s = 0;
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    s += Math.hypot(m.x[a] - m.x[b], m.y[a] - m.y[b]);
  }
  return s;
};
const cross = () => append(curve([[0, 50], [100, 50]]), curve([[50, 0], [50, 100]]));

describe('interlace', () => {
  it('breaks exactly one strand at a crossing, by the length it was given', () => {
    const x = cross();
    const woven = interlace(x, { gap: 8 });
    // One strand survives whole, the other is in two pieces.
    expect(woven.curves().length).toBe(3);
    // The ink lost is the gap, once.
    expect(ink(woven)).toBeCloseTo(ink(x) - 8, 6);
    // A wider gap takes more, and a zero gap takes nothing.
    expect(ink(interlace(x, { gap: 20 }))).toBeCloseTo(ink(x) - 20, 6);
    expect(ink(interlace(x, { gap: 0 }))).toBeCloseTo(ink(x), 6);
    expect(interlace(x, { gap: 0 }).curves().length).toBe(2);
  });

  it('`over` decides which one, and it is the only thing that does', () => {
    const x = cross();
    // Strand A always on top: the vertical one is the one that loses length.
    const aOver = interlace(x, { gap: 10, over: () => true });
    const bOver = interlace(x, { gap: 10, over: () => false });
    const spanY = (m: Material) => Math.max(...m.y) - Math.min(...m.y);
    const spanX = (m: Material) => Math.max(...m.x) - Math.min(...m.x);
    // Both keep their full extent; what changes is which one has a hole, so
    // compare the piece counts either side.
    expect(aOver.curves().length).toBe(3);
    expect(bOver.curves().length).toBe(3);
    expect(spanX(aOver)).toBeCloseTo(100, 6);
    expect(spanY(bOver)).toBeCloseTo(100, 6);
    // The two answers are genuinely different drawings.
    expect(Array.from(aOver.y)).not.toEqual(Array.from(bOver.y));
    // The crossing it is handed knows where it is.
    const seen: number[][] = [];
    interlace(x, { gap: 4, over: (c) => { seen.push([c.x, c.y]); return true; } });
    expect(seen).toEqual([[50, 50]]);
  });

  it('a strand may cross itself, but never its own next segment', () => {
    // A figure of eight crosses itself once.
    const eight = curve([[0, 0], [40, 40], [40, 0], [0, 40]], { closed: false });
    expect(interlace(eight, { gap: 6 }).curves().length).toBe(2);
    // A plain zig-zag has adjacent segments meeting at every vertex, and not
    // one of those is a crossing.
    const zig = curve([[0, 0], [10, 20], [20, 0], [30, 20], [40, 0]]);
    expect(ink(interlace(zig, { gap: 5 }))).toBeCloseTo(ink(zig), 6);
    // Two strands that merely touch end to end are not crossing either.
    const touch = append(curve([[0, 0], [10, 0]]), curve([[10, 0], [20, 0]]));
    expect(ink(interlace(touch, { gap: 3 }))).toBeCloseTo(ink(touch), 6);
  });

  it('a curve with nothing crossing it loses nothing, seam included', () => {
    // Two segments that share an endpoint MEET, they do not cross — but one of
    // the orientation test's four values is exactly zero at a shared vertex,
    // which reads as a crossing unless it is excluded. A closed chain always
    // has such a pair at its seam, so this used to cost a lone circle half a
    // gap with nothing near it.
    const ring = curve(Array.from({ length: 120 }, (_, k) => {
      const a = (k / 120) * Math.PI * 2;
      return [50 + Math.cos(a) * 30, 50 + Math.sin(a) * 30] as [number, number];
    }), { closed: true });
    expect(ink(interlace(ring, { gap: 5 }))).toBeCloseTo(ink(ring), 9);
    expect(interlace(ring, { gap: 5 }).curves().length).toBe(1);
    const box = curve([[0, 0], [30, 0], [30, 30], [0, 30]], { closed: true });
    expect(ink(interlace(box, { gap: 4 }))).toBeCloseTo(ink(box), 9);
    // Two separate closed curves that do not touch keep every millimetre.
    const apart = append(box, curve([[100, 0], [130, 0], [130, 30], [100, 30]], { closed: true }));
    expect(ink(interlace(apart, { gap: 6 }))).toBeCloseTo(ink(apart), 9);
    // And one that genuinely does cross still loses exactly one gap.
    expect(ink(interlace(cross(), { gap: 6 }))).toBeCloseTo(ink(cross()) - 6, 6);
  });

  it('is deterministic, and refuses what it cannot use', () => {
    const x = cross();
    expect(Array.from(interlace(x, { gap: 7 }).x)).toEqual(Array.from(interlace(x, { gap: 7 }).x));
    // A gap below zero cuts nothing away; a missing one is still a mistake.
    expect(Array.from(interlace(x, { gap: -1 }).x)).toEqual(Array.from(interlace(x, { gap: 0 }).x));
    expect(() => interlace(x, {} as never)).toThrow(/non-negative length/);
    expect(() => interlace(x, { gap: 4, over: 1 as never })).toThrow(/must be a function/);
    // Nothing to weave is not an error.
    expect(interlace(material([]), { gap: 4 }).edgeCount).toBe(0);
    expect(ink(interlace(curve([[0, 0], [9, 9]]), { gap: 4 }))).toBeCloseTo(Math.hypot(9, 9), 6);
  });
});

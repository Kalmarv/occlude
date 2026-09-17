import { describe, expect, it } from 'vitest';
import { append, curve, material, mm, oscillate, type Material } from '../src/index.js';

const line = (x0: number, y0: number, x1: number, y1: number) => curve([[x0, y0], [x1, y1]]);
const ys = (m: Material) => Array.from(m.y);
/** Local extrema of the swing, which is how many half-cycles were drawn. */
const turns = (v: number[]) => {
  let n = 0;
  for (let k = 1; k + 1 < v.length; k++) if ((v[k] - v[k - 1]) * (v[k + 1] - v[k]) < 0) n++;
  return n;
};

describe('oscillate', () => {
  it('swings to the amplitude, at the wavelength, about the chain it was given', () => {
    const w = oscillate(line(0, 50, 120, 50), { wavelength: 10, amplitude: 4 });
    const v = ys(w);
    // The swing reaches the amplitude either side and no further.
    expect(Math.max(...v)).toBeCloseTo(54, 1);
    expect(Math.min(...v)).toBeCloseTo(46, 1);
    // The chain is unmoved along its own direction: x still spans the source.
    expect(Math.min(...w.x)).toBeCloseTo(0, 6);
    expect(Math.max(...w.x)).toBeCloseTo(120, 6);
    // 120 units at a 10-unit wavelength is 12 cycles, so 24 turning points
    // (the ends are not turns).
    expect(turns(v)).toBe(24);
    // Zero amplitude leaves the chain where it was.
    const flat = oscillate(line(0, 50, 120, 50), { wavelength: 10, amplitude: 0 });
    expect(Math.max(...flat.y)).toBeCloseTo(50, 9);
    expect(Math.min(...flat.y)).toBeCloseTo(50, 9);
    // The source is untouched.
    const src = line(0, 50, 120, 50);
    oscillate(src, { wavelength: 10, amplitude: 4 });
    expect(src.n).toBe(2);
  });

  it('phase is integrated, so a wavelength that varies still packs more cycles where it is short', () => {
    // Half the run at wavelength 4, half at 20: 60/4 + 60/20 = 18 cycles.
    const w = oscillate(line(0, 50, 120, 50), { wavelength: (x) => (x < 60 ? 4 : 20), amplitude: 3 });
    expect(turns(ys(w))).toBe(36);
    // Reading s/lambda instead of integrating would give 120/4 or 120/20 at
    // the joint and jump; here the two halves each carry their own count.
    const left = oscillate(line(0, 50, 60, 50), { wavelength: 4, amplitude: 3 });
    const right = oscillate(line(60, 50, 120, 50), { wavelength: 20, amplitude: 3 });
    expect(turns(ys(left)) + turns(ys(right))).toBe(36);
    // Amplitude reads the page too.
    const grow = oscillate(line(0, 50, 100, 50), { wavelength: 10, amplitude: (x) => 1 + x / 25 });
    const near = grow.y[2] - 50;
    const far = grow.y[grow.n - 3] - 50;
    expect(Math.abs(far)).toBeGreaterThan(Math.abs(near));
  });

  it('a ring closes on itself: the seam is an ordinary vertex, not a step', () => {
    const ringOf = (r: number) => curve(Array.from({ length: 400 }, (_, k) => {
      const a = (k / 400) * Math.PI * 2;
      return [50 + Math.cos(a) * r, 50 + Math.sin(a) * r] as [number, number];
    }), { closed: true });
    // `along` walks a closed chain from the seam and never repeats it, so the
    // stations span one spacing short of the loop. Fitting the cycles to that
    // short span leaves the remainder to fall across the seam as a visible
    // jump — this is the measurement that catches it.
    for (const [r, wavelength] of [[13, 6], [20, 7.3], [26, 11], [9, 4.1]]) {
      const w = oscillate(ringOf(r), { wavelength, amplitude: 2 });
      const n = w.n;
      const off = Array.from({ length: n }, (_, k) => Math.hypot(w.x[k] - 50, w.y[k] - 50) - r);
      const d = Array.from({ length: n }, (_, k) => off[(k + 1) % n] - off[k]);
      const jerk = (k: number) => Math.abs(d[(k + 1) % n] - d[k]);
      let interior = 0;
      for (let k = 0; k + 2 < n; k++) interior = Math.max(interior, jerk(k));
      // The two joints that involve the seam bend no harder than the hardest
      // joint anywhere else on the ring.
      expect(Math.max(jerk(n - 2), jerk(n - 1))).toBeLessThanOrEqual(interior);
      // And the swing still stays inside the amplitude it was given.
      expect(Math.max(...off.map(Math.abs))).toBeLessThan(2.05);
    }
    // A ring is given a whole number of cycles, never fewer than one, so a
    // circumference shorter than the wavelength still comes back to itself.
    const tiny = oscillate(ringOf(1), { wavelength: 40, amplitude: 0.3 });
    expect(tiny.n).toBeGreaterThan(2);
  });

  it('the waveform is a plain function, so a sawtooth is a caller recipe', () => {
    const tri = (u: number) => (u < 0.5 ? 4 * u - 1 : 3 - 4 * u);
    const w = oscillate(line(0, 50, 80, 50), { wavelength: 8, amplitude: 5, shape: tri, steps: 40 });
    expect(Math.max(...w.y)).toBeCloseTo(55, 0);
    // A square wave is legal too, and its samples sit at the two extremes.
    const sq = oscillate(line(0, 50, 80, 50), { wavelength: 8, amplitude: 5, shape: (u) => (u < 0.5 ? 1 : -1) });
    for (const y of sq.y) expect(Math.abs(Math.abs(y - 50) - 5)).toBeLessThan(1e-9);
    // phase shifts the start.
    const a = oscillate(line(0, 50, 40, 50), { wavelength: 8, amplitude: 5 });
    const b = oscillate(line(0, 50, 40, 50), { wavelength: 8, amplitude: 5, phase: 0.25 });
    expect(a.y[0]).toBeCloseTo(50, 6);
    expect(b.y[0]).toBeCloseTo(55, 6);
  });

  it('is deterministic, and refuses what it cannot read', () => {
    const once = oscillate(line(0, 50, 77, 50), { wavelength: 6.1, amplitude: 2.3 });
    const twice = oscillate(line(0, 50, 77, 50), { wavelength: 6.1, amplitude: 2.3 });
    expect(Array.from(once.x)).toEqual(Array.from(twice.x));
    expect(Array.from(once.y)).toEqual(Array.from(twice.y));
    const src = line(0, 50, 60, 50);
    // Lengths are material coordinates here, as for thicken: mm(1) is not resolved.
    expect(() => oscillate(src, { wavelength: mm(1) as never, amplitude: 2 })).toThrow(/is not resolved here/);
    expect(() => oscillate(src, { wavelength: 0, amplitude: 2 })).toThrow(/must be positive/);
    expect(() => oscillate(src, { wavelength: (x) => 5 - x, amplitude: 2 })).toThrow(/must be positive/);
    expect(() => oscillate(src, { amplitude: 2 } as never)).toThrow(/\{ wavelength \} is required/);
    expect(() => oscillate(src, { wavelength: 5 } as never)).toThrow(/\{ amplitude \} is required/);
    expect(() => oscillate(src, { wavelength: 5, amplitude: 2, steps: 3 })).toThrow(/at least 4/);
    // A junction has no single side to swing to; `along` already says so.
    const star = append(append(line(0, 0, 10, 0), line(10, 0, 20, 5)), line(10, 0, 20, -5)).planarize();
    expect(() => oscillate(star, { wavelength: 4, amplitude: 1 })).toThrow();
    // Lone points contribute nothing rather than erroring.
    expect(oscillate(material([[5, 5]]), { wavelength: 4, amplitude: 1 }).n).toBe(0);
    // The result is ordinary Material: the source's own columns, and none of
    // the station bookkeeping that would surprise the next operation.
    const carried = oscillate(curve([[0, 50], [60, 50]], { weight: 2 }), { wavelength: 6, amplitude: 1 });
    expect(Object.keys(carried.attrs).sort()).toEqual(['weight']);
    expect(carried.attrs.weight[0]).toBeCloseTo(2, 9);
    // So a swung ring that crosses itself planarizes without a resolver.
    const knot = oscillate(curve(Array.from({ length: 200 }, (_, k) => {
      const a = (k / 200) * Math.PI * 2;
      return [50 + Math.cos(a) * 12, 50 + Math.sin(a) * 12] as [number, number];
    }), { closed: true }), { wavelength: 9, amplitude: 20 });
    expect(() => knot.planarize().faces()).not.toThrow();
  });
});

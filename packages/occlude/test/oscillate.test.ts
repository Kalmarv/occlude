import { describe, expect, it } from 'vitest';
import { append, curve, material, mm, type Material } from '../src/index.js';

const line = (x0: number, y0: number, x1: number, y1: number) => curve([[x0, y0], [x1, y1]]);
const ys = (m: Material) => Array.from(m.y);
/** Local extrema of the swing, which is how many half-cycles were drawn. */
const turns = (v: number[]) => {
  let n = 0;
  for (let k = 1; k + 1 < v.length; k++) if ((v[k] - v[k - 1]) * (v[k + 1] - v[k]) < 0) n++;
  return n;
};

describe('oscillate', () => {
  it('a value one station cannot read leaves that station straight', () => {
    // The per-sample rule: a field that does not answer with a finite number
    // here degrades THIS station, never the drawing. Half of this line has a
    // wavelength, half has none; the half with one still swings.
    const src = line(0, 50, 100, 50);
    const half = src.oscillate({ wavelength: (x) => (x < 50 ? 8 : NaN), amplitude: 3 });
    expect(Array.from(half.x).some((x, i) => x < 50 && half.y[i] !== 50)).toBe(true);
    expect(Array.from(half.x).filter((x, i) => x > 50 && half.y[i] !== 50)).toHaveLength(0);
    // An amplitude nobody can read is no swing, and a waveform that answers
    // with nothing is no offset: the chain comes through straight either way.
    expect(ys(src.oscillate({ wavelength: 8, amplitude: () => NaN })).every((y) => y === 50)).toBe(true);
    expect(ys(src.oscillate({ wavelength: 8, amplitude: 3, shape: () => NaN })).every((y) => y === 50)).toBe(true);
  });

  it('swings to the amplitude, at the wavelength, about the chain it was given', () => {
    const w = line(0, 50, 120, 50).oscillate({ wavelength: 10, amplitude: 4 });
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
    const flat = line(0, 50, 120, 50).oscillate({ wavelength: 10, amplitude: 0 });
    expect(Math.max(...flat.y)).toBeCloseTo(50, 9);
    expect(Math.min(...flat.y)).toBeCloseTo(50, 9);
    // The source is untouched.
    const src = line(0, 50, 120, 50);
    src.oscillate({ wavelength: 10, amplitude: 4 });
    expect(src.n).toBe(2);
  });

  it('phase is integrated, so a wavelength that varies still packs more cycles where it is short', () => {
    // Half the run at wavelength 4, half at 20: 60/4 + 60/20 = 18 cycles.
    const w = line(0, 50, 120, 50).oscillate({ wavelength: (x) => (x < 60 ? 4 : 20), amplitude: 3 });
    expect(turns(ys(w))).toBe(36);
    // Reading s/lambda instead of integrating would give 120/4 or 120/20 at
    // the joint and jump; here the two halves each carry their own count.
    const left = line(0, 50, 60, 50).oscillate({ wavelength: 4, amplitude: 3 });
    const right = line(60, 50, 120, 50).oscillate({ wavelength: 20, amplitude: 3 });
    expect(turns(ys(left)) + turns(ys(right))).toBe(36);
    // Amplitude reads the page too.
    const grow = line(0, 50, 100, 50).oscillate({ wavelength: 10, amplitude: (x) => 1 + x / 25 });
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
      const w = ringOf(r).oscillate({ wavelength, amplitude: 2 });
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
    const tiny = ringOf(1).oscillate({ wavelength: 40, amplitude: 0.3 });
    expect(tiny.n).toBeGreaterThan(2);
  });

  it('the waveform is a plain function, so a sawtooth is a caller recipe', () => {
    const tri = (u: number) => (u < 0.5 ? 4 * u - 1 : 3 - 4 * u);
    const w = line(0, 50, 80, 50).oscillate({ wavelength: 8, amplitude: 5, shape: tri, steps: 40 });
    expect(Math.max(...w.y)).toBeCloseTo(55, 0);
    // A square wave is legal too, and its samples sit at the two extremes.
    const sq = line(0, 50, 80, 50).oscillate({ wavelength: 8, amplitude: 5, shape: (u) => (u < 0.5 ? 1 : -1) });
    for (const y of sq.y) expect(Math.abs(Math.abs(y - 50) - 5)).toBeLessThan(1e-9);
    // phase shifts the start.
    const a = line(0, 50, 40, 50).oscillate({ wavelength: 8, amplitude: 5 });
    const b = line(0, 50, 40, 50).oscillate({ wavelength: 8, amplitude: 5, phase: 0.25 });
    expect(a.y[0]).toBeCloseTo(50, 6);
    expect(b.y[0]).toBeCloseTo(55, 6);
  });

  it('is deterministic, and refuses what it cannot read', () => {
    const once = line(0, 50, 77, 50).oscillate({ wavelength: 6.1, amplitude: 2.3 });
    const twice = line(0, 50, 77, 50).oscillate({ wavelength: 6.1, amplitude: 2.3 });
    expect(Array.from(once.x)).toEqual(Array.from(twice.x));
    expect(Array.from(once.y)).toEqual(Array.from(twice.y));
    const src = line(0, 50, 60, 50);
    // Lengths are material coordinates here, as for thicken: mm(1) is not resolved.
    expect(() => src.oscillate({ wavelength: mm(1) as never, amplitude: 2 })).toThrow(/is not resolved here/);
    // A wavelength with no length in it has no cycle to sit on: that station
    // stays where the chain put it, and the sketch still draws.
    expect(Array.from(src.oscillate({ wavelength: 0, amplitude: 2 }).y).every((y) => y === 50)).toBe(true);
    const partly = src.oscillate({ wavelength: (x) => 5 - x, amplitude: 2 });
    expect(Array.from(partly.y).some((y) => y !== 50)).toBe(true);
    expect(Array.from(partly.x).filter((x, i) => x > 5 && partly.y[i] !== 50)).toHaveLength(0);
    expect(() => src.oscillate({ amplitude: 2 } as never)).toThrow(/\{ wavelength \} is required/);
    expect(() => src.oscillate({ wavelength: 5 } as never)).toThrow(/\{ amplitude \} is required/);
    expect(() => src.oscillate({ wavelength: 5, amplitude: 2, steps: 3 })).toThrow(/at least 4/);
    // A junction has no single side to swing to: it holds still, one vertex
    // every chain still meets (level-sets-and-chains N1).
    const star = append(append(line(0, 0, 10, 0), line(10, 0, 20, 5)), line(10, 0, 20, -5)).planarize();
    const swung = star.oscillate({ wavelength: 4, amplitude: 1 });
    expect([...swung.points].filter((p) => p.edges.length === 3).map((p) => [p.x, p.y])).toEqual([[10, 0]]);
    // Lone points contribute nothing rather than erroring.
    expect(material([[5, 5]]).oscillate({ wavelength: 4, amplitude: 1 }).n).toBe(0);
    // The result is ordinary Material: the source's own columns, and none of
    // the station bookkeeping that would surprise the next operation.
    const carried = curve([[0, 50], [60, 50]], { weight: 2 }).oscillate({ wavelength: 6, amplitude: 1 });
    expect(Object.keys(carried.attrs).sort()).toEqual(['weight']);
    expect(carried.attrs.weight[0]).toBeCloseTo(2, 9);
    // So a swung ring that crosses itself planarizes without a resolver.
    const knot = curve(Array.from({ length: 200 }, (_, k) => {
      const a = (k / 200) * Math.PI * 2;
      return [50 + Math.cos(a) * 12, 50 + Math.sin(a) * 12] as [number, number];
    }), { closed: true }).oscillate({ wavelength: 9, amplitude: 20 });
    expect(() => knot.planarize().faces()).not.toThrow();
  });
});

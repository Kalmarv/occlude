import { describe, expect, it } from 'vitest';
import { probeExpression, synth } from '../src/index.js';

const B = { x: 0, y: 0, w: 100, h: 100 };

describe('synth', () => {
  it('is deterministic: same seed and vars, same source', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const a = synth(['x', 'y'], { seed, bounds: B });
      const b = synth(['x', 'y'], { seed, bounds: B });
      expect(a.source).toBe(b.source);
      expect(a(3, 4)).toBe(b(3, 4));
    }
  });

  it('different seeds give different expressions', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 12; seed++) seen.add(synth(['x', 'y'], { seed, bounds: B }).source);
    expect(seen.size).toBeGreaterThan(6);
  });

  it('is finite everywhere over its probe bounds', () => {
    for (let seed = 0; seed < 25; seed++) {
      const f = synth(['x', 'y'], { seed, bounds: B });
      for (let j = 0; j <= 20; j++) {
        for (let i = 0; i <= 20; i++) {
          const v = f(B.x + (B.w * i) / 20, B.y + (B.h * j) / 20);
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  it('source is self-contained: pasted standalone it evaluates identically', () => {
    for (let seed = 0; seed < 20; seed++) {
      const f = synth(['x', 'y'], { seed, bounds: B });
      // Exactly what pasting into a sketch does — no synth in scope.
      const pasted = new Function('x', 'y', `return ${f.source};`) as (x: number, y: number) => number;
      expect(/\bsynth\b/.test(f.source)).toBe(false);
      for (let j = 0; j <= 10; j++) {
        for (let i = 0; i <= 10; i++) {
          const [x, y] = [B.x + (B.w * i) / 10, B.y + (B.h * j) / 10];
          const raw = pasted(x, y);
          // The returned fn adds one guard and nothing else.
          expect(f(x, y)).toBe(Number.isFinite(raw) ? raw : 0);
        }
      }
    }
  });

  it('reports the range it produced rather than normalising it', () => {
    const f = synth(['x', 'y'], { seed: 3, bounds: B });
    expect(f.stats.finite).toBeGreaterThanOrEqual(0.95);
    expect(f.stats.spread).toBeGreaterThan(1e-6);
    expect(f.stats.tail).toBeLessThanOrEqual(20);
    expect(f.stats.lo).toBeLessThanOrEqual(f.stats.mid);
    expect(f.stats.mid).toBeLessThanOrEqual(f.stats.hi);
  });

  it('rejection fires: a constant expression is refused, and synth throws', () => {
    // A one-node tree over no usable variation: depth 0 can only emit a
    // terminal, and with `tries: 1` there is no second chance.
    let threw = 0;
    let constants = 0;
    for (let seed = 0; seed < 40; seed++) {
      try {
        synth(['x'], { seed, depth: 0, tries: 1, bounds: B });
      } catch (e) {
        threw++;
        expect(String(e)).toContain('nothing usable');
        continue;
      }
      constants++;
    }
    // Every depth-0 draw is either the bare variable (usable) or a bare
    // constant (spread 0 → rejected → throw). Both must occur.
    expect(threw).toBeGreaterThan(0);
    expect(constants).toBeGreaterThan(0);
  });

  it('the tail test catches a flat page with one spike', () => {
    // A real singularity is ONE sample, not a column: spike a whole column
    // and the 98th percentile lands on the spike, so tail is 0 by
    // construction. Model it faithfully — a gentle ramp plus one pole.
    const g = (i: number): number => B.x + (B.w * i) / 19; // probe's own grid
    const ramp = (x: number, _y: number): number => x * 0.1;
    const withPole = (x: number, y: number): number =>
      ramp(x, y) + (x === g(10) && y === g(10) ? 1e6 : 0);
    const clean = probeExpression(ramp as (...a: number[]) => number, ['x', 'y'], B);
    const spiked = probeExpression(withPole as (...a: number[]) => number, ['x', 'y'], B);
    // Same body, same range — min/max would not tell these apart at all.
    expect(spiked.lo).toBeCloseTo(clean.lo, 6);
    expect(spiked.hi).toBeCloseTo(clean.hi, 6);
    expect(clean.tail).toBeLessThanOrEqual(20);
    expect(spiked.tail).toBeGreaterThan(20);
  });

  it('warp gives two independent expressions over the same pool', () => {
    const w = synth.warp(['x', 'y'], { seed: 11, bounds: B });
    expect(w.source).toHaveLength(2);
    expect(w.source[0]).not.toBe(w.source[1]);
    const [dx, dy] = w(10, 20);
    expect(Number.isFinite(dx)).toBe(true);
    expect(Number.isFinite(dy)).toBe(true);
    const again = synth.warp(['x', 'y'], { seed: 11, bounds: B });
    expect(again.source).toEqual(w.source);
  });

  it('respects a node cap and rejects a bad variable name', () => {
    const f = synth(['x', 'y'], { seed: 5, depth: 6, nodes: 6, bounds: B });
    expect(f.source.length).toBeLessThan(400);
    expect(() => synth(['x y'], { seed: 1, bounds: B })).toThrow('not a variable name');
    expect(() => synth([], { seed: 1, bounds: B })).toThrow('at least one variable');
  });
});

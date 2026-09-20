/**
 * coil: the chain wound into a spring.
 *
 * A swing (`oscillate`) crosses the chain twice a turn. A coil never
 * crosses it — the loop goes round, and the chain stays inside it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, curve, initOcclude, material, mm, type Material } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

const line = (x0: number, y0: number, x1: number, y1: number): Material => curve([[x0, y0], [x1, y1]], { closed: false });
const ys = (m: Material) => Array.from(m.y);
/** Times a list changes direction: one loop turns twice. */
const turns = (v: number[]) => {
  let n = 0;
  for (let k = 1; k + 1 < v.length; k++) if ((v[k] - v[k - 1]) * (v[k + 1] - v[k]) < 0) n++;
  return n;
};

describe('coil', () => {
  it('loops to one side of the chain and comes back to it once a turn', () => {
    const w = line(0, 50, 100, 50).coil({ radius: 4, pitch: 20 });
    const v = ys(w);
    // A rolled circle of radius 4 reaches 2r to ONE side and never the
    // other: that is the difference between a loop and a swing.
    expect(Math.max(...v)).toBeCloseTo(58, 1);
    expect(Math.min(...v)).toBeCloseTo(50, 6);
    // Five turns over 100 units at a pitch of 20; each turn is one hump.
    expect(turns(v)).toBe(5 + 4);
    // It touches the chain again at the end of every turn.
    const touches = v.filter((y) => Math.abs(y - 50) < 1e-9).length;
    expect(touches).toBeGreaterThanOrEqual(5);
  });

  it('goes back and forth along the chain within a turn, which a swing never does', () => {
    // The tangent part of the offset is what makes it a loop: x is not
    // monotonic along an east-west chain.
    const w = line(0, 50, 100, 50).coil({ radius: 6, pitch: 12 });
    const xs = Array.from(w.x);
    expect(turns(xs)).toBeGreaterThan(0);
  });

  it('a radius of zero is the chain it was given', () => {
    const src = line(0, 50, 100, 50);
    const out = src.coil({ radius: 0, pitch: 10 });
    expect(out.n).toBe(src.n);
    expect(ys(out).every((y) => y === 50)).toBe(true);
    expect(Array.from(out.x)).toEqual(Array.from(src.x));
  });

  it('a pitch no station can read leaves that station straight, and one nowhere leaves the chain', () => {
    const src = line(0, 50, 100, 50);
    // Half the line has a pitch and half has none: the half with one winds.
    const half = src.coil({ radius: 3, pitch: (x) => (x < 50 ? 8 : NaN) });
    expect(Array.from(half.x).some((x, i) => x < 50 && half.y[i] !== 50)).toBe(true);
    // A pitch nowhere: the chain comes through as it is.
    const straight = src.coil({ radius: 3, pitch: () => NaN });
    expect(straight.n).toBe(src.n);
    // A radius nobody can read is no loop at that station.
    expect(ys(src.coil({ radius: () => NaN, pitch: 8 })).every((y) => y === 50)).toBe(true);
  });

  it('a ring winds a whole number of turns, so the seam does not step', () => {
    const ring = connect.ring(material(Array.from({ length: 120 }, (_, k) => {
      const a = (k / 120) * Math.PI * 2;
      return [50 + 30 * Math.cos(a), 50 + 30 * Math.sin(a)] as [number, number];
    })));
    // A pitch that does not divide the circumference: the fit rounds it.
    const out = ring.coil({ radius: 2, pitch: 17 });
    expect(out.closed).toBe(true);
    const first = out.points.at(0);
    const last = out.points.at(out.n - 1);
    // The seam closes on itself: the last station is one sample from the
    // first, not a radius away from it.
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(2);
  });

  it('refuses what it cannot read, and a junction', () => {
    const src = line(0, 50, 100, 50);
    expect(() => src.coil({ pitch: 10 } as never)).toThrow('radius');
    expect(() => src.coil({ radius: 3 } as never)).toThrow('pitch');
    expect(() => src.coil({ radius: mm(1) as never, pitch: 10 })).toThrow('coordinates');
    expect(() => src.coil({ radius: 3, pitch: 10, steps: 2 })).toThrow('steps');
    expect(() => src.coil({ radius: 3, pitch: 10, phase: NaN })).toThrow('phase');
    const tee = material([[0, 0], [10, 0], [20, 0], [10, 10]]).withEdges([[0, 1], [1, 2], [1, 3]]);
    expect(() => tee.coil({ radius: 2, pitch: 5 })).toThrow('junction');
  });

  it('carries the point columns and refuses a distributed edge column', () => {
    const src = line(0, 50, 100, 50).attribute('heat', (p) => p.x / 100);
    const out = src.coil({ radius: 2, pitch: 10 });
    expect(out.attrNames).toEqual(['heat']);
    for (const p of out.points) expect(p.heat).toBeGreaterThanOrEqual(0);
    const shared = src.edgeAttribute('ink', () => 1, { transfer: 'distribute' });
    expect(() => shared.coil({ radius: 2, pitch: 10 })).toThrow('distribute');
  });
});

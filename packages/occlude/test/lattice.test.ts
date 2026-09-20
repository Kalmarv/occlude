/**
 * `t.lattice` — a grid of values you can step.
 *
 * The contract, in order: the grid the spacing asks for, the field it hands
 * back, the two bulk verbs (`diffuse` conserves, `decay` scales), a
 * Gray-Scott recipe that is not uniform and is reproducible, deposits
 * landing in the right cell, contours off a lattice field, the degenerate
 * inputs that must draw nothing rather than throw, and the immutability the
 * whole value rests on.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { circle, curve, initOcclude, material, type Lattice, type LatticeRule } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

const disc = (cx: number, cy: number, r: number, n = 64): [number, number][] =>
  Array.from({ length: n }, (_, k) => {
    const a = (2 * Math.PI * k) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });

/** Every in-lattice value of a channel, in row-major order — the cells the
 * area named, with the frozen outside left out. */
const live = (lat: Lattice, channel = 'a'): number[] => {
  const out: number[] = [];
  const f = lat.field(channel);
  const a = lat.values[channel];
  for (let j = 0; j < lat.rows; j++) for (let i = 0; i < lat.cols; i++) {
    const x = lat.bounds.x + (i + 0.5) * lat.spacing;
    const y = lat.bounds.y + (j + 0.5) * lat.spacing;
    if (!Number.isNaN(f(x, y))) out.push(a[j * lat.cols + i]);
  }
  return out;
};

const total = (lat: Lattice, channel = 'a'): number => {
  let s = 0;
  const a = lat.values[channel];
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};

describe('the grid a spacing asks for', () => {
  it('covers the drawable in whole cells, centred on it', () => {
    const t = toolkit();
    const b = t.bounds();
    const lat = t.lattice({ spacing: 4 });
    expect(lat.cols).toBe(Math.ceil(b.w / 4));
    expect(lat.rows).toBe(Math.ceil(b.h / 4));
    expect(lat.spacing).toBe(4);
    expect(lat.n).toBe(lat.cols * lat.rows);
    expect(lat.bounds.w).toBeCloseTo(lat.cols * 4, 9);
    expect(lat.bounds.h).toBeCloseTo(lat.rows * 4, 9);
    // The drawable's box sits in the middle of the grid's box.
    expect(lat.bounds.x + lat.bounds.w / 2).toBeCloseTo(b.w / 2, 9);
    expect(lat.bounds.y + lat.bounds.h / 2).toBeCloseTo(b.h / 2, 9);
    expect(lat.channels).toEqual(['a']);
  });

  it('takes its extent from an area and names the cells inside it', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 2, area: disc(50, 50, 20) });
    expect(lat.cols).toBe(20);
    expect(lat.rows).toBe(20);
    expect(lat.bounds.x).toBeCloseTo(30, 6);
    // A disc of radius 20 covers about π/4 of its box.
    let inside = 0;
    for (let j = 0; j < lat.rows; j++) for (let i = 0; i < lat.cols; i++) if (lat.field()(lat.bounds.x + (i + 0.5) * 2, lat.bounds.y + (j + 0.5) * 2) === 0) inside++;
    expect(inside / lat.n).toBeGreaterThan(0.7);
    expect(inside / lat.n).toBeLessThan(0.82);
  });

  it('holds several named channels, and refuses one it does not have', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 5, channels: ['u', 'v'] }, () => ({ u: 1, v: 2 }));
    expect(Object.keys(lat.values)).toEqual(['u', 'v']);
    expect(lat.sample('u', 0, 0)).toBe(1);
    expect(lat.sample('v', 0, 0)).toBe(2);
    expect(() => lat.field('w')).toThrow(/no channel 'w'/);
    expect(() => lat.sample('w', 0, 0)).toThrow(/no channel 'w'/);
    expect(() => t.lattice({ spacing: 5, channels: ['u', 'u'] })).toThrow(/repeated channel/);
    expect(() => t.lattice({ spacing: 5, channels: [] })).toThrow(/at least one channel/);
    expect(() => t.lattice({ spacing: 5 }, () => ({ zz: 1 }))).toThrow(/no channel 'zz'/);
    expect(() => t.lattice({} as never)).toThrow(/spacing/);
  });

  it('caps a spacing fine enough to exhaust memory', () => {
    const t = toolkit();
    expect(() => t.lattice({ spacing: 0.001 })).toThrow(/cells \(spacing too fine\)/);
  });
});

describe('a channel as a field', () => {
  it('reads each cell exactly at its centre and interpolates between', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 5 }, (x) => x);
    const f = lat.field();
    for (const [i, j] of [[0, 0], [3, 7], [19, 19]] as const) {
      const cx = lat.bounds.x + (i + 0.5) * 5;
      const cy = lat.bounds.y + (j + 0.5) * 5;
      expect(f(cx, cy)).toBeCloseTo(lat.sample('a', i, j), 4);
      expect(f(cx, cy)).toBeCloseTo(cx, 3);
    }
    // Halfway between two centres is the mean of the two.
    const a = lat.bounds.x + 0.5 * 5;
    const b = lat.bounds.x + 1.5 * 5;
    expect(f((a + b) / 2, lat.bounds.y + 2.5)).toBeCloseTo((lat.sample('a', 0, 0) + lat.sample('a', 1, 0)) / 2, 4);
  });

  it('is absent outside the area, which is what within means', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 2, area: disc(50, 50, 20) }, () => 1);
    const f = lat.field();
    expect(f(50, 50)).toBeCloseTo(1, 5);
    expect(Number.isNaN(f(31, 31))).toBe(true);   // in the box, outside the disc
    expect(Number.isNaN(f(5, 5))).toBe(true);     // outside the box
  });
});

describe('the bulk verbs every rule wants', () => {
  it('diffuse conserves the channel total, with zero flux at the area edge', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 2, area: disc(50, 50, 20) }, (x, y) => Math.exp(-((x - 44) ** 2 + (y - 52) ** 2) / 6));
    const before = total(lat);
    expect(before).toBeGreaterThan(0.5);
    const after = lat.steps(40, (_cur, next) => next.diffuse('a', 0.24));
    expect(after.n).toBe(lat.n);
    expect(total(after)).toBeCloseTo(before, 3);
    // It really spread: the peak came down.
    expect(Math.max(...live(after))).toBeLessThan(Math.max(...live(lat)) / 2);
  });

  it('decay scales the whole channel', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 5 }, () => 4);
    const once = lat.steps(1, (_cur, next) => next.decay('a', 0.25));
    expect(once.sample('a', 3, 3)).toBeCloseTo(3, 6);
    const thrice = lat.steps(3, (_cur, next) => next.decay('a', 0.5));
    expect(thrice.sample('a', 3, 3)).toBeCloseTo(0.5, 6);
  });

  it('set, add and the neighbourhood read the frozen state', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 10 }, (x, y) => (x < 50 && y < 50 ? 1 : 0));
    // Every cell becomes the mean of its four neighbours — the five-tap
    // blur this whole value exists to replace.
    const blur: LatticeRule = (cur, next) => {
      for (let j = 0; j < cur.rows; j++) for (let i = 0; i < cur.cols; i++) {
        const nb = cur.neighbours(i, j);
        if (nb.length === 0) continue;
        let s = 0;
        for (const [ni, nj] of nb) s += cur.at('a', ni, nj);
        next.set('a', i, j, s / nb.length);
      }
    };
    const out = lat.steps(1, blur);
    // A corner cell inside the block: two neighbours at 1, none outside.
    expect(out.sample('a', 0, 0)).toBeCloseTo(1, 6);
    // The cell just past the block's edge picks its neighbours up.
    expect(out.sample('a', 5, 0)).toBeGreaterThan(0);
    expect(out.sample('a', 5, 0)).toBeLessThan(1);
    // A write outside the lattice is dropped, not an error.
    const guarded = lat.steps(1, (_cur, next) => { next.set('a', -1, 0, 9); next.add('a', 999, 0, 9); });
    expect(guarded.values.a).toEqual(lat.values.a);
  });
});

describe('a Gray-Scott recipe, written in the sketch', () => {
  const grayScott = (feed: number, kill: number): LatticeRule => (cur, next) => {
    for (let j = 0; j < cur.rows; j++) for (let i = 0; i < cur.cols; i++) {
      if (!cur.inside(i, j)) continue;
      const a = cur.at('a', i, j);
      const b = cur.at('b', i, j);
      const abb = a * b * b;
      next.set('a', i, j, a + 0.2 * cur.laplacian('a', i, j) - abb + feed * (1 - a));
      next.set('b', i, j, b + 0.1 * cur.laplacian('b', i, j) + abb - (feed + kill) * b);
    }
  };

  const seeded = (seed: number): Lattice => {
    const t = toolkit({ seed });
    return t.lattice({ spacing: 2, channels: ['a', 'b'] }, (x, y) => ({
      a: 1,
      b: t.noise(x / 9, y / 9) > 0.45 ? 0.35 : 0,
    })).steps(200, grayScott(0.055, 0.062));
  };

  it('leaves a field with both high and low ground', () => {
    const out = seeded(4);
    const b = live(out, 'b');
    expect(Math.max(...b)).toBeGreaterThan(0.15);
    expect(Math.min(...b)).toBeLessThan(0.02);
    expect(b.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('is the same run twice, value for value', () => {
    expect(Array.from(seeded(4).values.b)).toEqual(Array.from(seeded(4).values.b));
    expect(Array.from(seeded(5).values.b)).not.toEqual(Array.from(seeded(4).values.b));
  });
});

describe('the coral fence, value for value', () => {
  /** The docs' Gray-Scott fence (docs/fields.md, "A lattice you can step")
   * at 300 steps instead of 5000: same seed, same disc, same spacing, same
   * four lines of rule. It is here as a fixture, not as a behaviour — the
   * digests below are the bits `steps` produced on 2026-09-20, and any
   * change to `lattice.ts` that moves one of them moves the ink of every
   * lattice drawing in the library. Stepping may get faster; it may not get
   * different. */
  const FENCE = {
    cols: 88,
    rows: 88,
    n: 7744,
    a: 'a89f0bcb',
    b: '5ae8d1f4',
    // [index, a, b] at four cells in and around the pattern.
    spots: [
      [3916, 0.9357668161392212, 0.0022696638479828835],
      [3922, 0.606889545917511, 0.1655500829219818],
      [4444, 0.513632595539093, 0.23602043092250824],
      [3388, 0.6823880672454834, 0.11589141190052032],
    ] as const,
  };

  /** FNV-1a over the buffer's bytes — a byte-identical check that fits in
   * a test file. Two Float32Arrays share a digest only if every bit agrees,
   * NaN payloads and signed zeroes included. */
  const digest = (buf: Float32Array): string => {
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };

  it('steps the docs recipe to the same bits it did before', () => {
    const t = toolkit({ seed: 12 });
    const disc = circle(50, 50, 44);
    const feed = 0.055, kill = 0.062, Du = 0.16, Dv = 0.08;
    const seeded = t.lattice({ spacing: 1, area: disc, channels: ['a', 'b'] }, (x, y) =>
      Math.hypot(x - 50, y - 50) < 12 + t.noise(x / 8, y / 8) * 4 ? { a: 0.5, b: 0.25 } : { a: 1, b: 0 });
    const grown = seeded.steps(300, (cur, next) => {
      for (let j = 0; j < cur.rows; j++) for (let i = 0; i < cur.cols; i++) {
        if (!cur.inside(i, j)) continue;
        const a = cur.at('a', i, j), b = cur.at('b', i, j);
        const abb = a * b * b;
        next.set('a', i, j, a + Du * cur.laplacian('a', i, j) - abb + feed * (1 - a));
        next.set('b', i, j, b + Dv * cur.laplacian('b', i, j) + abb - (feed + kill) * b);
      }
    });
    expect([grown.cols, grown.rows, grown.n]).toEqual([FENCE.cols, FENCE.rows, FENCE.n]);
    for (const [idx, a, b] of FENCE.spots) {
      expect(grown.values.a[idx]).toBe(a);
      expect(grown.values.b[idx]).toBe(b);
    }
    expect(digest(grown.values.a)).toBe(FENCE.a);
    expect(digest(grown.values.b)).toBe(FENCE.b);
  });
});

describe('depositing points', () => {
  it('lands each point in the cell that contains it', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 10 });
    const pts = material([[5, 5], [5, 5], [45, 85], [-20, 50]]);
    const out = lat.add(pts, 2);
    expect(out.cell(5, 5)).toEqual({ i: 0, j: 0 });
    expect(out.sample('a', 0, 0)).toBe(4);
    expect(out.sample('a', 4, 8)).toBe(2);
    // The point off the lattice deposited nothing.
    expect(total(out)).toBe(6);
    // One point, a curve's points and a selection are all positions.
    expect(lat.add([15, 15], 1).sample('a', 1, 1)).toBe(1);
    expect(lat.add({ x: 15, y: 15 }, 1).sample('a', 1, 1)).toBe(1);
    expect(lat.add(curve([[15, 15], [25, 25]]).points, 1).sample('a', 2, 2)).toBe(1);
  });

  it('deposits nothing outside the area, and names an unknown channel', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 2, area: disc(50, 50, 20), channels: ['trail'] });
    expect(total(lat.add([50, 50], 5, 'trail'), 'trail')).toBe(5);
    expect(total(lat.add([31, 31], 5, 'trail'), 'trail')).toBe(0);
    expect(() => lat.add([50, 50], 1, 'nope')).toThrow(/no channel 'nope'/);
  });
});

describe('a lattice field feeds everything that reads a field', () => {
  it('yields contours through t.isolines', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 3 }, (x, y) => Math.exp(-((x - 50) ** 2 + (y - 50) ** 2) / 400));
    const iso = t.isolines(lat.field(), 0.3);
    expect(iso.n).toBeGreaterThan(8);
    expect(iso.curves().length).toBeGreaterThan(0);
    for (const p of iso.points) {
      expect(Math.hypot(p.x - 50, p.y - 50)).toBeLessThan(30);
    }
  });
});

describe('degenerate input draws nothing and never throws', () => {
  it('makes an empty lattice from a spacing at or below zero', () => {
    const t = toolkit();
    for (const spacing of [0, -1] as const) {
      const lat = t.lattice({ spacing });
      expect(lat.n).toBe(0);
      expect(lat.cols).toBe(0);
      expect(lat.field()(50, 50)).toBe(0);
      expect(lat.sample('a', 0, 0)).toBe(0);
      expect(lat.steps(10, (_cur, next) => next.decay('a', 0.5)).n).toBe(0);
      expect(lat.add([50, 50], 1).n).toBe(0);
    }
  });

  it('makes an empty lattice from an area with no extent', () => {
    const t = toolkit();
    for (const area of [[], [[[10, 10], [10, 10], [10, 10]]]] as never[]) {
      const lat = t.lattice({ spacing: 2, area });
      expect(lat.n).toBe(0);
      expect(lat.field()(10, 10)).toBe(0);
    }
  });
});

describe('the value never mutates', () => {
  it('leaves the source alone through steps and add', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 5 }, () => 1);
    const before = Array.from(lat.values.a);
    const stepped = lat.steps(5, (_cur, next) => { next.decay('a', 0.5); next.diffuse('a', 0.2); });
    const deposited = lat.add([50, 50], 7);
    expect(Array.from(lat.values.a)).toEqual(before);
    expect(stepped.values.a).not.toBe(lat.values.a);
    expect(deposited.values.a).not.toBe(lat.values.a);
    expect(stepped.sample('a', 3, 3)).toBeCloseTo(1 / 32, 5);
    expect(lat.sample('a', 3, 3)).toBe(1);
    // A second run off the same source repeats, so nothing carried over.
    expect(Array.from(lat.steps(5, (_cur, next) => { next.decay('a', 0.5); next.diffuse('a', 0.2); }).values.a)).toEqual(Array.from(stepped.values.a));
  });
});

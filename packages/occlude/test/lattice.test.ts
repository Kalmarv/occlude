/**
 * `t.lattice` — a grid of values you can step.
 *
 * The contract, in order: the grid the spacing asks for, the field it hands
 * back, the two bulk passes written with `set` (diffusion conserves, decay
 * scales), a Gray-Scott recipe run by `t.steps` that is not uniform and is
 * reproducible, deposits
 * landing in the right face, contours off a lattice field, the degenerate
 * inputs that must draw nothing rather than throw, the immutability the
 * whole value rests on, and the faces: the one face row every face kind
 * answers, the face under a point, the outline of a selection, and the
 * reductions straight off a column.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { circle, curve, material, type LatticeFace, type Lattice } from '../src/index.js';
import { initOcclude } from '../src/host.js';
import { rec } from './helpers/xy.js';

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
    expect(() => t.lattice({ spacing: 0.001 })).toThrow(/does not fit a Float64Array — the spacing is too fine/);
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

describe('the bulk passes every run wants, written with set', () => {
  /** One explicit diffusion pass: `v += rate · laplacian(v)`, zero-flux. */
  const diffuse = (rate: number) => (l: Lattice) => l.set('a', (c) => c.a + rate * c.laplacian('a'));
  /** The channel scaled by `1 − rate`. */
  const decay = (rate: number) => (l: Lattice) => l.set('a', (c) => c.a * (1 - rate));

  it('diffusion conserves the channel total, with zero flux at the area edge', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 2, area: disc(50, 50, 20) }, (x, y) => Math.exp(-((x - 44) ** 2 + (y - 52) ** 2) / 6));
    const before = total(lat);
    expect(before).toBeGreaterThan(0.5);
    const after = t.steps(40, lat, diffuse(0.24));
    expect(after.n).toBe(lat.n);
    expect(total(after)).toBeCloseTo(before, 3);
    // It really spread: the peak came down.
    expect(Math.max(...live(after))).toBeLessThan(Math.max(...live(lat)) / 2);
  });

  it('decay scales the whole channel', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 5 }, () => 4);
    expect(decay(0.25)(lat).sample('a', 3, 3)).toBeCloseTo(3, 6);
    expect(t.steps(3, lat, decay(0.5)).sample('a', 3, 3)).toBeCloseTo(0.5, 6);
  });

  it('a set reads the lattice as it was: the neighbourhood is the frozen state', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 10 }, (x, y) => (x < 50 && y < 50 ? 1 : 0));
    // Every cell becomes the mean of its four neighbours — the five-tap
    // blur this whole value exists to replace.
    const blur = (l: Lattice) => l.set('a', (c: LatticeFace) => {
      const nb = c.adjacent;
      if (nb.length === 0) return c.a;
      let s = 0;
      for (const q of nb) s += q.a;
      return s / nb.length;
    });
    const out = blur(lat);
    // A corner cell inside the block: two neighbours at 1, none outside.
    expect(out.sample('a', 0, 0)).toBeCloseTo(1, 6);
    // The cell just past the block's edge picks its neighbours up.
    expect(out.sample('a', 5, 0)).toBeGreaterThan(0);
    expect(out.sample('a', 5, 0)).toBeLessThan(1);
    // A write off the lattice reaches nothing, and is not an error.
    const guarded = lat.set('a', 9, lat.face([-5, 0])).set('a', 9, lat.face([999, 0]));
    expect(guarded.values.a).toEqual(lat.values.a);
  });

  it('faces is the in-lattice faces, row-major, each once', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 4, area: disc(50, 50, 20), channels: ['h', 'v'] }, (x, y) => ({ h: Math.exp(-((x - 50) ** 2 + (y - 50) ** 2) / 30), v: 0 }));
    const walked = [...lat.faces].map((c) => [c.i, c.j] as const);
    // The faces the area named, not the whole grid (`n` counts the grid).
    const inside = live(lat, 'h').length;
    expect(inside).toBeLessThan(lat.n);
    expect(walked.length).toBe(inside);
    expect(new Set(walked.map(([i, j]) => `${i},${j}`)).size).toBe(inside);
    for (let k = 1; k < walked.length; k++) {
      const [i0, j0] = walked[k - 1], [i1, j1] = walked[k];
      expect(j1 > j0 || (j1 === j0 && i1 > i0)).toBe(true);
    }
    // A wave: both columns in one instant, `h` taking the new speed.
    const speed = (c: LatticeFace) => c.v * 0.995 + 0.2 * c.laplacian('h');
    const waved = t.steps(30, lat, (l) => l.set({ v: speed, h: (c) => c.h + speed(c) }));
    expect(Math.min(...live(waved, 'h'))).toBeLessThan(0); // a wave, not a diffusion: it swings below zero
  });
});

describe('a Gray-Scott recipe, written in the sketch', () => {
  const grayScott = (feed: number, kill: number) => (l: Lattice) => l.set({
    a: (c) => c.a + 0.2 * c.laplacian('a') - c.a * c.b * c.b + feed * (1 - c.a),
    b: (c) => c.b + 0.1 * c.laplacian('b') + c.a * c.b * c.b - (feed + kill) * c.b,
  });

  const seeded = (seed: number): Lattice => {
    const t = toolkit({ seed });
    return t.steps(200, t.lattice({ spacing: 2, channels: ['a', 'b'] }, (x, y) => ({
      a: 1,
      b: t.noise(x / 9, y / 9) > 0.45 ? 0.35 : 0,
    })), grayScott(0.055, 0.062));
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
   * digests below are the bits the retired `lat.steps` produced on
   * 2026-09-20, and the same rule as one `set` per step of `t.steps` lands
   * on them bit for bit: `set` reads the frozen cells, sums the Laplacian in
   * the same order, and writes Float32 as the batch did. Any change to
   * `lattice.ts` that moves one of them moves the ink of every lattice
   * drawing in the library. Stepping may get faster; it may not get
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
    const grown = t.steps(300, seeded, (l) => l.set({
      a: (c) => c.a + Du * c.laplacian('a') - c.a * c.b * c.b + feed * (1 - c.a),
      b: (c) => c.b + Dv * c.laplacian('b') + c.a * c.b * c.b - (feed + kill) * c.b,
    }));
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
    expect([out.face([5, 5])!.i, out.face([5, 5])!.j]).toEqual([0, 0]);
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
    expect(iso.curves.map(rec).length).toBeGreaterThan(0);
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
      expect(t.steps(10, lat, (l) => l.set('a', (c) => c.a * 0.5)).n).toBe(0);
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
  it('leaves the source alone through t.steps and add', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 5 }, () => 1);
    const before = Array.from(lat.values.a);
    const pass = (l: Lattice) => l.set('a', (c) => c.a * 0.5).set('a', (c) => c.a + 0.2 * c.laplacian('a'));
    const stepped = t.steps(5, lat, pass);
    const deposited = lat.add([50, 50], 7);
    expect(Array.from(lat.values.a)).toEqual(before);
    expect(stepped.values.a).not.toBe(lat.values.a);
    expect(deposited.values.a).not.toBe(lat.values.a);
    expect(stepped.sample('a', 3, 3)).toBeCloseTo(1 / 32, 5);
    expect(lat.sample('a', 3, 3)).toBe(1);
    // A second run off the same source repeats, so nothing carried over.
    expect(Array.from(t.steps(5, lat, pass).values.a)).toEqual(Array.from(stepped.values.a));
  });
});

describe('a lattice face is a face', () => {
  it('answers the face row: columns, area, perimeter, centroid, bounds, contours, adjacent, a flat hierarchy', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 10, channels: ['a', 'b'] }, (x, y) => ({ a: x, b: y }));
    const f = lat.faces.at(12); // i = 2, j = 1
    expect([f.i, f.j, f.index]).toEqual([2, 1, 12]);
    expect(f.a).toBeCloseTo(lat.bounds.x + 25, 4);
    expect(f.b).toBeCloseTo(lat.bounds.y + 15, 4);
    expect(f.area).toBe(100);
    expect(f.perimeter).toBe(40);
    expect(f.centroid[0]).toBeCloseTo(lat.bounds.x + 25, 9);
    expect(f.centroid[1]).toBeCloseTo(lat.bounds.y + 15, 9);
    const b = f.bounds;
    expect([b.x, b.y, b.w, b.h]).toEqual([lat.bounds.x + 20, lat.bounds.y + 10, 10, 10]);
    expect([b.cx, b.cy]).toEqual(f.centroid);
    // One square, counter-clockwise in a y-up reading: positive signed area.
    const [loop] = f.contours();
    expect(loop.closed).toBe(true);
    expect(loop.pts).toHaveLength(4);
    let signed = 0;
    for (let k = 0; k < 4; k++) {
      const [x0, y0] = loop.pts[k];
      const [x1, y1] = loop.pts[(k + 1) % 4];
      signed += x0 * y1 - x1 * y0;
    }
    expect(signed / 2).toBeCloseTo(100, 6);
    // Four sides, four neighbours, in row order: north, west, east, south.
    expect(f.adjacent.map((q) => [q.i, q.j])).toEqual([[2, 0], [1, 1], [3, 1], [2, 2]]);
    expect(lat.faces.at(0).adjacent.length).toBe(2);
    // A lattice does not nest.
    expect(f.parent).toBeUndefined();
    expect(f.children.length).toBe(0);
    expect(f.depth).toBe(0);
    expect(f.leaf).toBe(true);
    expect(f.source).toBeUndefined();
    // A lattice has no edge or point table.
    expect((f as Record<string, unknown>).edges).toBeUndefined();
    expect((lat.faces as unknown as Record<string, unknown>).edges).toBeUndefined();
    expect((lat.faces as unknown as Record<string, unknown>).points).toBeUndefined();
    expect(() => (lat.faces as unknown as { boundaryEdges(): unknown }).boundaryEdges()).toThrow(/faces\.boundaryEdges: a lattice has no edge table/);
    // It spreads as its columns and its grid place.
    expect(Object.keys(f).sort()).toEqual(['a', 'b', 'i', 'index', 'j']);
  });

  it('refuses a column named for a field of the face', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 10 });
    for (const name of ['i', 'area', 'centroid', 'leaf', 'laplacian']) {
      expect(() => lat.set(name, 1)).toThrow(new RegExp(`'${name}' is a reserved field of a face`));
    }
    expect(() => t.lattice({ spacing: 10, channels: ['depth'] })).toThrow(/'depth' is a reserved field of a face/);
  });

  it('l.set is l.faces.set, and a where names faces, one face, a test or points', () => {
    const t = toolkit();
    const l = t.lattice({ spacing: 10 }).set('ink', 0);
    const one = l.set('ink', 3, l.faces.at(5));
    expect(l.faces.set('ink', 3, l.faces.at(5)).values.ink).toEqual(one.values.ink);
    expect(l.faces.filter((f) => f.j === 0).set('ink', 1).faces.sum('ink')).toBe(l.cols);
    expect(l.set('ink', 1, (f) => f.i === 0).faces.sum('ink')).toBe(l.rows);
    expect(l.set('ink', 1, [[5, 5], [6, 6], [15, 5]]).faces.sum('ink')).toBe(2);
    // A face of an earlier state is the same face here.
    const later = one.set('ink', (f) => f.ink + 1);
    expect(later.set('ink', 0, l.faces.at(5)).faces.at(5).ink).toBe(0);
  });
});

describe('the face under a point', () => {
  it('is the face whose square holds it, and off the lattice one that reads 0', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 10 }, (x, y) => x + y);
    const f = lat.face([lat.bounds.x + 34, lat.bounds.y + 57])!;
    expect([f.i, f.j]).toEqual([3, 5]);
    expect(f.a).toBe(lat.sample('a', 3, 5));
    // A point row is a position too.
    expect(lat.face({ x: lat.bounds.x + 1, y: lat.bounds.y + 1 })!.index).toBe(0);
    // Off the lattice: a face that reads 0 in every column, that no write
    // reaches and that has no neighbours.
    const off = lat.face([-50, 5])!;
    expect(off.a).toBe(0);
    expect(off.index).toBe(-1);
    expect(off.adjacent.length).toBe(0);
    expect(lat.set('a', 99, off).values.a).toEqual(lat.values.a);
    const outside = t.lattice({ spacing: 2, area: disc(50, 50, 20) }).face([31, 31])!;
    expect(outside.index).toBe(-1);
    // An empty pick answers nothing.
    expect(lat.face(undefined)).toBeUndefined();
  });
});

describe('the outline of some faces', () => {
  const t = toolkit();
  const lat = t.lattice({ spacing: 1, area: [[[0, 0], [10, 0], [10, 10], [0, 10]]] });
  const signedArea = (pts: readonly (readonly [number, number])[]): number => {
    let s = 0;
    for (let k = 0; k < pts.length; k++) {
      const [x0, y0] = pts[k];
      const [x1, y1] = pts[(k + 1) % pts.length];
      s += x0 * y1 - x1 * y0;
    }
    return s / 2;
  };

  it('is one loop of corners around a block', () => {
    const block = lat.faces.filter((f) => f.i >= 2 && f.i < 5 && f.j >= 3 && f.j < 7);
    const loops = block.contours();
    expect(loops).toHaveLength(1);
    expect(loops[0].closed).toBe(true);
    expect(loops[0].pts).toHaveLength(4); // a straight run keeps only its corners
    expect(signedArea(loops[0].pts)).toBeCloseTo(12, 9);
    const xs = loops[0].pts.map((p) => p[0]);
    const ys = loops[0].pts.map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([2, 5, 3, 7]);
  });

  it('keeps a hole as a hole, and the whole lattice is its rim', () => {
    const ring = lat.faces.filter((f) => !(f.i >= 3 && f.i < 6 && f.j >= 3 && f.j < 6));
    const loops = ring.contours();
    expect(loops).toHaveLength(2);
    const areas = loops.map((c) => signedArea(c.pts)).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(-9, 9);  // the hole, clockwise
    expect(areas[1]).toBeCloseTo(100, 9); // the rim
    expect(lat.faces.contours()).toHaveLength(1);
    expect(lat.faces.filter(() => false).contours()).toEqual([]);
  });

  it('splits two faces that touch only at a corner into two loops', () => {
    const pair = lat.faces.filter((f) => (f.i === 4 && f.j === 4) || (f.i === 5 && f.j === 5));
    const loops = pair.contours();
    expect(loops).toHaveLength(2);
    for (const c of loops) {
      expect(c.pts).toHaveLength(4);
      expect(signedArea(c.pts)).toBeCloseTo(1, 9);
    }
  });

  it('is the area t.within reads', () => {
    const block = lat.faces.filter((f) => f.i < 5);
    const inside = t.within(material([[2, 5], [7, 5]]), block.contours());
    expect(inside.points.map((p) => [p.x, p.y])).toEqual([[2, 5]]);
  });
});

describe('reductions read the column', () => {
  it('sum, mean, min and max agree with the shared words, over all faces and a selection', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 3, area: disc(50, 50, 30) }, (x, y) => Math.sin(x / 7) * Math.cos(y / 5));
    const some = lat.faces.filter((f) => f.i % 3 === 0).union(lat.faces.slice(7, 8));
    for (const sel of [lat.faces, some]) {
      const vals = sel.map((f) => f.a);
      let s = 0;
      for (const v of vals) s += v;
      expect(sel.sum('a')).toBe(s);
      expect(sel.mean('a')).toBe(s / vals.length);
      expect(sel.min('a')).toBe(Math.min(...vals));
      expect(sel.max('a')).toBe(Math.max(...vals));
      // A function, or a field of the face, is the shared word's.
      expect(sel.sum((f) => f.a)).toBe(s);
      expect(sel.max('i')).toBe(Math.max(...sel.map((f) => f.i)));
    }
    expect(lat.faces.filter(() => false).sum('a')).toBe(0);
    expect(Number.isNaN(lat.faces.filter(() => false).mean('a'))).toBe(true);
  });
});

describe('one write is one instant', () => {
  it('every function of a set reads the lattice as it was before the write', () => {
    const t = toolkit();
    const lat = t.lattice({ spacing: 10, channels: ['a', 'b'] }, (x) => ({ a: x, b: -x }));
    // A record swaps: `b` reads the old `a`, not the one just written.
    const swapped = lat.set({ a: (f) => f.b, b: (f) => f.a });
    expect(Array.from(swapped.values.a)).toEqual(Array.from(lat.values.b));
    expect(Array.from(swapped.values.b)).toEqual(Array.from(lat.values.a));
    // A diffusion reads its neighbours before the write: a single spike
    // spreads the same amount to all four sides, whichever is visited first.
    const spike = t.lattice({ spacing: 10 }).set('a', 1, [[55, 55]]);
    const idx = spike.face([55, 55])!;
    const spread = spike.set('a', (f) => f.a + 0.2 * f.laplacian('a'));
    const around = idx.adjacent.map((q) => spread.faces.at(spread.faces.indices.indexOf(q.index)).a);
    expect(around).toHaveLength(4);
    for (const v of around) expect(v).toBeCloseTo(0.2, 6);
    expect(spread.face([55, 55])!.a).toBeCloseTo(0.2, 6);
    // Chained writes are a sequence: the second reads what the first wrote.
    expect(lat.set('a', 1).set('b', (f) => f.a).faces.sum('b')).toBe(lat.faces.length);
  });
});

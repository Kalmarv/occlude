/**
 * The grid column (column.ts) under every lattice column: a sparse write
 * copies the tiles it reaches and shares the rest, every earlier state
 * keeps its values, and a fold reads the grid in row-major order.
 */

import { describe, expect, it } from 'vitest';
import { GridColumn } from '../src/column.js';

/** A seeded stream, so a failure replays. */
function stream(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
}

/** The fold of the finite values `keep` marks, one by one in row-major
 * order: what `reduce` must answer to the bit. */
function fold(values: Float32Array, keep: Uint8Array): { sum: number; count: number; min: number; max: number } {
  let sum = 0;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let p = 0; p < values.length; p++) {
    const v = values[p];
    if (keep[p] === 0 || !Number.isFinite(v)) continue;
    sum += v;
    count++;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { sum, count, min, max };
}

describe('a grid column', () => {
  it('a sparse write copies the tile it reaches and shares the rest', () => {
    const cols = 300;
    const rows = 200;
    const values = Float32Array.from({ length: cols * rows }, (_, p) => p);
    const g = GridColumn.of(values, cols, rows);
    expect(g.flat()).toBe(values);
    const w = g.writer([5 * cols + 250]);
    w.set(5 * cols + 250, -1);
    const h = w.done();
    expect(h.base).toBe(g.base);
    expect(h.tiles!.filter((t) => t !== undefined).length).toBe(1);
    expect(h.get(5 * cols + 250)).toBe(-1);
    expect(h.at(250, 5)).toBe(-1);
    expect(h.at(249, 5)).toBe(5 * cols + 249);
    expect(g.get(5 * cols + 250)).toBe(5 * cols + 250);
    // A write that sets nothing is the grid it started from.
    expect(h.writer('some').done()).toBe(h);
    // A dense write is a row-major grid again, with no tiles.
    const d = h.writer('all');
    d.array()![0] = 7;
    const e = d.done();
    expect(e.tiles).toBe(null);
    expect(e.get(0)).toBe(7);
    expect(e.get(5 * cols + 250)).toBe(-1);
  });

  it('every earlier state keeps its values through sparse, dense and joined states', () => {
    const rnd = stream(7);
    const ri = (n: number) => Math.floor(rnd() * n);
    for (const [cols, rows] of [[1, 1], [127, 9], [128, 8], [129, 17], [300, 3], [7, 70]]) {
      const n = cols * rows;
      const model = Float32Array.from({ length: n }, () => rnd() * 1000 - 300);
      let g = GridColumn.of(model.slice(), cols, rows);
      const states: [GridColumn, Float32Array][] = [];
      for (let step = 0; step < 40; step++) {
        states.push([g, model.slice()]);
        const op = ri(4);
        if (op < 2) {
          const places = Array.from({ length: op === 0 ? ri(6) + 1 : ri(n) + 1 }, () => ri(n));
          const w = g.writer(ri(3) === 0 ? 'some' : places);
          for (const p of places) {
            const v = Math.fround(ri(9) === 0 ? NaN : w.get(p) + rnd() * 10);
            w.set(p, v);
            model[p] = v;
          }
          g = w.done();
        } else if (op === 2) {
          const w = g.writer('all');
          const a = w.array()!;
          for (let p = ri(7); p < n; p += 7) a[p] = model[p] = Math.fround(rnd());
          g = w.done();
        } else g.flat();
        for (let k = 0; k < 20; k++) {
          const p = ri(n);
          const i = p % cols;
          expect(Object.is(g.get(p), model[p]) && Object.is(g.at(i, (p - i) / cols), model[p])).toBe(true);
        }
      }
      for (const [s, m] of states) expect(Buffer.from(s.flat().buffer).equals(Buffer.from(m.buffer))).toBe(true);
    }
  });

  it('folds the finite values it keeps in row-major order, to the bit', () => {
    const rnd = stream(11);
    const cols = 301;
    const rows = 45;
    const n = cols * rows;
    // Values over sixty octaves: summed in another order, the last bits differ.
    const values = Float32Array.from({ length: n }, (_, p) => (p % 97 === 0 ? NaN : p % 89 === 0 ? Infinity : (rnd() - 0.3) * 2 ** Math.floor(rnd() * 60 - 30)));
    let g = GridColumn.of(values.slice(), cols, rows);
    // Tiles over part of the base, so a row reads both.
    const w = g.writer('some');
    for (let k = 0; k < 40; k++) {
      const p = Math.floor(rnd() * n);
      values[p] = Math.fround(rnd() * 3);
      w.set(p, values[p]);
    }
    g = w.done();
    expect(g.tiles).not.toBe(null);
    const keep = Uint8Array.from({ length: n }, () => (rnd() < 0.8 ? 1 : 0));
    const want = fold(values, keep);
    expect(g.reduce(keep, 'sum')).toBe(want.sum);
    expect(g.reduce(keep, 'count')).toBe(want.count);
    expect(g.reduce(keep, 'min')).toBe(want.min);
    expect(g.reduce(keep, 'max')).toBe(want.max);
    // The same answer from the joined grid.
    g.flat();
    expect(g.reduce(keep, 'sum')).toBe(want.sum);
    // Nothing kept: a sum of 0, no least.
    expect(g.reduce(new Uint8Array(n), 'sum')).toBe(0);
    expect(g.reduce(new Uint8Array(n), 'min')).toBe(Infinity);
  });
});

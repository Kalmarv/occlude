/**
 * The persistent column (column.ts): a write shares every leaf it does not
 * touch, and a flat is joined once per column value.
 */

import { describe, expect, it } from 'vitest';
import { Column, LEAF, kinds } from '../src/column.js';

const range = (n: number, at = 0) => Float64Array.from({ length: n }, (_, i) => i + at);

describe('a persistent column', () => {
  it('adopts an array as its flat, and the same array is the same column', () => {
    const a = range(3 * LEAF + 5);
    const c = Column.of(a);
    expect(c.flat()).toBe(a);
    expect(Column.of(a)).toBe(c);
    expect(c.length).toBe(a.length);
    // Its leaves are views of the flat: nothing is copied.
    const leaves = c.leaves();
    expect(leaves.length).toBe(4);
    expect(leaves[0].buffer).toBe(a.buffer);
    expect(leaves[3].length).toBe(5);
    expect(c.get(2 * LEAF + 7)).toBe(2 * LEAF + 7);
  });

  it('an append shares every whole leaf and copies the last one', () => {
    const c = Column.of(range(2 * LEAF + 10));
    const d = c.append([-1, -2]);
    expect(d.length).toBe(2 * LEAF + 12);
    expect(d.leaves()[0]).toBe(c.leaves()[0]);
    expect(d.leaves()[1]).toBe(c.leaves()[1]);
    expect(d.leaves()[2]).not.toBe(c.leaves()[2]);
    expect(d.get(2 * LEAF + 9)).toBe(2 * LEAF + 9);
    expect(d.get(2 * LEAF + 11)).toBe(-2);
    expect(c.length).toBe(2 * LEAF + 10);
    // Joined once, and then kept.
    const f = d.flat();
    expect(d.flat()).toBe(f);
    expect(Array.from(f.slice(-3))).toEqual([2 * LEAF + 9, -1, -2]);
    expect(Column.of(f)).toBe(d);
  });

  it('a row selection shares the leaves in front of the first row that moves', () => {
    const c = Column.of(range(4 * LEAF));
    const rows = Array.from({ length: 4 * LEAF }, (_, i) => i).filter((i) => i !== 2 * LEAF + 3);
    const d = c.keep(rows);
    expect(d.length).toBe(4 * LEAF - 1);
    expect(d.leaves()[0]).toBe(c.leaves()[0]);
    expect(d.leaves()[1]).toBe(c.leaves()[1]);
    expect(d.get(2 * LEAF + 3)).toBe(2 * LEAF + 4);
    expect(c.keep(Array.from({ length: 4 * LEAF }, (_, i) => i))).toBe(c);
    // Each new leaf is an array of its own: sharing one never keeps the
    // rest of a longer array alive.
    expect(d.leaves()[2].buffer).not.toBe(d.leaves()[3].buffer);
    expect(d.leaves()[2].byteLength).toBe(d.leaves()[2].buffer.byteLength);
    // Two values a row: an edge list.
    const list = Column.of(Uint32Array.from([0, 1, 1, 2, 2, 3]));
    expect(Array.from(list.keep([0, 2], 2).flat())).toEqual([0, 1, 2, 3]);
  });

  it('a sparse write copies the leaves it touches; a dense one the whole column', () => {
    const c = Column.of(range(8 * LEAF));
    const w = c.writer([5, 3 * LEAF + 1]);
    w.set(5, -5);
    w.set(3 * LEAF + 1, -1);
    const d = w.done();
    const same = d.leaves().filter((leaf, k) => leaf === c.leaves()[k]).length;
    expect(same).toBe(6);
    expect(d.get(5)).toBe(-5);
    expect(c.get(5)).toBe(5);
    expect(d.sameValues(c)).toBe(false);
    // Nothing written is the column itself.
    expect(c.writer('some').done()).toBe(c);
    const all = c.writer('all');
    all.set(0, 9);
    const e = all.done();
    expect(e.flat()[0]).toBe(9);
    expect(c.get(0)).toBe(0);
    expect(Column.of(range(LEAF)).sameValues(Column.of(range(LEAF)))).toBe(true);
  });

  it('a column of plain values keeps the same leaves, cut as copies', () => {
    const flat = Array.from({ length: 2 * LEAF + 3 }, (_, i) => `v${i}`);
    const c = Column.of(flat);
    expect(Column.of(flat)).toBe(c);
    const d = c.append(['x']);
    expect(d.leaves()[0]).toBe(c.leaves()[0]);
    expect(d.get(2 * LEAF + 3)).toBe('x');
    const w = d.writer([1]);
    w.set(1, 'y');
    const e = w.done();
    expect(e.leaves()[1]).toBe(d.leaves()[1]);
    expect(e.get(1)).toBe('y');
    expect(d.get(1)).toBe('v1');
    expect(e.keep([2, 0]).flat()).toEqual(['v2', 'v0']);
  });

  it('a kind fills rows with its default, or with a value it is given', () => {
    expect(Array.from(kinds.number.filled(3, 2).flat())).toEqual([2, 2, 2]);
    expect(kinds.string.filled(2).get(1)).toBe('');
    expect(kinds.string.filled(2, 'a').get(1)).toBe('a');
    expect(kinds.vector(2).filled(2, [1, 2]).get(1)).toEqual([1, 2]);
    expect(kinds.reference.filled(2).get(0)).toBeNull();
  });
});

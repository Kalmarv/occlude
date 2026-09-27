/**
 * Typed columns (column.ts): every kind a geometry column holds is a
 * persistent column with the numeric column's leaf scheme and words.
 */

import { describe, expect, it } from 'vitest';
import { Column, LEAF, kinds, kindOf, type AnyColumn, type Reach } from '../src/column.js';

const rows = (n: number, at = 0) => Array.from({ length: n }, (_, i) => i + at);

/** Any kind of column, loosely typed: one test body runs every kind. */
interface Loose {
  readonly length: number;
  get(i: number): unknown;
  append(values: ArrayLike<unknown>): Loose;
  keep(rows: ArrayLike<number>): Loose;
  gather(rows: ArrayLike<number>): ArrayLike<unknown>;
  flat(): ArrayLike<unknown>;
  writer(reach: Reach): { get(i: number): unknown; set(i: number, v: unknown): void; done(): Loose };
  sameValues(other: Loose): boolean;
}

/** The leaves each kind keeps, whatever it stores them in. */
function leavesOf(loose: Loose): readonly unknown[] {
  const c = loose as unknown as AnyColumn;
  if (c instanceof Column) return c.leaves();
  return 'store' in c ? c.store.leaves() : c.leaves();
}

/** One sample value a row, per kind, and a value no row has. */
const cases = [
  { kind: kinds.number, value: (i: number) => i * 0.5, other: -1 },
  { kind: kinds.boolean, value: (i: number) => i % 3 === 0, other: true },
  { kind: kinds.string, value: (i: number) => `r${i % 7}`, other: 'lava' },
  { kind: kinds.vector(2), value: (i: number) => [i, -i], other: [9, 9] },
  { kind: kinds.vector(3), value: (i: number) => [i, i + 0.5, -i], other: [7, 7, 7] },
  { kind: kinds.reference, value: (i: number) => (i % 5 === 0 ? null : i + 1), other: 12345 },
  { kind: kinds.placement, value: (i: number) => (i % 4 === 0 ? null : { at: i }), other: { at: -1 } },
] as const;

describe('every kind of column', () => {
  for (const { kind, value, other } of cases) {
    const name = kind.name === 'vector' ? `vector(${kind.width})` : kind.name;
    const k = kind as unknown as {
      name: string;
      width: number;
      default: unknown;
      interpolates: boolean;
      equal(a: unknown, b: unknown): boolean;
      from(values: ArrayLike<unknown>): Loose;
      filled(n: number): Loose;
      of(flat: unknown): Loose;
    };
    const eq = (a: unknown, b: unknown) => k.equal(a, b);
    const values: unknown[] = rows(3 * LEAF + 17).map((i): unknown => value(i));
    type C = Loose;
    const same = (c: C, want: readonly unknown[]) => {
      expect(c.length).toBe(want.length);
      for (let i = 0; i < want.length; i++) if (!eq(c.get(i), want[i])) throw new Error(`${name}: row ${i}: ${String(c.get(i))} is not ${String(want[i])}`);
    };

    it(`${name}: holds what it is given, and says its kind`, () => {
      const c = k.from(values);
      same(c, values);
      expect(kindOf(c as unknown as AnyColumn)).toBe(kind);
      // The same flat is the same column.
      const f = c.flat();
      expect(c.flat()).toBe(f);
      expect(k.of(f)).toBe(c);
    });

    it(`${name}: an append shares every whole leaf`, () => {
      const c = k.from(values);
      const extra = value(1);
      const d = c.append([other, extra]) as C;
      same(d, [...values, other, extra]);
      same(c, values);
      const [a, b] = [leavesOf(c), leavesOf(d)];
      // Whole leaves of the store: a vector's store is `width` values a row.
      const whole = Math.floor((values.length * k.width) / LEAF);
      for (let i = 0; i < whole; i++) expect(b[i]).toBe(a[i]);
      expect(b[whole]).not.toBe(a[whole]);
      expect(c.append([])).toBe(c);
      // The joined flat is kept.
      const f = d.flat();
      expect(d.flat()).toBe(f);
      expect(f.length).toBe((values.length + 2) * k.width);
    });

    it(`${name}: keep and gather select rows`, () => {
      const c = k.from(values);
      const drop = 2 * LEAF + 3;
      const kept = rows(values.length).filter((i) => i !== drop);
      const d = c.keep(kept) as C;
      same(d, kept.map((i) => values[i]));
      if (k.width === 1) {
        expect(leavesOf(d)[0]).toBe(leavesOf(c)[0]);
        expect(leavesOf(d)[1]).toBe(leavesOf(c)[1]);
      }
      expect(c.keep(rows(values.length))).toBe(c);
      const pick = [5, 0, 3 * LEAF + 16, 5];
      same(k.of(c.gather(pick)) as C, pick.map((i) => values[i]));
      // Reordering from the start moves every leaf.
      same(c.keep([...rows(values.length)].reverse()) as C, [...values].reverse());
    });

    it(`${name}: a sparse write copies only the leaves it touches`, () => {
      const c = k.from(values);
      const at = [4, 3 * LEAF + 1];
      const w = c.writer(at);
      for (const i of at) w.set(i, other);
      expect(eq(w.get(4), other)).toBe(true);
      const d = w.done();
      const want = values.slice();
      for (const i of at) want[i] = other;
      same(d as C, want);
      same(c, values);
      const a = leavesOf(c);
      const b = leavesOf(d);
      const shared = b.filter((leaf, j) => leaf === a[j]).length;
      expect(b.length - shared).toBe(2);
      expect(c.sameValues(d)).toBe(false);
      expect(c.sameValues(k.from(values))).toBe(true);
      // Nothing written is the column itself.
      expect(c.writer('some').done()).toBe(c);
      // A dense write copies it whole.
      const all = c.writer('all');
      all.set(0, other);
      const e = all.done() as C;
      expect(eq(e.get(0), other)).toBe(true);
      expect(eq(c.get(0), values[0])).toBe(true);
    });

    it(`${name}: a new row takes the default; ${kind.interpolates ? 'it interpolates' : 'it never interpolates'}`, () => {
      const c = k.filled(LEAF + 2);
      expect(c.length).toBe(LEAF + 2);
      for (const i of [0, LEAF + 1]) expect(eq(c.get(i), k.default)).toBe(true);
      expect(k.interpolates).toBe(kind.name === 'number' || kind.name === 'vector');
    });
  }
});

describe('the defaults, by kind', () => {
  it('are 0, false, an empty string, the zero vector, no reference, no placement', () => {
    expect(kinds.number.default).toBe(0);
    expect(kinds.boolean.default).toBe(false);
    expect(kinds.string.default).toBe('');
    expect(kinds.vector(3).default).toEqual([0, 0, 0]);
    expect(Object.isFrozen(kinds.vector(3).default)).toBe(true);
    expect(kinds.reference.default).toBeNull();
    expect(kinds.placement.default).toBeNull();
    expect(kinds.vector(3)).toBe(kinds.vector(3));
    expect(() => kinds.vector(0)).toThrow(/whole number/);
  });
});

describe('storage', () => {
  it('a boolean is a Uint8 of 1 and 0; a reference an id, or -1 for none', () => {
    const b = kinds.boolean.from([true, false, true]);
    expect(Array.from(b.flat())).toEqual([1, 0, 1]);
    expect(b.flat()).toBeInstanceOf(Uint8Array);
    const r = kinds.reference.from([7, null, 3]);
    expect(Array.from(r.flat())).toEqual([7, -1, 3]);
    expect(r.get(1)).toBeNull();
    expect(kinds.reference.filled(2).get(0)).toBeNull();
  });

  it('a vector of three keeps rows that cross a leaf', () => {
    const n = 3 * LEAF;
    const flat = Float64Array.from({ length: 3 * n }, (_, i) => i);
    const v = kinds.vector(3).of(flat);
    expect(v.length).toBe(n);
    expect(v.component(LEAF, 2)).toBe(3 * LEAF + 2);
    // Drop one row late, so leaves in front are shared and one row crosses
    // the first new leaf's start.
    const kept = rows(n).filter((i) => i !== 2 * LEAF + 1);
    const d = v.keep(kept);
    expect(d.store.leaves()[0]).toBe(v.store.leaves()[0]);
    for (let r = 0; r < kept.length; r++) {
      const want = kept[r] * 3;
      for (let s = 0; s < 3; s++) if (d.component(r, s) !== want + s) throw new Error(`row ${r}.${s}`);
    }
    expect(() => kinds.vector(3).of(new Float64Array(4))).toThrow(/multiple of 3/);
    expect(() => v.writer([0]).set(0, [1, 2])).toThrow(/3 numbers/);
  });

  it('a placement is kept, not read: the same value comes back', () => {
    const p = { m: [1, 0, 0, 1, 0, 0] };
    const c = kinds.placement.from([p, null]);
    expect(c.get(0)).toBe(p);
    expect(c.keep([1, 0]).get(1)).toBe(p);
    // Equal by identity only.
    expect(c.sameValues(kinds.placement.from([{ m: [1, 0, 0, 1, 0, 0] }, null]))).toBe(false);
    expect(c.sameValues(kinds.placement.from([p, null]))).toBe(true);
  });

  it('a string column made from a flat cuts its leaves on first need', () => {
    const flat = rows(2 * LEAF + 1).map((i) => `s${i}`);
    const c = kinds.string.of(flat);
    expect(c.flat()).toBe(flat);
    expect(c.leaves().length).toBe(3);
    expect(c.leaves()[2]).toEqual(['s' + 2 * LEAF]);
  });
});

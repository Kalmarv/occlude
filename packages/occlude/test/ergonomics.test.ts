import { describe, expect, it } from 'vitest';
import { material, curve, append, add, sub, unit, perp, dot, cross, fromAngle, angleOf } from '../src/index.js';

describe('vector vocabulary: dot, cross, fromAngle, angleOf', () => {
  it('cross is the signed area: positive toward perp(a), zero when parallel or zero', () => {
    expect(cross([1, 0], [0, 1])).toBe(1); // +y is a quarter turn from +x: the side perp([1, 0]) = [0, 1] points to
    expect(cross([1, 0], [0, -1])).toBe(-1);
    expect(cross([2, 0], [3, 0])).toBe(0);
    expect(cross([0, 0], [3, 4])).toBe(0);
    expect(cross({ x: 1, y: 2 }, [3, 4])).toBe(1 * 4 - 2 * 3);
    // the side test agrees with perp: a point on the perp side has positive cross
    const heading = fromAngle(-0.5);
    const left = perp(heading);
    expect(Math.sign(cross(heading, left))).toBe(1);
    expect(Math.sign(cross(heading, sub([0, 0], left)))).toBe(-1);
  });
  it('dot is zero on perpendiculars and on the zero vector', () => {
    expect(dot([1, 0], [0, 1])).toBe(0);
    expect(dot([2, 3], [4, 5])).toBe(23);
    expect(dot([0, 0], [4, 5])).toBe(0);
    expect(dot({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(2);
  });
  it('fromAngle and angleOf are inverses in radians; the zero vector has angle 0', () => {
    expect(fromAngle(0)).toEqual([1, 0]);
    const v = fromAngle(Math.PI / 2);
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v[1]).toBeCloseTo(1, 12);
    for (const a of [-3, -1.2, 0, 0.7, 2.5]) expect(angleOf(fromAngle(a))).toBeCloseTo(a, 12);
    expect(angleOf([0, 0])).toBe(0);
    expect(angleOf([-1, 0])).toBeCloseTo(Math.PI, 12);
    expect(angleOf({ x: 0, y: -2 })).toBeCloseTo(-Math.PI / 2, 12);
    // a fresh tuple every time
    const a = fromAngle(1);
    const b = fromAngle(1);
    expect(a).not.toBe(b);
    expect(unit(add(a, b))).toEqual(unit(fromAngle(1)).map((x) => x) as [number, number]);
  });
});

describe('extrude: the child names its columns', () => {
  const seed = () => material([[0, 0]], { active: 1, heading: -1.5, depth: 3 });
  it('a child that starts from its parent takes the parent\'s columns by name; every declared column is still required', () => {
    const m = seed();
    const p = m.points.at(0);
    const grown = m.extrude(p, [0, -4], { active: p.active, depth: p.depth, heading: p.heading + 0.2 });
    expect(grown.n).toBe(2);
    expect(grown.attrs.active[1]).toBe(1);
    expect(grown.attrs.depth[1]).toBe(3);
    expect(grown.attrs.heading[1]).toBeCloseTo(-1.3, 12);
    expect(grown.attrs.heading[0]).toBeCloseTo(-1.5, 12); // the parent is untouched
    expect(() => m.extrude(p, [0, -4], { heading: 0 })).toThrow(/must give 'active'/);
    // a column that is not finite skips the child and its join
    const nan = m.extrude(p, [0, -4], { active: 1, depth: 3, heading: NaN });
    expect(nan.n).toBe(1);
    expect(nan.edgeCount).toBe(0);
  });
  it('a join to an existing vertex leaves that vertex as it was', () => {
    const two = material([[0, 0], [10, 0]], { active: [1, 0], heading: [0, 2], depth: [0, 9] });
    const joined = two.edges.add([two.points.at(0), two.points.at(1)]);
    expect(joined.n).toBe(2);
    expect(joined.edgeCount).toBe(1);
    expect(Array.from(joined.attrs.heading)).toEqual([0, 2]);
    expect(Array.from(joined.attrs.depth)).toEqual([0, 9]);
    expect(Array.from(joined.attrs.active)).toEqual([1, 0]);
  });
});

describe('the record form of set', () => {
  it('every function reads the original state; the one-column form is the record with one key', () => {
    const m = material([[0, 0], [10, 0], [20, 0]], { a: [1, 2, 3] });
    const both = m.points.set({ a: () => 5, b: (p) => p.a * 10, c: (p) => p.x });
    expect(Array.from(both.attrs.a)).toEqual([5, 5, 5]);
    expect(Array.from(both.attrs.b)).toEqual([10, 20, 30]); // the old a, not the new
    expect(Array.from(both.attrs.c)).toEqual([0, 10, 20]);
    expect(Array.from(m.attrs.a)).toEqual([1, 2, 3]); // the source is untouched
    const one = m.points.set('b', (p) => p.a * 10);
    expect(Array.from(one.attrs.b)).toEqual(Array.from(m.points.set({ b: (p) => p.a * 10 }).attrs.b));
  });
  it('a transfer policy is declared by the write that names the column, and kept on update', () => {
    const m = curve([[0, 0], [10, 0]], { closed: false, age: [0, 10], kind: [1, 2] });
    const declared = m.points.set('kind', (p) => p.kind, { transfer: 'nearest' });
    expect(declared.transfers).toEqual({ kind: 'nearest' });
    const split = declared.split(declared.edges, 0.25);
    const inserted = split.points.filter((p) => p.x === 2.5).at(0);
    expect(inserted.age).toBeCloseTo(2.5, 12); // interpolated
    expect([1, 2]).toContain(inserted.kind); // nearest: one end's value, never a mean
    const updated = declared.points.set({ kind: 7 });
    expect(updated.transfers.kind).toBe('nearest');
    const reset = declared.points.set({ kind: 7 }, { transfer: 'interpolate' });
    expect(reset.transfers.kind).toBeUndefined();
    // The record form declares one policy for every column it names.
    const both = m.points.set({ age: 1, kind: 2 }, { transfer: 'nearest' });
    expect(both.transfers).toEqual({ age: 'nearest', kind: 'nearest' });
  });
  it('the record form over edges reads the same edges and keeps policies', () => {
    const m = curve([[0, 0], [10, 0], [10, 10]], { closed: false }).edges.set('rest', (e) => e.length);
    const both = m.edges.set({ rest: () => 1, half: (e) => e.rest / 2, long: (e) => (e.length > 5 ? 1 : 0) }).edges.set('half', (e) => e.half, { transfer: 'distribute' });
    expect(Array.from(both.edgeAttrs.rest)).toEqual([1, 1]);
    expect(Array.from(both.edgeAttrs.half)).toEqual([5, 5]); // from the old rest
    expect(Array.from(both.edgeAttrs.long)).toEqual([1, 1]);
    expect(both.edgeTransfers.half).toBe('distribute');
    expect(both.edgeTransfers.rest).toBeUndefined();
  });
});

describe('append with missing columns', () => {
  const a = material([[0, 0], [1, 0]], { active: [1, 1], heading: [0.5, 0.5] });
  const b = material([[5, 0], [6, 0]]);
  it('refuses a missing column without a fill, and fills only the side that lacks it', () => {
    expect(() => append(a, b)).toThrow(/no 'active'.*fill/);
    const joined = append(a, b, { fill: { active: 0, heading: 0 } });
    expect(Array.from(joined.attrs.active)).toEqual([1, 1, 0, 0]);
    expect(Array.from(joined.attrs.heading)).toEqual([0.5, 0.5, 0, 0]);
    const other = append(b, a, { fill: { active: 0, heading: 0 } });
    expect(Array.from(other.attrs.active)).toEqual([0, 0, 1, 1]);
    // a fill never overrides values a side already has
    const c = material([[9, 9]], { active: 4, heading: 4 });
    expect(Array.from(append(a, c, { fill: { active: 0, heading: 0 } }).attrs.active)).toEqual([1, 1, 4]);
  });
  it('a filled column keeps the declaring side\'s policy; a column both declare must agree', () => {
    const kinded = material([[0, 0]], { kind: 1 }).points.set('kind', 1, { transfer: 'nearest' });
    const plain = material([[3, 0]]);
    expect(append(kinded, plain, { fill: { kind: 0 } }).transfers.kind).toBe('nearest');
    expect(append(plain, kinded, { fill: { kind: 0 } }).transfers.kind).toBe('nearest');
    const interpolating = material([[3, 0]], { kind: 2 });
    expect(() => append(kinded, interpolating)).toThrow(/transfer 'nearest' on one side and 'interpolate'/);
  });
  it('edge columns follow the same rule through edgeFill', () => {
    const chain = curve([[0, 0], [10, 0]], { closed: false }).edges.set('rest', 10, { transfer: 'distribute' });
    const bare = curve([[20, 0], [30, 0]], { closed: false });
    expect(() => append(chain, bare)).toThrow(/edge column 'rest'.*edgeFill/);
    const joined = append(chain, bare, { edgeFill: { rest: 5 } });
    expect(Array.from(joined.edgeAttrs.rest)).toEqual([10, 5]);
    expect(joined.edgeTransfers.rest).toBe('distribute');
  });
});

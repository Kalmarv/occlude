/**
 * Edits as values: the contract in small. The batch is a list of records
 * (`next.edits`), a pass that returns a list replaces it, and `steps` folds
 * the list: the call judges the program and throws; the fold judges the
 * data, drops what cannot land, and the result says so (`m.dropped`).
 */

import { describe, expect, it } from 'vitest';
import { curve, material, type Material, type Edit, type PointId, type AddPointEdit } from '../src/material.js';
import { plane, pointCloud, curve as curve3 } from '../src/three/api/index.js';

const ring = (count = 8) => curve(Array.from({ length: count }, (_, i) => [50 + 20 * Math.cos((2 * Math.PI * i) / count), 50 + 20 * Math.sin((2 * Math.PI * i) / count)] as [number, number]), { closed: true, age: 0 });
const reasons = (m: Material) => m.dropped.map((d) => [d.edit.op, d.reason]);

describe('the batch is a list of records', () => {
  it('every call appends frozen records; compound verbs are spellings of the primitives', () => {
    let seen: readonly Edit[] = [];
    ring(4).steps(1, (cur, next) => {
      next.extrude(cur.points.at(0), (p) => ({ position: [p.x + 1, p.y], attributes: { age: 1 } }));
      next.splitEdges(cur.edges.filter((e) => e.index < 2));
      next.move(cur.points.filter((p) => p.index < 2), [1, 0]);
      seen = next.edits;
    });
    expect(seen.map((e) => e.op)).toEqual(['addPoint', 'connect', 'split', 'split', 'move', 'move']);
    expect(seen.every((e) => Object.isFrozen(e))).toBe(true);
    // The join `extrude` makes names the new point by its own record.
    expect((seen[1] as { b: unknown }).b).toBe(seen[0]);
    // A selection's records name their points by id.
    expect(typeof (seen[4] as { point: unknown }).point).toBe('number');
  });

  it('a pass that returns a list replaces the batch; one that returns nothing leaves it', () => {
    const m = ring(4);
    const none = m.steps(1, (cur, next) => { next.move(cur.points, [5, 0]); return []; });
    expect(Array.from(none.x)).toEqual(Array.from(m.x));
    const half = m.steps(1, (cur, next) => { next.move(cur.points, [5, 0]); return next.edits.slice(0, 2); });
    expect(half.x[0]).toBe(m.x[0] + 5);
    expect(half.x[2]).toBe(m.x[2]);
    // In the array form, a stage reads the rule's records and rewrites them.
    const doubled = m.steps(1, [(cur, next) => next.move(cur.points, [1, 0]), (_cur, next) => next.edits.map((e) => (e.op === 'move' ? { ...e, by: [2, 0] } : e))]);
    expect(doubled.x[0]).toBe(m.x[0] + 2);
  });

  it('a list held outside lands as one batch', () => {
    const m = ring(4);
    let held: readonly Edit[] = [];
    m.steps(1, (cur, next) => {
      const hub = next.addPoint([50, 50], { age: 9 });
      for (const p of cur.points) next.connect(p, hub);
      held = next.edits;
    });
    const a = m.steps(1, () => held);
    const b = m.steps(1, () => held);
    expect(a.n).toBe(5);
    expect(a.edgeCount).toBe(8);
    expect(b.n).toBe(5);
    expect(a.dropped).toEqual([]);
  });

  it('bare numbers are ids, never rows', () => {
    const m = ring(5);
    // 3 is not the id of any point here, whatever row 3 is.
    expect(m.rowOfPoint(3 as PointId)).toBe(-1);
    const moved = m.steps(1, (_cur, next) => next.move(3 as PointId, [1, 0]));
    expect(Array.from(moved.x)).toEqual(Array.from(m.x));
    expect(reasons(moved)).toEqual([['move', 'gone']]);
    // An id is the point wherever its row went.
    const id = m.points.at(3).id;
    const later = m.steps(1, (cur, next) => next.remove(cur.points.at(0))).steps(1, (_cur, next) => next.move(id, [1, 0]));
    expect(later.pointOf(id)!.x).toBe(m.points.at(3).x + 1);
  });

  it('dropped lives on the result of the steps call alone', () => {
    const m = ring(4);
    const out = m.steps(3, (cur, next, k) => next.connect(cur.points.at(0), cur.points.at(1), {}), { every: 1 });
    expect(out.dropped.map((d) => [d.reason, d.k])).toEqual([['already', 0], ['already', 1], ['already', 2]]);
    expect(out.history.every((h) => h.dropped.length === 0)).toBe(true);
    expect(out.attribute('more', 1).dropped).toEqual([]);
    expect(Object.keys(out)).not.toContain('dropped');
    expect(m.steps(0, () => {}).dropped).toEqual([]);
  });

  it('a split conflict: two cuts at one place that disagree take what they inherit, and both say so', () => {
    const line = curve([[0, 0], [10, 0]], { closed: false, age: [0, 10] });
    const out = line.steps(1, (cur, next) => {
      next.split(cur.edge(0), { at: 0.5, point: { age: 1 } });
      next.split(cur.edge(0), { at: 0.5, point: { age: 2 } });
      next.split(cur.edge(0), { at: 0.25 });
    });
    expect(Array.from(out.attrs.age)).toEqual([0, 2.5, 5, 10]);
    expect(reasons(out)).toEqual([['split', 'conflict'], ['split', 'conflict']]);
  });
});

describe('the call judges the program: throws kept, by name', () => {
  const m = ring(4);
  it('an unknown column', () => {
    expect(() => m.steps(1, (cur, next) => next.set(cur.points, { nope: 1 }))).toThrow(/no attribute 'nope'/);
    expect(() => m.steps(1, () => [{ op: 'set', point: m.points.at(0), attrs: { nope: 1 } }])).toThrow(/no attribute 'nope'/);
  });
  it('an unknown op', () => {
    expect(() => m.steps(1, () => [{ op: 'teleport' } as unknown as Edit])).toThrow(/unknown edit op 'teleport' \(index 0\)/);
  });
  it('the wrong kind of reference', () => {
    expect(() => m.steps(1, (cur, next) => next.move(cur.edge(0) as never, [1, 0]))).toThrow(/needs a point, not an edge/);
    expect(() => m.steps(1, (cur, next) => next.disconnect(cur.points.at(0) as never))).toThrow(/needs an edge/);
    expect(() => m.steps(1, (cur) => [{ op: 'remove', point: cur.edge(0) as never }])).toThrow(/needs a point, not an edge/);
  });
  it('a selection of an unrelated material', () => {
    expect(() => m.steps(1, (_cur, next) => next.move(ring(4).points, [1, 0]))).toThrow(/another material/);
  });
  it('a motif that is not one open chain', () => {
    expect(() => m.steps(1, (cur, next) => next.replace(cur.edges, ring(3)))).toThrow(/open chain/);
  });
  it('a new point that does not name every column', () => {
    expect(() => m.steps(1, (_cur, next) => next.addPoint([0, 0], {}))).toThrow(/must give 'age'/);
    expect(() => m.steps(1, () => [{ op: 'addPoint', position: [0, 0], attrs: {} }])).toThrow(/must give 'age'/);
  });
  it('a returned list that holds something that is not a record', () => {
    expect(() => m.steps(1, () => [42 as unknown as Edit])).toThrow(/not an edit record \(index 0\)/);
    expect(() => m.steps(1, [(cur, next) => next.move(cur.points, [1, 0]), () => [undefined as unknown as Edit]])).toThrow(/not an edit record/);
  });
  it('a split at that is not a number at all (a NaN one is data)', () => {
    expect(() => m.steps(1, (cur, next) => next.split(cur.edge(0), { at: '0.5' as never }))).toThrow(/at is a number/);
    expect(reasons(m.steps(1, (cur, next) => next.split(cur.edge(0), { at: NaN })))).toEqual([['split', 'not-finite']]);
  });
});

describe('a mesh step speaks the same words', () => {
  const sheet = () => plane(2, 2).attributes({ age: () => 0 }).edgeAttributes({ w: () => 0 });

  it('next.edits, a returned list, and dropped', () => {
    let seen: readonly unknown[] = [];
    const out = sheet().steps(1, (cur, next) => {
      next.move(cur.points, [0, 0, 1]);
      next.set(cur.points.at(0)!, { age: 2 });
      seen = next.edits;
      return [...next.edits, { op: 'set', point: 'no such point', attrs: { age: 1 } }, { op: 'move', point: cur.points.at(1)!.id, by: [0, 0, NaN] }];
    });
    expect(seen.map((e) => (e as { op: string }).op)).toEqual(['move', 'move', 'move', 'move', 'set']);
    expect(out.points.every((p) => p.z === 1)).toBe(true);
    expect(out.points.at(0)!.age).toBe(2);
    expect(out.dropped.map((d) => [d.edit.op, d.reason])).toEqual([['set', 'gone'], ['move', 'not-finite']]);
    expect(out.translate([1, 0, 0]).dropped).toEqual([]);
  });

  it('a topology record is a wrong program there, by name', () => {
    for (const op of ['connect', 'remove', 'split', 'addPoint', 'disconnect']) {
      expect(() => sheet().steps(1, () => [{ op } as never])).toThrow(new RegExp(`no topology edits \\('${op}'\\)`));
    }
    expect(() => sheet().steps(1, () => [{ op: 'twist' } as never])).toThrow(/unknown edit op 'twist'/);
  });

  it('point and curve geometry carry edits and dropped too', () => {
    const cloud = pointCloud([[0, 0, 0], [1, 0, 0]]).attributes({ age: 0 });
    const moved = cloud.steps(1, (cur, next) => [...next.edits, { op: 'move', point: cur.points.at(0)!, by: [0, 1, 0] }, { op: 'set', point: 'gone', attrs: { age: 1 } }]);
    expect(moved.points.at(0)!.y).toBe(1);
    expect(moved.dropped.map((d) => d.reason)).toEqual(['gone']);
    const wire = curve3([[0, 0, 0], [1, 0, 0]]).attributes({ age: () => 0 });
    const lifted = wire.steps(1, (cur, next) => { next.move(cur.points, [0, 0, 1]); return next.edits; });
    expect(lifted.points.map((p) => p.z)).toEqual([1, 1]);
    expect(lifted.dropped).toEqual([]);
  });
});

describe('a record names a new point', () => {
  it('a join to a new point whose record the stage dropped is gone', () => {
    const m = material([[0, 0]], { age: 0 });
    const out = m.steps(1, [(cur, next) => {
      const tip = next.addPoint([1, 0], { age: 1 });
      next.connect(cur.points.at(0), tip);
    }, (_cur, next) => next.edits.filter((e) => e.op !== 'addPoint')]);
    expect(out.n).toBe(1);
    expect(reasons(out)).toEqual([['connect', 'gone']]);
  });
  it('listed twice, a new point lands once', () => {
    let tip: AddPointEdit | undefined;
    const out = material([[0, 0]], { age: 0 }).steps(1, (cur, next) => { tip = next.addPoint([1, 0], { age: 1 }); return [tip, tip, { op: 'connect', a: cur.points.at(0), b: tip }]; });
    expect(out.n).toBe(2);
    expect(out.edgeCount).toBe(1);
    expect(reasons(out)).toEqual([['addPoint', 'already']]);
  });
  it('a move on a new point moves it where it was made', () => {
    const out = material([[0, 0]], { age: 0 }).steps(1, (_cur, next) => { const tip = next.addPoint([1, 0], { age: 1 }); next.move(tip, [0, 2]); next.set(tip, { age: 5 }); });
    expect(out.pts[1]).toEqual([1, 2]);
    expect(out.attrs.age[1]).toBe(5);
  });
});

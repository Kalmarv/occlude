import { describe, expect, it } from 'vitest';
import { append, connect, curve, distanceTo, force, material, mm, polygon, strokes, type Material } from '../src/index.js';

/** A Y: 0–1–2 trunk with branches 1–3 and 1–4, plus a loner 5. */
const Y = (): Material =>
  material([[0, 0], [10, 0], [20, 0], [10, 10], [10, -10], [50, 50]], { edges: [[0, 1], [1, 2], [1, 3], [1, 4]], age: [0, 1, 2, 3, 4, 5] })
    .edgeAttribute('level', (e) => (e.index < 2 ? 1 : 2));

describe('geometry collections: points and edges', () => {
  it('iterate, length, at, map to an array, find; filter keeps source order and filters again', () => {
    const m = Y();
    expect(m.points.length).toBe(6);
    expect(m.edges.length).toBe(4);
    expect(m.points.at(3).age).toBe(3);
    expect(() => m.points.at(6)).toThrow(/no member 6/);
    expect([...m.points].map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
    const ages = m.points.map((p) => p.age);
    expect(Array.isArray(ages)).toBe(true);
    expect(ages).toEqual([0, 1, 2, 3, 4, 5]);
    expect(m.points.find((p) => p.age > 3)?.index).toBe(4);
    const old = m.points.filter((p) => p.age >= 2);
    expect(old.indices).toEqual([2, 3, 4, 5]);
    expect(old.length).toBe(4);
    expect(old.source).toBe(m);
    const older = old.filter((p) => p.age >= 4);
    expect(older.indices).toEqual([4, 5]);
    expect(older.map((p) => p.age)).toEqual([4, 5]);
    expect([...older].map((p) => p.index)).toEqual([4, 5]);
    // Views are the source's own: ownership and spellings survive.
    expect(old.has(m.vertex(3))).toBe(true);
    expect(old.has(Y().vertex(3))).toBe(false);
    expect(m.edges.filter((e) => e.attrs.level === 2).indices).toEqual([2, 3]);
    expect(m.edges.at(1).b.index).toBe(2);
    // Nothing moved or copied.
    expect(m.x[3]).toBe(10);
    expect(m.edgeCount).toBe(4);
  });

  it('a classifier runs once per member and no full view array is built to filter', () => {
    const m = Y();
    let calls = 0;
    m.points.filter((p) => (calls++, p.age > 2));
    expect(calls).toBe(6);
    calls = 0;
    m.points.filter((p) => p.age > 2).groupBy((p) => (calls++, p.age % 2));
    expect(calls).toBe(3);
  });

  it('edits scope by selection and refuse a selection of another state', () => {
    const m = Y();
    const stale = m.points.filter((p) => p.age >= 3);
    const moved = m.steps(1, (cur, next) => {
      const tips = cur.points.filter((p) => cur.degree(p) === 1 && p.age > 0);
      next.move(() => [0, 1], { where: tips });
      next.set(() => ({ age: 9 }), { where: tips });
    });
    expect(moved.y[2]).toBe(1);
    expect(moved.attrs.age[3]).toBe(9);
    expect(moved.y[0]).toBe(0); // degree 1 but age 0
    expect(() => moved.steps(1, (cur, next) => next.move(() => [1, 0], { where: stale }))).toThrow(/another state|different state/);
  });
});

describe('selections as boundaries', () => {
  it('a ring picked out of a branching network is an area; a branching subset is not', () => {
    // A square ring with a spur off one corner.
    const net = curve([[0, 0], [10, 0], [10, 10], [0, 10]]).steps(1, (cur, next) => {
      const spur = next.addPoint([20, 20], {});
      next.connect(2, spur);
    });
    expect(() => distanceTo(net)).toThrow(/branches/);
    const ring = net.edges.filter((e) => e.index < 4);
    expect(distanceTo(ring)(5, 5)).toBeCloseTo(5, 9);
    expect(polygon(ring).geom).toEqual(polygon([[[0, 0], [10, 0], [10, 10], [0, 10]]]).geom);
    expect(force.boundary(ring, { radius: 4 })([1, 5])[0]).toBeGreaterThan(0);
    expect(strokes(ring)).toHaveLength(1);
    // A subset that still branches is refused, naming the way out.
    const withSpur = net.edges.filter((e) => e.index !== 3);
    expect(() => polygon(withSpur)).toThrow(/selection branches.*edges\.filter/);
    expect(strokes(withSpur)).toHaveLength(3); // drawing never needs an inside: three arms at the junction
  });

  it('equivalent material, selection and contour inputs agree; open chains chord-close; empties stay empty', () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const m = curve(square);
    const all = m.edges.filter(() => true);
    for (const [x, y] of [[5, 5], [12, 5], [0, 0]]) {
      expect(distanceTo(all)(x, y)).toBe(distanceTo(m)(x, y));
      expect(distanceTo(all)(x, y)).toBe(distanceTo({ pts: square, closed: true })(x, y));
    }
    const chain = connect.chain(material([[0, 0], [10, 0], [10, 10]]));
    expect(distanceTo(chain.edges)(3, 1)).toBe(distanceTo([[[0, 0], [10, 0], [10, 10]]])(3, 1));
    expect(distanceTo(m.edges.filter(() => false))(1, 1)).toBe(-Infinity);
    // Points follow their existing connectivity: two selected corners without their edge are no area.
    expect(distanceTo(m.points.filter((p) => p.index === 0 || p.index === 2))(5, 5)).toBe(-Infinity);
    expect(distanceTo(m.points)(5, 5)).toBe(5);
  });

  it('faces stay explicit per face', () => {
    const cells = append(curve([[0, 0], [10, 0], [10, 10], [0, 10]]), curve([[20, 0], [30, 0], [30, 10], [20, 10]])).faces();
    // A selection is several areas at once: it must say which one.
    // Deliberately the wrong input (a selection is several areas): the
    // refusal is the contract.
    expect(() => polygon(cells.filter(() => true) as never)).toThrow(/several areas .*boundaries\(\)/);
    // A single face IS an area: no `.contours` unwrapping at the call site.
    expect(cells.filter((f) => f.area > 1).map((f) => polygon(f))).toHaveLength(2);
    expect(cells.length).toBe(2);
    expect(cells.at(1).area).toBe(100);
    expect([...cells].length).toBe(2);
  });
});

describe('groupBy', () => {
  it('groups in first-occurrence order with rows in source order, Map key equality, keys inferred', () => {
    const m = material([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], { edges: [[0, 1], [2, 3], [4, 5]], kind: [2, 1, 2, 1, 3, 3] });
    const groups = m.points.groupBy((p) => p.kind);
    expect(groups.map((g) => g.key)).toEqual([2, 1, 3]);
    expect(groups.map((g) => g.indices)).toEqual([[0, 2], [1, 3], [4, 5]]);
    const two: number = groups[0].key; // inferred number
    expect(two).toBe(2);
    // Disconnected members share a group; each group is a usable selection.
    expect(groups[0].map((p) => p.x)).toEqual([0, 2]);
    expect(groups[0].filter((p) => p.x > 0).key).toBe(2);
    expect(groups[0].filter((p) => p.x > 0).indices).toEqual([2]);
    expect(groups[0].has(m.vertex(2))).toBe(true);
    expect(groups[0].source).toBe(m);
    // Strings and objects group by identity, not by stringification.
    const a = { name: 'a' };
    const byObject = m.points.groupBy((p) => (p.kind === 3 ? a : { name: 'a' }));
    expect(byObject.map((g) => g.length)).toEqual([1, 1, 1, 1, 2]);
    expect(byObject[4].key).toBe(a);
    const byNaN = m.points.groupBy((p) => (p.kind === 3 ? NaN : p.kind));
    expect(byNaN.map((g) => g.length)).toEqual([2, 2, 2]);
    // Only the collection's members are grouped.
    expect(m.points.filter((p) => p.kind !== 2).groupBy((p) => p.kind).map((g) => g.key)).toEqual([1, 3]);
    // Empty input, empty result.
    expect(m.points.filter(() => false).groupBy((p) => p.kind)).toEqual([]);
    // Nothing written to the geometry.
    expect(m.attrNames).toEqual(['kind']);
    expect(m.edgeCount).toBe(3);
  });

  it('edge groups are boundaries and draw directly; face groups keep their faces', () => {
    const two = append(curve([[0, 0], [10, 0], [10, 10], [0, 10]]), curve([[20, 0], [30, 0], [30, 10], [20, 10]]))
      .edgeAttribute('level', (e) => (e.index < 4 ? 0.2 : 0.4));
    const levels = two.edges.groupBy((e) => e.attrs.level);
    expect(levels.map((g) => g.key)).toEqual([0.2, 0.4]);
    expect(distanceTo(levels[1])(25, 5)).toBe(5);
    expect(distanceTo(levels[0])(25, 5)).toBe(-15);
    expect(levels.map((g) => polygon(g, { winding: 'nonzero' }))).toHaveLength(2);
    expect(strokes(levels[0])).toHaveLength(1);
    const cells = two.faces().groupBy((f) => Math.floor(f.area / 1000));
    expect(cells).toHaveLength(1);
    expect(cells[0].key).toBe(0);
    expect(cells[0].length).toBe(2);
    expect(cells[0].filter((f) => f.index === 1).key).toBe(0);
  });

  it('extraction is still the explicit step to independent material', () => {
    const m = Y();
    const branch = m.edges.filter((e) => e.attrs.level === 2);
    const independent = branch.extract();
    expect(independent.n).toBe(3);
    expect(independent.edgeCount).toBe(2);
    expect(independent.iteration).toBe(0);
    expect(Array.from(independent.edgeAttrs.level)).toEqual([2, 2]);
    expect(branch.points.length).toBe(3);
    expect(m.points.filter((p) => p.age > 4).extract().n).toBe(1);
  });

  it('selections are frozen: key and source cannot be overwritten, the lazy row list still works', () => {
    const m = Y();
    const all = m.points;
    const sel = m.edges.filter((e) => e.index < 2);
    const group = m.points.groupBy((p) => p.age % 2)[0];
    for (const s of [all, sel, group, m.edges]) expect(Object.isFrozen(s)).toBe(true);
    expect(() => { (group as { key: unknown }).key = 'x'; }).toThrow();
    expect(() => { (sel as { source: unknown }).source = Y(); }).toThrow();
    expect(group.key).toBe(0);
    expect(sel.source).toBe(m);
    expect(all.indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(all.indices).toBe(all.indices); // cached once
    expect(m.edges.indices).toEqual([0, 1, 2, 3]);
  });
});

describe('unit-wrapped coordinates', () => {
  it('polygon keeps mm() lengths in single and multiple loops; numeric consumers refuse them', () => {
    const one = polygon([[mm(0), mm(0)], [mm(10), mm(0)], [mm(10), mm(10)]]);
    const cmds = (one.geom as { cmds: { op: string; x?: unknown }[] }).cmds;
    expect(cmds.map((c) => c.op)).toEqual(['move', 'line', 'line', 'close']);
    expect(cmds[1].x).toBeInstanceOf(mm(1).constructor);
    const two = polygon([[[mm(0), mm(0)], [mm(10), mm(0)], [mm(10), mm(10)]], [[mm(2), mm(2)], [mm(4), mm(2)], [4, 4]]]);
    const cmds2 = (two.geom as { cmds: { op: string }[] }).cmds;
    expect(cmds2.filter((c) => c.op === 'close')).toHaveLength(2);
    expect(cmds2).toHaveLength(8);
    expect(() => distanceTo([[[mm(0), mm(0)], [mm(10), mm(0)], [mm(10), mm(10)]]] as never)).toThrow(/coordinates must be numbers.*polygon/);
    expect(() => force.boundary([[[mm(0), mm(0)], [mm(10), mm(0)]]] as never, { radius: 1 })).toThrow(/force.boundary: coordinates must be numbers/);
  });
});

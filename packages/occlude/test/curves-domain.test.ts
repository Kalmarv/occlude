/**
 * The ordered domain: `g.curves`, a selection of curve rows.
 *
 * Order is two stored facts — each edge's direction and the order of the
 * rows — and the curves are the walk over them. These tests pin what a
 * write does to that order, what a curve row answers (its points in walk
 * order with the derived `s`, `u`, `heading`, `tangent` and `normal`, its
 * edges, `closed`, `length`, `contours()`, the edge columns it agrees on),
 * that every value that answered `curves()` answers the property, that
 * `along` answers points, and that `subtract` and `in` are gone from a
 * selection.
 */

import { describe, expect, it } from 'vitest';
import { circle, curve, material, point, rect, space, strokes, stroke, type Material } from '../src/index.js';
import { Selection } from '../src/selection.js';
import { strokeFont } from '../src/strokeFont.js';
import { curve as curve3 } from '../src/three/api/index.js';
import { toolkit } from './helpers/run.js';
import { pts, xy } from './helpers/xy.js';

/** The walk of a value's first curve, as point rows. */
const walk = (m: Material, k = 0): number[] => m.curves.at(k).points.map((p) => p.index);
/** The points of a ring, as a cyclic sequence read from `start`. */
const cyclic = (rows: number[], start: number): number[] => {
  const i = rows.indexOf(start);
  return [...rows.slice(i), ...rows.slice(0, i)];
};
const near = (v: readonly number[], w: readonly number[], places = 12): void => {
  expect(v[0]).toBeCloseTo(w[0], places);
  expect(v[1]).toBeCloseTo(w[1], places);
};

describe('curves is a property of the value', () => {
  it('read on first ask and kept; its rows are kept too', () => {
    const ring = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    expect(ring.curves).toBeInstanceOf(Selection);
    expect(ring.curves).toBe(ring.curves);
    expect(ring.curves.at(0)).toBe(ring.curves.at(0));
    expect(typeof (ring as unknown as { curves: unknown }).curves).not.toBe('function');
    // A selection's curves are the walk of ITS edges, kept on it.
    const some = ring.edges.filter((e) => e.index !== 2);
    expect(some.curves).toBe(some.curves);
    expect(some.curves).toHaveLength(1);
    expect(some.curves.at(0).closed).toBe(false);
  });
});

describe('order: edge direction plus row order, kept by every write', () => {
  const ring = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });

  it('a ring starts at the start of its first edge row and runs that edge\'s way', () => {
    expect(walk(ring())).toEqual([0, 1, 2, 3]);
    // The same four edges stored the other way round walk the other way.
    const back = material([[0, 0], [10, 0], [10, 10], [0, 10]], { edges: [[0, 3], [3, 2], [2, 1], [1, 0]] });
    expect(walk(back)).toEqual([0, 3, 2, 1]);
    // An open chain starts at its first end by row.
    expect(walk(curve([[0, 0], [5, 0], [9, 0]]))).toEqual([0, 1, 2]);
  });

  it('adds go at the end: a new edge row and point keep the old curves in order', () => {
    const m = ring();
    const q1 = point([40, 40]);
    const q2 = point([50, 40]);
    const more = m.points.add([q1, q2]).edges.add([q1, q2]);
    expect(more.curves).toHaveLength(2);
    expect(walk(more, 0)).toEqual([0, 1, 2, 3]);
    expect(walk(more, 1)).toEqual([4, 5]);
  });

  it('a remove keeps the order of the rest', () => {
    const m = curve([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
    const cut = m.edges.remove(m.edges.at(1));
    expect(cut.curves.map((c) => c.points.map((p) => p.x))).toEqual([[0, 1], [2, 3, 4]]);
  });

  it('a split keeps the ring\'s direction and, for any edge but the first row, its start', () => {
    const m = ring();
    const s = m.split(m.edges.at(2));
    expect(s.n).toBe(5);
    expect(walk(s)).toEqual([0, 1, 2, 4, 3]);
    // u does not move where nothing changed: the first two points read the same.
    expect(s.curves.at(0).points.at(1).u).toBeCloseTo(0.25, 12);
    // Splitting every edge: the parent's direction, each child in turn.
    const all = m.split(m.edges);
    expect(cyclic(walk(all), 0)).toEqual([0, 4, 1, 5, 2, 6, 3, 7]);
    // Splitting the ring's FIRST edge row: the direction stays, and the
    // start moves on to the start of the next row.
    const first = m.split(m.edges.at(0));
    expect(walk(first)).toEqual([1, 2, 3, 0, 4]);
  });

  it('a replace keeps the parent\'s direction', () => {
    const m = ring();
    const tooth = curve([[0, 0], [0.5, 0.3], [1, 0]]);
    const r = m.replace(m.edges.at(1), tooth);
    expect(r.n).toBe(5);
    expect(cyclic(walk(r), 0)).toEqual([0, 1, 4, 2, 3]);
  });

  it('an extrude at a tip grows the chain at its end', () => {
    const m = curve([[0, 0], [10, 0], [20, 0]]);
    const g = m.extrude(m.points.at(2), [5, 0]);
    expect(walk(g)).toEqual([0, 1, 2, 3]);
    expect(g.curves.at(0).points.at(3).u).toBe(1);
  });

  it('planarize cuts rings into pieces that keep each parent\'s direction', () => {
    const a = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    const top = point([5, -5]);
    const bottom = point([5, 15]);
    const p = a.edges.set('ring', 1).points.add([top, bottom]).edges.add([top, bottom], { ring: 0 }).planarize();
    // Every piece of a ring edge runs the way its parent ran round the ring.
    const dir = (x: number, y: number): [number, number] => (y === 0 ? [1, 0] : x === 10 ? [0, 1] : y === 10 ? [-1, 0] : [0, -1]);
    for (const e of p.edges) {
      if (e.ring !== 1) continue;
      const [dx, dy] = dir((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2);
      expect((e.b.x - e.a.x) * dx + (e.b.y - e.a.y) * dy).toBeGreaterThan(0);
    }
    // Two junctions where the chord crosses the ring: the ring's two arcs
    // and the chord's three pieces.
    expect(p.curves).toHaveLength(5);
  });
});

describe('a curve row', () => {
  it('answers its points and edges in walk order, closed, length and its area', () => {
    const m = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });
    const c = m.curves.at(0);
    expect(c.index).toBe(0);
    expect(c.closed).toBe(true);
    expect(c.length).toBe(40);
    expect(pts(c)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(c.edges.map((e) => [e.a.index, e.b.index])).toEqual([[0, 1], [1, 2], [2, 3], [3, 0]]);
    expect(c.contours()).toEqual([{ pts: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true }]);
    expect(curve([[0, 0], [3, 4]]).curves.at(0).contours()).toEqual([]);
    expect(curve([[0, 0], [3, 4]]).curves.at(0).length).toBe(5);
  });

  it('derives s, u, heading, tangent and normal on its points — read like columns, never stored', () => {
    const open = curve([[0, 0], [10, 0], [10, 10]], { age: [1, 2, 3] });
    const c = open.curves.at(0);
    expect(c.points.map((p) => p.s)).toEqual([0, 10, 20]);
    expect(c.points.map((p) => p.u)).toEqual([0, 0.5, 1]);
    expect(c.points.map((p) => p.age)).toEqual([1, 2, 3]);
    near(c.points.at(0).tangent, [1, 0]);
    near(c.points.at(1).tangent, [Math.SQRT1_2, Math.SQRT1_2]); // a corner: the bisector
    near(c.points.at(2).tangent, [0, 1]);
    expect(c.points.at(1).heading).toBeCloseTo(Math.PI / 4, 12);
    near(c.points.at(0).normal, [0, 1]); // perp(tangent)
    // The material's own points do not carry them.
    expect(Object.keys(open.attrs)).toEqual(['age']);
    expect(open.points.at(1).s).toBeUndefined();
    expect(open.points.at(1).tangent).toBeUndefined();
    // A filter of a curve's points keeps the walk order and the columns.
    const tail = c.points.filter((p) => p.u > 0.25);
    expect(tail.map((p) => p.u)).toEqual([0.5, 1]);
    // A ring's u runs from 0 at its start and never reaches 1.
    const ring = curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true }).curves.at(0);
    expect(ring.points.map((p) => p.u)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('turns the normal a quarter toward +y: out of a ring drawn counter-clockwise on the sheet', () => {
    // Down the left side, across the bottom, up the right: counter-clockwise
    // as the sheet shows it (y down).
    const ccw = curve([[0, 0], [0, 10], [10, 10], [10, 0]], { closed: true }).curves.at(0);
    for (const p of ccw.points) {
      const out = [p.x - 5, p.y - 5];
      expect(p.normal[0] * out[0] + p.normal[1] * out[1]).toBeGreaterThan(0);
    }
    // A sampled circle walks the other way round, so its normal points in.
    const t = toolkit({ aspect: [1, 1] });
    const disc = t.sample(circle(50, 50, 20), { count: 12 }).curves.at(0);
    for (const p of disc.points) expect(p.normal[0] * (p.x - 50) + p.normal[1] * (p.y - 50)).toBeLessThan(0);
  });

  it('reads the edge columns its edges agree on, and not the ones they do not', () => {
    const t = toolkit({ aspect: [1, 1] });
    const lines = t.isolines((x, y) => Math.hypot(x - 50, y - 50), [10, 20]);
    const levels = lines.curves.map((c) => c.level).sort((a, b) => a - b);
    expect(levels).toEqual([10, 20]);
    const m = curve([[0, 0], [1, 0], [2, 0]]).edges.set('pen', (e) => e.index);
    expect(m.curves.at(0).pen).toBeUndefined();
    expect(m.edges.set('pen', 2).curves.at(0).pen).toBe(2);
    expect(Object.keys(m.edges.set('pen', 2).curves.at(0))).toContain('pen');
  });
});

describe('a curve selection', () => {
  const two = () => material([[0, 0], [10, 0], [20, 0], [0, 5], [10, 5], [10, 15], [0, 15]], { edges: [[0, 1], [1, 2], [3, 4], [4, 5], [5, 6], [6, 3]] });

  it('filters in row order, and answers points, edges, curves and contours', () => {
    const m = two();
    expect(m.curves).toHaveLength(2);
    const rings = m.curves.filter((c) => c.closed);
    expect(rings).toHaveLength(1);
    expect(rings.curves).toBe(rings);
    expect(rings.points.map((p) => p.index)).toEqual([3, 4, 5, 6]);
    expect(rings.edges.map((e) => e.index)).toEqual([2, 3, 4, 5]);
    expect(rings.contours()).toHaveLength(1);
    expect(m.curves.sum('length')).toBe(20 + 40);
    expect(m.curves.max((c) => c.points.length)).toBe(4);
    const x = rings.extract();
    expect(x.n).toBe(4);
    expect(x.curves.at(0).closed).toBe(true);
    // Two curves that meet at an end are neighbours.
    const y = material([[0, 0], [1, 0], [2, 1], [2, -1]], { edges: [[0, 1], [1, 2], [1, 3]] });
    expect(y.curves.filter((c) => c.index === 0).adjacent().length).toBe(2);
  });

  it('refuses the words it has no answer to, by name', () => {
    const m = two();
    expect(() => m.curves.near([0, 0], { radius: 1 })).toThrow(/curves\.near: a curve is not a place/);
    expect(() => (m.curves as unknown as { set(...a: unknown[]): unknown }).set('k', 1)).toThrow(/curves\.set: a curve is derived from the edges/);
    expect(() => (m.curves as unknown as { resample(o: unknown): unknown }).resample({ count: 3 })).toThrow(/sel\.edges\.resample/);
  });

  it('draws: strokes of a selection, of one row, and stroke of one row', () => {
    const m = two();
    expect(strokes(m.curves)).toHaveLength(2);
    expect(strokes(m.curves.filter((c) => c.closed))).toHaveLength(1);
    expect(strokes(m.curves.at(1))).toHaveLength(1);
    expect(stroke(m.curves.at(1)).geom).toEqual(stroke({ pts: [[0, 5], [10, 5], [10, 15], [0, 15]], closed: true } as never).geom);
  });

  it('names a curve of an earlier state by its edges', () => {
    const m = two();
    const ring = m.curves.filter((c) => c.closed);
    const moved = m.points.set('x', (p) => p.x + 1);
    expect(moved.curves.intersect(ring).length).toBe(1);
    expect(moved.curves.has(ring.at(0))).toBe(true);
    // A split retires the edge, so the curve through it is gone.
    expect(m.split(m.edges.at(3)).curves.has(ring.at(0))).toBe(false);
  });
});

describe('every value that answered curves() answers the property', () => {
  it('material, point, edge and face selections, a glyph, a lifted profile', () => {
    const t = toolkit({ aspect: [1, 1] });
    const m = t.material(rect(10, 10, 30, 20));
    const sources: [string, unknown][] = [
      ['material', m],
      ['points', m.points],
      ['edges', m.edges],
      ['faces', m.planarize().faces],
      ['glyph', strokeFont(TINY).glyph('A')!],
    ];
    for (const [name, v] of sources) {
      const cs = (v as { curves: unknown }).curves;
      expect(cs, name).toBeInstanceOf(Selection);
      expect((cs as Selection<unknown>).length, name).toBeGreaterThan(0);
      expect((strokes(v as never) as unknown as unknown[]).length, name).toBe((cs as Selection<unknown>).length);
    }
    // A glyph's curve, in em units, y up.
    expect(pts(strokeFont(TINY).glyph('A')!.curves.at(0))).toEqual([[0, 0], [300, 700], [600, 0]]);
    // The points of one curve row are a chain in space too.
    const c3 = curve3(m.curves.at(0).points);
    expect(c3.points.length).toBe(4);
  });
});

describe('along answers points', () => {
  it('a material of points with s, u, heading and the chain\'s columns; the frame at each point', () => {
    const m = curve([[0, 0], [10, 0], [10, 10]], { age: [0, 10, 20] }).edges.set('pen', 3);
    const a = m.along({ count: 5 });
    expect(a.edges).toHaveLength(0);
    expect(Object.keys(a.attrs).sort()).toEqual(['age', 'heading', 'pen', 's', 'u']);
    expect(a.points.map(xy)).toEqual([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]]);
    const p = a.points.at(1);
    expect([p.s, p.u, p.heading, p.age, p.pen]).toEqual([5, 0.25, 0, 5, 3]);
    const pl = p.placement();
    expect([pl.x, pl.y, pl.heading]).toEqual([5, 0, 0]);
    near([pl.step(2).x, pl.step(2).y], [7, 0]);
    // Points without a heading have no frame.
    expect(() => m.points.at(0).placement()).toThrow(/no heading/);
  });

  it('walks a placement in the space of the points it came from', () => {
    const t = toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) });
    const ring = t.sample(circle(50, 50, 10), { count: 16 });
    const pl = ring.along({ count: 4 }).points.at(0).placement();
    const q = pl.step(3);
    expect(t.space.distance([pl.x, pl.y], [q.x, q.y])).toBeCloseTo(3, 9);
  });
});

describe('the words that went', () => {
  it('a selection has no subtract and no in: without is the one word, and a later state names rows by a set operation', () => {
    const m = curve([[0, 0], [1, 0], [2, 0]]);
    expect('subtract' in m.points).toBe(false);
    expect('in' in m.points).toBe(false);
    const first = m.points.filter((p) => p.index === 0);
    expect(m.points.without(first).indices).toEqual([1, 2]);
    const later = m.points.set('x', (p) => p.x + 1);
    expect(later.points.intersect(first).indices).toEqual([0]);
  });
});

const TINY = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg"><defs>
<font id="tiny" horiz-adv-x="500">
  <font-face font-family="Tiny" units-per-em="1000" ascent="800" descent="-200" x-height="500" cap-height="700" />
  <glyph glyph-name="A" unicode="A" horiz-adv-x="600" d="M0 0L300 700L600 0" />
</font></defs></svg>`;

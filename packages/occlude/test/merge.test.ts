import { describe, expect, it } from 'vitest';
import { append, curve, material, type Material } from '../src/index.js';

const seg = (a: [number, number], b: [number, number], attrs: Record<string, number> = {}) => material([a, b], { edges: [[0, 1]], ...attrs });
const square = (x = 0, y = 0, s = 10) => curve([[x, y], [x + s, y], [x + s, y + s], [x, y + s]], { closed: true });
// Every edge as an unordered pair of rounded positions, sorted — the ink, without the rows.
const spans = (m: Material) => m.edges
  .map((e) => [[+e.a.x.toFixed(6), +e.a.y.toFixed(6)], [+e.b.x.toFixed(6), +e.b.y.toFixed(6)]].sort() as number[][])
  .map((p) => JSON.stringify(p))
  .sort();

describe('merge', () => {
  it('two squares sharing a wall: one wall, and planarize finds both faces', () => {
    const pair = append(square(0, 0), square(10, 0));
    expect(pair.edgeCount).toBe(8);
    expect(() => pair.planarize()).toThrow(/m\.merge\(\)/);
    const m = pair.merge();
    expect(m.n).toBe(6);
    expect(m.edgeCount).toBe(7);
    expect(m.planarize().faces().faces.map((f) => +f.area.toFixed(6))).toEqual([100, 100]);
  });

  it('partial overlap: three spans over the four vertices there already were', () => {
    const src = append(seg([0, 0], [10, 0]), seg([5, 0], [15, 0]));
    const m = src.merge();
    expect(m.n).toBe(4);
    expect(m.edgeCount).toBe(3);
    expect(spans(m)).toEqual(spans(append(seg([0, 0], [5, 0]), seg([5, 0], [10, 0]), seg([10, 0], [15, 0]))));
    // Every span ends on a vertex the input already had: nothing was minted.
    expect([...m.pointIds].sort()).toEqual([...src.pointIds].sort());
  });

  it('a reversed exact duplicate goes, and the survivor is the edge it was', () => {
    const src = append(seg([0, 0], [10, 0]), seg([10, 0], [0, 0]));
    const m = src.merge();
    expect(m.n).toBe(2);
    expect(m.edgeCount).toBe(1);
    expect(m.edgeIds[0]).toBe(src.edgeIds[0]);
    expect(m.edgeRoots[0]).toBe(src.edgeRoots[0]);
  });

  it('an untouched edge keeps its id; a span keeps the root of the lowest source and mints an id', () => {
    const src = append(seg([0, 0], [10, 0]), seg([5, 0], [15, 0]), seg([0, 40], [10, 40]));
    const m = src.merge();
    expect(m.edgeCount).toBe(4);
    const lone = m.edges.filter((e) => e.a.y === 40);
    expect(lone.length).toBe(1);
    expect(m.edgeIds[lone.at(0).index]).toBe(src.edgeIds[2]);
    expect(m.edgeRoots[lone.at(0).index]).toBe(src.edgeRoots[2]);
    const cut = m.edges.filter((e) => e.a.y === 0);
    const byLow = [...cut].sort((p, q) => Math.min(p.a.x, p.b.x) - Math.min(q.a.x, q.b.x));
    expect(byLow.map((e) => m.edgeRoots[e.index])).toEqual([src.edgeRoots[0], src.edgeRoots[0], src.edgeRoots[1]]);
    for (const e of byLow) expect([...src.edgeIds]).not.toContain(m.edgeIds[e.index]);
  });

  it('tolerance joins near vertices; the lowest row survives, where it is, with its own columns', () => {
    const src = append(
      material([{ x: 0, y: 0, tag: 1 }, { x: 10, y: 0, tag: 2 }], { edges: [[0, 1]] }),
      material([{ x: 0.01, y: 0, tag: 3 }, { x: 0.01, y: 10, tag: 4 }], { edges: [[0, 1]] }),
    );
    const m = src.merge({ tolerance: 0.05 });
    expect(m.n).toBe(3);
    expect(m.edgeCount).toBe(2);
    expect([m.x[0], m.y[0]]).toEqual([0, 0]);
    expect(m.attrs.tag[0]).toBe(1);
    expect([...m.attrs.tag]).toEqual([1, 2, 4]);
    expect(m.points.at(0).adjacent.length).toBe(2);
    // Exactly coincident only, by default: nothing is joined.
    expect(src.merge().n).toBe(4);
  });

  it('edge columns: distribute is scaled by the span, everything else is copied', () => {
    const src = append(seg([0, 0], [10, 0]), seg([5, 0], [15, 0]))
      .edgeAttributes({ load: 10, tag: (e) => e.index + 1 }, { transfer: { load: 'distribute' } });
    const m = src.merge();
    const byLow = [...m.edges].sort((p, q) => Math.min(p.a.x, p.b.x) - Math.min(q.a.x, q.b.x));
    expect(byLow.map((e) => m.edgeAttrs.load[e.index])).toEqual([5, 5, 5]);
    expect(byLow.map((e) => m.edgeAttrs.tag[e.index])).toEqual([1, 1, 2]);
    expect(m.edgeTransfers.load).toBe('distribute');
  });

  it('two loose duplicate points are one point; an empty material is itself', () => {
    const dots = material([[3, 4], [3, 4]]).merge();
    expect(dots.n).toBe(1);
    expect(dots.edgeCount).toBe(0);
    const empty = material([]).merge();
    expect(empty.n).toBe(0);
    expect(empty.edgeCount).toBe(0);
  });

  it('an exact overlap off the axes merges with no tolerance at all', () => {
    const m = append(seg([0, 0], [10, 10]), seg([5, 5], [15, 15])).merge();
    expect(m.n).toBe(4);
    expect(m.edgeCount).toBe(3);
    expect(spans(m)).toEqual(spans(append(seg([0, 0], [5, 5]), seg([5, 5], [10, 10]), seg([10, 10], [15, 15]))));
  });

  it('a chain of overlaps on one line is one run of spans', () => {
    const m = append(seg([0, 0], [10, 0]), seg([5, 0], [15, 0]), seg([12, 0], [20, 0])).merge();
    expect(m.edgeCount).toBe(5);
    expect(spans(m)).toEqual(spans(append(
      seg([0, 0], [5, 0]), seg([5, 0], [10, 0]), seg([10, 0], [12, 0]), seg([12, 0], [15, 0]), seg([15, 0], [20, 0]),
    )));
    expect(m.n).toBe(6);
  });

  it('a non-finite coordinate is a mistake and refuses by row', () => {
    expect(() => material([[0, 0], [Number.NaN, 5]], { edges: [[0, 1]] }).merge()).toThrow(/merge: vertex 1 is not finite/);
    expect(() => seg([0, 0], [10, 0]).merge({ tolerance: -1 })).toThrow(/tolerance/);
  });

  it('end to end is not an overlap, and a T is planarize\'s job', () => {
    const line = append(seg([0, 0], [10, 0]), seg([10, 0], [20, 0])).merge();
    expect(line.n).toBe(3);
    expect(line.edgeCount).toBe(2);
    const tee = append(seg([0, 0], [10, 0]), seg([5, 0], [5, 7]));
    const merged = tee.merge();
    expect(merged.n).toBe(4);
    expect(merged.edgeCount).toBe(2);
    expect([...merged.edgeIds]).toEqual([...tee.edgeIds]);
    const flat = merged.planarize();
    expect(flat.n).toBe(4);
    expect(flat.edgeCount).toBe(3);
  });
});

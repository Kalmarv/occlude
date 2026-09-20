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

  // A lattice of rectangles is the drawing a sketch is most likely to build
  // by hand, and it is where two walls land a single ulp apart: a drawable
  // coordinate is resolved to paper by a multiply, and the same lattice line
  // comes back with a different last bit depending on which rectangle asked.
  describe('a lattice of rectangles', () => {
    const grid = (cols: number, rows: number, w: number, h: number) => {
      const boxes: Material[] = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        boxes.push(curve([[c * w, r * h], [(c + 1) * w, r * h], [(c + 1) * w, (r + 1) * h], [c * w, (r + 1) * h]], { closed: true }));
      }
      return append(...boxes);
    };

    it('40 x 50 snapped cells: one wall each, and every cell is a face', () => {
      const m = grid(40, 50, 2, 1.5).merge();
      // 41 x 51 corners, and one wall per shared edge instead of two.
      expect(m.n).toBe(41 * 51);
      expect(m.edgeCount).toBe(40 * 51 + 41 * 50);
      expect(m.planarize().faces().faces.length).toBe(2000);
    });

    it('a T-junction row: wide cells over narrow ones, still one face each', () => {
      const row = (y: number, h: number, w: number, n: number) => {
        const boxes: Material[] = [];
        for (let c = 0; c < n; c++) boxes.push(curve([[c * w, y], [(c + 1) * w, y], [(c + 1) * w, y + h], [c * w, y + h]], { closed: true }));
        return append(...boxes);
      };
      // 12 cells of width 2 under 8 of width 3: every wall of the lower row
      // meets the middle of a wall in the upper one.
      const m = append(row(0, 4, 2, 12), row(4, 4, 3, 8)).merge().planarize();
      expect(m.faces().faces.length).toBe(20);
    });

    it('two walls one ulp apart cross a third at points that stay apart', () => {
      // The configuration a 2 000-rectangle lattice produces: one vertical
      // wall, and two horizontals whose y differs in the last bit. The
      // crossings are 1.8e-15 apart, and interpolating either one along the
      // vertical rounds them onto the same coordinates.
      const y1 = 14.5;
      const y2 = 14.499999999999998;
      expect(y1).not.toBe(y2);
      const m = append(
        seg([50.24999999999999, 17.75], [50.24999999999999, 11.75]),
        seg([56.75, y1], [46.75, y1]),
        seg([49.75, y2], [51, y2]),
      ).merge().planarize();
      expect(m.edgeCount).toBe(3 + 2 + 2);
      // The six source endpoints survive, and the two crossings are new
      // rows sitting exactly on the wall each one belongs to.
      expect(m.n).toBe(8);
      expect([m.x[6], m.y[6]]).toEqual([50.24999999999999, y1]);
      expect([m.x[7], m.y[7]]).toEqual([50.24999999999999, y2]);
    });

    it('a one-ulp collinear overlap is one run, not two walls sharing a sliver', () => {
      // The second wall starts one ulp inside the first. Dividing by the
      // length to compare them rounds that ulp away and calls it a touch;
      // comparing the ends along the line cannot.
      const end = 15.862299221315606;
      const start = 15.862299221315604;
      expect(end).toBeGreaterThan(start);
      const m = append(
        seg([4.67047033831994, 39.8], [end, 39.8]),
        seg([start, 39.8], [26.42563261088823, 39.8]),
      ).merge();
      // Two spans that meet, rather than two walls that overlap: the run is
      // cut at the first wall's end, and the ulp inside it is not drawn
      // twice.
      expect(m.edgeCount).toBe(2);
      // To the last bit: the cut is at the first wall's end, not one ulp
      // inside it, so no length is covered twice.
      const ends = [0, 1].map((e) => [m.x[m.edgeList[2 * e]], m.x[m.edgeList[2 * e + 1]]]);
      expect(ends).toEqual([[4.67047033831994, end], [end, 26.42563261088823]]);
      expect(() => m.planarize().faces()).not.toThrow();
    });

    it('two crossings that round to one parameter are cut in the order they lie', () => {
      // Both walls cross the run so close together that the parameter along
      // it is the same number; only their positions tell them apart. Cut in
      // the wrong order, the run doubles back and two of its pieces share
      // the sliver between the walls.
      const y = 39.800000000000004;
      const m = append(
        seg([13.600000000000001, y], [3.4000000000000004, y]),
        seg([7.800000000000001, 35], [7.800000000000001, 45]),
        seg([7.800000000000002, 35], [7.800000000000002, 45]),
      ).merge().planarize();
      expect(m.edgeCount).toBe(3 + 2 + 2);
      // The run's pieces travel one way, high x to low, without doubling back.
      const xs = [0, 1, 2].map((e) => [m.x[m.edgeList[2 * e]], m.x[m.edgeList[2 * e + 1]]]);
      for (const [a, b] of xs) expect(a).toBeGreaterThan(b);
      expect(xs[0][1]).toBe(7.800000000000002);
      expect(xs[1][1]).toBe(7.800000000000001);
      expect(() => m.faces()).not.toThrow();
    });
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

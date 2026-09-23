/**
 * The isoline stages as separate calls (docs/architecture.md, "Fields and
 * units" / "Isolines"): sampling, marching, chaining and finishing compose
 * to exactly what `levelContours` returns, and the marching decides the case
 * table on its own — saddles, samples equal to the level, absent cells,
 * open boundaries, `close: true`, several levels over one sampling.
 */

import { describe, expect, it } from 'vitest';
import {
  chainSegments, finishContours, levelContours, marchSegments, sampleGrid, type IsoEnv, type SampledGrid,
} from '../src/isolines.js';
import { wallSegments } from '../src/marching.js';

const env: IsoEnv = { bounds: { x: 0, y: 0, w: 4, h: 4 }, len: (l) => (typeof l === 'number' ? l : 1) };

/** A grid straight from a table of samples (row-major, gh rows of gw). */
function gridOf(rows: number[][]): SampledGrid {
  const gh = rows.length;
  const gw = rows[0].length;
  // Between the samples there is no table entry: the field is absent there.
  return sampleGrid((x, y) => rows[y]?.[x] ?? NaN, { x: 0, y: 0, w: gw - 1, h: gh - 1 }, gw, gh);
}

const segs = (b: ReturnType<typeof marchSegments>) => {
  const out: number[][] = [];
  for (let k = 0; k < b.segN; k++) out.push(Array.from(b.segXY.subarray(k * 4, k * 4 + 4)));
  return out;
};

describe('marching: the composition is the production path', () => {
  it('sample → march → chain → finish equals levelContours, per level, over one sampling', () => {
    const field = (x: number, y: number) => Math.hypot(x - 2, y - 2);
    const b = env.bounds;
    const gw = Math.max(2, Math.ceil(b.w / 0.5) + 1);
    const gh = Math.max(2, Math.ceil(b.h / 0.5) + 1);
    const grid = sampleGrid(field, b, gw, gh);
    // The level line is the plain cells, finished as an open march; the runs
    // that close it are the edge cells, finished onto the drawable.
    const staged = [1, 1.5, 3].map((lvl) => {
      const segments = marchSegments(grid, lvl, true);
      return {
        lines: finishContours(chainSegments(wallSegments(segments, false)), b, false),
        walls: finishContours(chainSegments(wallSegments(segments, true)), b, true),
      };
    });
    const direct = levelContours(env, field, [1, 1.5, 3], { step: 0.5 }).map(({ lines, walls }) => ({ lines, walls }));
    expect(staged).toEqual(direct);
  });
});

describe('marching: case decisions on hand grids', () => {
  it('samples equal to the level lie ON the contour (≥ is inside): a lone one collapses to a point, a run is traced', () => {
    // one corner exactly at the level: both crossings land on that corner,
    // the zero-length segment is never emitted
    expect(marchSegments(gridOf([[0, 1], [0, 0]]), 1, false).segN).toBe(0);
    expect(marchSegments(gridOf([[0, 1], [0, 0]]), 0.5, false).segN).toBe(1);
    // two adjacent samples at the level: the contour runs along them
    const run = segs(marchSegments(gridOf([[1, 1], [0, 0]]), 1, false));
    expect(run).toEqual([[0, 0, 1, 0]]);
  });

  it('a saddle takes the diagonal the cell-centre average asks for', () => {
    const high = gridOf([[1, 0], [0, 1]]); // centre 0.5
    const low = gridOf([[0.4, 0], [0, 0.4]]); // centre 0.2
    const a = segs(marchSegments(high, 0.5, false));
    const b = segs(marchSegments(low, 0.3, false));
    expect(a.length).toBe(2);
    expect(b.length).toBe(2);
    // centre ≥ level joins the two high corners through the middle: the two
    // segments run between the top-right/left and bottom-left/right edges
    // in one pairing; centre < level pairs them the other way
    const pair = (s: number[][]) => s.map((q) => `${q[0] < q[2] ? 'r' : 'l'}${q[1] < q[3] ? 'd' : 'u'}`).sort().join(' ');
    expect(pair(a)).not.toBe(pair(b));
  });

  it('an absent sample is where the domain ends: the region closes there, along closing (cut) edges', () => {
    const rows = [
      [0, 0, 0, 0],
      [0, 1, 1, 0],
      [0, 1, NaN, 0],
      [0, 0, 0, 0],
    ];
    const g = gridOf(rows);
    expect(g.absent[(2 + 1) * g.pw + (2 + 1)]).toBe(1);
    const cs = finishContours(chainSegments(marchSegments(g, 0.5, false)), g.b, false);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => c.closed)).toBe(true);
    expect(cs.some((c) => c.cut.includes(1))).toBe(true);
  });

  it('a region leaving the grid is open, and closes along the edge with close: true', () => {
    const g = gridOf([
      [1, 1, 0],
      [1, 1, 0],
      [0, 0, 0],
    ]);
    const open = finishContours(chainSegments(marchSegments(g, 0.5, false)), g.b, false);
    expect(open).toHaveLength(1);
    expect(open[0].closed).toBe(false);
    const closed = finishContours(chainSegments(marchSegments(g, 0.5, true)), g.b, true);
    expect(closed).toHaveLength(1);
    expect(closed[0].closed).toBe(true);
    // the closing ring wrote the pad with the below-level sentinel
    expect(g.vals[0]).toBe(0.5 - 1);
  });

  it('marching writes the pad ring per level, so several levels share one grid', () => {
    const g = gridOf([[0, 2], [2, 0]]);
    const lo = marchSegments(g, 0.5, true);
    expect(g.vals[0]).toBe(-0.5);
    const hi = marchSegments(g, 1.5, true);
    expect(g.vals[0]).toBe(0.5);
    expect(lo.segN).toBeGreaterThan(0);
    expect(hi.segN).toBeGreaterThan(0);
  });

  it('a constant grid gives no segments at any level; a segment of zero length is never emitted', () => {
    const g = gridOf([[3, 3], [3, 3]]);
    expect(marchSegments(g, 3, false).segN).toBe(0);
    expect(marchSegments(g, 2, false).segN).toBe(0);
    expect(marchSegments(g, 2, true).segN).toBe(8); // the closing ring: 8 boundary cells around a 2 × 2 grid
  });
});

import { describe, expect, it } from 'vitest';
import { fill, material, polygon, type PlaneGroup } from '../src/index.js';
import type { TransformOp } from '../src/execution.js';
import { grid } from '../src/layout.js';
import { PLANE_GROUPS, placements } from '../src/symmetry.js';

/** The placements over a `cols × rows` block of cells from the origin:
 * the kernel `t.symmetry` sizes to the drawable. */
const symmetry = (g: PlaneGroup, o: { cell: number | readonly [number, number]; cols: number; rows: number }): TransformOp[] =>
  placements(g, o.cell, 0, o.cols, 0, o.rows);
import { toolkit } from './helpers/run.js';

const env = { bounds: { w: 100, h: 100 }, len: (l: number) => l as number };

/** A placement as the map `group()` applies: T(t)·T(p)·R·S·T(−p). */
function mapOf(op: TransformOp): (x: number, y: number) => [number, number] {
  const [tx, ty] = (op.translate ?? [0, 0]) as [number, number];
  const [px, py] = (op.origin === undefined ? [0, 0] : op.origin) as [number, number];
  const th = ((op.rotate ?? 0) * Math.PI) / 180;
  const [sx, sy] = op.scale === undefined ? [1, 1] : typeof op.scale === 'number' ? [op.scale, op.scale] : (op.scale as [number, number]);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const a = c * sx;
  const b = s * sx;
  const cc = -s * sy;
  const d = c * sy;
  return (x, y) => [a * (x - px) + cc * (y - py) + px + tx, b * (x - px) + d * (y - py) + py + ty];
}

/** A point set with a tolerance, so float noise does not decide membership. */
function pointSet(tol = 1e-6) {
  const q = tol * 100;
  const buckets = new Map<string, [number, number][]>();
  return {
    add(x: number, y: number) {
      const key = `${Math.floor(x / q)},${Math.floor(y / q)}`;
      const list = buckets.get(key);
      if (list) list.push([x, y]);
      else buckets.set(key, [[x, y]]);
    },
    has(x: number, y: number): boolean {
      const bi = Math.floor(x / q);
      const bj = Math.floor(y / q);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          for (const [ax, ay] of buckets.get(`${bi + di},${bj + dj}`) ?? []) {
            if (Math.hypot(ax - x, ay - y) <= tol) return true;
          }
        }
      }
      return false;
    },
  };
}

describe('t.grid answers a geometry whose faces are the cells', () => {
  it('row-major faces with i and j, each face\'s bounds its cell, neighbours sharing one wall', () => {
    const g = grid({ w: 100, h: 50 }, { cols: 4, rows: 2 });
    const cells = g.faces;
    expect(cells.length).toBe(8);
    // Row-major: i across, then j down.
    expect(cells.map((f) => [f.i, f.j])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1]]);
    for (const f of cells) {
      expect(f.bounds.x).toBeCloseTo(25 * f.i, 12);
      expect(f.bounds.y).toBeCloseTo(25 * f.j, 12);
      expect(f.bounds.w).toBeCloseTo(25, 12);
      expect(f.bounds.cx).toBeCloseTo(25 * f.i + 12.5, 12);
      expect(f.area).toBeCloseTo(625, 9);
    }
    // One lattice of corners: a shared wall is one edge, drawn once.
    expect(g.n).toBe(5 * 3);
    expect(g.edgeCount).toBe(4 * 3 + 5 * 2);
    expect(cells.at(0).adjacent.map((f) => [f.i, f.j])).toEqual([[1, 0], [0, 1]]);
    expect(cells.at(5).adjacent.map((f) => [f.i, f.j])).toEqual([[1, 0], [0, 1], [2, 1]]);
    // Stated faces: nothing is read off the picture, and the order holds
    // through a move and a column write.
    const moved = g.move([3, 0]).faces.set('tone', (f) => f.i + f.j);
    expect(moved.faces.map((f) => [f.i, f.j])).toEqual(cells.map((f) => [f.i, f.j]));
    expect(moved.faces.at(7).tone).toBe(4);
  });

  it('a face and its bounds are areas: one closed loop, counter-clockwise in a y-up reading', () => {
    const cell = grid({ w: 100, h: 50 }, { cols: 2, rows: 1 }).faces.at(1);
    for (const cs of [cell.contours(), cell.bounds.contours()]) {
      expect(cs).toHaveLength(1);
      expect(cs[0].closed).toBe(true);
      let a2 = 0;
      for (let k = 0; k < 4; k++) {
        const [ax, ay] = cs[0].pts[k];
        const [bx, by] = cs[0].pts[(k + 1) % 4];
        a2 += ax * by - bx * ay;
      }
      expect(a2).toBeGreaterThan(0);
    }
    expect(cell.bounds.contours()[0].pts).toEqual([[50, 0], [100, 0], [100, 50], [50, 50]]);
  });

  it('a gap parts the cells: four walls each, nothing shared', () => {
    const g = grid({ w: 100, h: 100 }, { cols: 2, rows: 2, gap: 4 });
    const cell = g.faces.at(3);
    expect([cell.i, cell.j]).toEqual([1, 1]);
    expect([cell.bounds.x, cell.bounds.y, cell.bounds.w, cell.bounds.h, cell.bounds.cx, cell.bounds.cy]).toEqual([52, 52, 48, 48, 76, 76]);
    expect(g.edgeCount).toBe(16);
    for (const f of g.faces) expect(f.adjacent.length).toBe(0);
  });

  it('a degenerate count lays out nothing', () => {
    expect(grid({ w: 100, h: 100 }, { cols: 0, rows: 3 }).n).toBe(0);
    expect(grid({ w: 100, h: 100 }, { cols: Number.NaN, rows: 3 }).n).toBe(0);
    expect(grid({ w: 100, h: 100 }, { cols: 2, rows: 2, gap: 100 }).n).toBe(0);
  });

  it('every area consumer takes a cell', () => {
    const t = toolkit();
    const cell = t.grid({ cols: 2, rows: 2 }).faces.at(0);
    const shape = polygon(cell, { fill: fill('hatch') });
    expect(shape.geom.kind).toBe('path');
    const rules = material([[10, 10], [90, 10]], { edges: [[0, 1]] });
    const cut = t.within(rules, cell);
    expect(cut.n).toBe(2);
    expect(Math.max(cut.x[0], cut.x[1])).toBeCloseTo(50, 9);
    expect(t.distanceTo(cell)(25, 25)).toBeGreaterThan(0);
    expect(t.distanceTo(cell.bounds)(25, 25)).toBe(t.distanceTo(cell)(25, 25));
  });
});

describe('a flat t.tiling covers the drawable', () => {
  const t = toolkit({ aspect: [2, 1] });
  const b = t.bounds();

  for (const [p, q] of [[6, 3], [3, 6], [4, 4]] as const) {
    it(`{${p}, ${q}}: cells are faces, every shared wall minted once, the drawable covered`, () => {
      const m = t.tiling(p, q, { side: 8 });
      const cells = m.faces;
      expect(cells.length).toBeGreaterThan(30);
      // Euler on a connected planar graph: V − E + F = 2 counting the outside.
      expect(m.n - m.edgeCount + cells.length).toBe(1);
      expect(cells.sum('area')).toBeCloseTo(b.w * b.h, 6);
      let x1 = -Infinity;
      for (let i = 0; i < m.n; i++) x1 = Math.max(x1, m.x[i]);
      expect(x1).toBeCloseTo(b.x + b.w, 6);
      // A whole cell is the regular p-gon of side 8.
      const whole = cells.filter((f) => f.boundaryEdges.length === p && f.adjacent.length === p);
      expect(whole.length).toBeGreaterThan(5);
      const area = (p * 64) / (4 * Math.tan(Math.PI / p));
      for (const f of whole) expect(f.area).toBeCloseTo(area, 6);
      // Neighbours share a wall, not merely a corner.
      const one = whole.at(0);
      for (const n of one.adjacent) expect(one.boundaryEdges.indices.filter((e) => n.edges.indices.includes(e))).toHaveLength(1);
      // Each face carries whole-number lattice coordinates, one place each.
      expect(m.faceAttrNames.sort()).toEqual(['generation', 'i', 'j', 'mirrored']);
      const seen = new Set<string>();
      for (const f of cells) {
        expect(Number.isInteger(f.i) && Number.isInteger(f.j)).toBe(true);
        seen.add(`${f.i},${f.j}`);
      }
      expect(seen.size).toBe(cells.length);
    });

    it(`{${p}, ${q}}: gap shrinks each cell about its centre and shares nothing`, () => {
      const m = t.tiling(p, q, { side: 8, gap: 1 });
      const cells = m.faces;
      expect(m.edgeCount).toBe(cells.sum((f) => f.edges.length));
      for (const f of cells) expect(f.adjacent.length).toBe(0);
      const inradius = 8 / (2 * Math.tan(Math.PI / p));
      const k = (inradius - 0.5) / inradius;
      const area = (p * 64) / (4 * Math.tan(Math.PI / p));
      // The uncut cells are the largest, and each is the p-gon shrunk by k.
      const largest = cells.max('area');
      expect(largest).toBeCloseTo(area * k * k, 6);
      expect(cells.filter((f) => Math.abs(f.area - largest) < 1e-9).length).toBeGreaterThan(5);
    });
  }

  it('{6, 3}: the axial i and j place a whole cell where its centroid is', () => {
    const side = 8;
    const m = t.tiling(6, 3, { side });
    for (const f of m.faces.filter((c) => c.adjacent.length === 6)) {
      expect(f.centroid[0]).toBeCloseTo(b.cx + side * 1.5 * f.i, 6);
      expect(f.centroid[1]).toBeCloseTo(b.cy + side * ((Math.sqrt(3) / 2) * f.i + Math.sqrt(3) * f.j), 6);
    }
  });

  it('{3, 6}: an even i is the fundamental cell\'s way round, an odd one turned', () => {
    const m = t.tiling(3, 6, { side: 8 });
    const fundamental = m.faces.at(0);
    expect([fundamental.i, fundamental.j]).toEqual([0, 0]);
    // The fundamental cell has its corner on +x: the turned cells have a
    // corner on -x instead, so their centroid sits right of their box's middle.
    for (const f of m.faces.filter((c) => c.adjacent.length === 3)) {
      const right = f.centroid[0] < f.bounds.cx;
      expect(right).toBe((f.i & 1) === 0);
    }
  });

  it('a degenerate side or a gap that eats the cell draws nothing', () => {
    expect(t.tiling(6, 3, { side: 0 }).n).toBe(0);
    expect(t.tiling(6, 3, { side: Number.NaN }).n).toBe(0);
    expect(t.tiling(6, 3, { side: 8, gap: 20 }).n).toBe(0);
  });
});

const ORBITS: Record<PlaneGroup, number> = {
  p1: 1, p2: 2, pm: 2, pg: 2, cm: 2, pmm: 4, pmg: 4, pgg: 4, cmm: 4,
  p4: 4, p4m: 8, p4g: 8, p3: 3, p3m1: 6, p31m: 6, p6: 6, p6m: 12,
};
const HEXGROUP: readonly PlaneGroup[] = ['p3', 'p3m1', 'p31m', 'p6', 'p6m'];
const cellFor = (g: PlaneGroup): number | [number, number] =>
  HEXGROUP.includes(g) ? 12 : g === 'p4' || g === 'p4m' || g === 'p4g' ? [12, 12] : [12, 9];

describe('the wallpaper placements', () => {
  it('names the seventeen groups, in IUC order', () => {
    expect(PLANE_GROUPS).toEqual(['p1', 'p2', 'pm', 'pg', 'cm', 'pmm', 'pmg', 'pgg', 'cmm', 'p4', 'p4m', 'p4g', 'p3', 'p3m1', 'p31m', 'p6', 'p6m']);
  });

  it('one cell holds the order of the point group', () => {
    for (const g of PLANE_GROUPS) {
      expect(symmetry(g, { cell: cellFor(g), cols: 1, rows: 1 })).toHaveLength(ORBITS[g]);
      expect(symmetry(g, { cell: cellFor(g), cols: 3, rows: 4 })).toHaveLength(ORBITS[g] * 12);
    }
  });

  it('every placement is a rigid motion, and a mirror is a negative scale', () => {
    for (const g of PLANE_GROUPS) {
      const ops = symmetry(g, { cell: cellFor(g), cols: 1, rows: 1 });
      let flips = 0;
      for (const op of ops) {
        const f = mapOf(op);
        const [ox, oy] = f(0, 0);
        const [ax, ay] = f(1, 0);
        const [bx, by] = f(0, 1);
        const det = (ax - ox) * (by - oy) - (bx - ox) * (ay - oy);
        expect(Math.abs(Math.abs(det) - 1)).toBeLessThan(1e-12);
        if (det < 0) {
          flips++;
          const s = op.scale as readonly [number, number];
          expect(s[0] * s[1]).toBe(-1);
        }
      }
      // Half of a group with mirrors reverses orientation; a group without
      // them has none.
      const mirrored = !['p1', 'p2', 'p3', 'p4', 'p6'].includes(g);
      expect(flips).toBe(mirrored ? ops.length / 2 : 0);
    }
  });

  it('the pattern maps onto itself under any of its own generators', () => {
    const motif: [number, number][] = [[0.17, 0.23], [0.41, 0.11], [0.29, 0.44], [0.13, 0.37]];
    for (const g of PLANE_GROUPS) {
      const cell = cellFor(g);
      const [w, h] = typeof cell === 'number' ? [cell, cell] : cell;
      const pts = motif.map(([u, v]) => [u * w, v * h] as [number, number]);
      const wide = placements(g, cell, -5, 6, -5, 6);
      const set = pointSet(1e-6);
      const all: [number, number][] = [];
      for (const op of wide) {
        const f = mapOf(op);
        for (const [x, y] of pts) {
          const q = f(x, y);
          set.add(q[0], q[1]);
          all.push(q);
        }
      }
      // Re-apply each generator to the middle of the pattern: every image
      // must already be part of it.
      const gens = symmetry(g, { cell, cols: 1, rows: 1 });
      const inner = all.filter(([x, y]) => Math.abs(x) < 2 * w && Math.abs(y) < 2 * h);
      expect(inner.length).toBeGreaterThan(3);
      for (const op of gens) {
        const f = mapOf(op);
        for (const [x, y] of inner) {
          const [qx, qy] = f(x, y);
          expect(set.has(qx, qy), `${g}: ${qx},${qy} left the pattern`).toBe(true);
        }
      }
    }
  });

  it('a cell of the wrong shape refuses by name', () => {
    expect(() => symmetry('p6m', { cell: [10, 10], cols: 1, rows: 1 })).toThrow(/p6m has a hexagonal lattice/);
    expect(() => symmetry('pmm', { cell: 10, cols: 1, rows: 1 })).toThrow(/pmm has a rectangular lattice/);
    expect(() => symmetry('p4', { cell: [10, 8], cols: 1, rows: 1 })).toThrow(/p4 has a square lattice/);
    expect(symmetry('p4', { cell: 10, cols: 1, rows: 1 })).toHaveLength(4);
    expect(() => symmetry('p7' as PlaneGroup, { cell: 10, cols: 1, rows: 1 })).toThrow(/not a plane group/);
  });

  it('is deterministic, and a degenerate cell lays out nothing', () => {
    expect(symmetry('p6m', { cell: 10, cols: 2, rows: 2 })).toEqual(symmetry('p6m', { cell: 10, cols: 2, rows: 2 }));
    expect(symmetry('p4m', { cell: 0, cols: 2, rows: 2 })).toEqual([]);
    expect(symmetry('pmm', { cell: [10, 10], cols: 0, rows: 3 })).toEqual([]);
  });

  it('the toolkit sizes the block to the drawable', () => {
    const t = toolkit({ aspect: [2, 1] });
    const ops = t.symmetry('p6m', { cell: 20 });
    expect(ops.length % 12).toBe(0);
    const xs = ops.map((op) => (op.translate as [number, number])[0]);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(t.bounds().w);
  });
});

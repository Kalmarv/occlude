import { describe, expect, it } from 'vitest';
import { PLANE_GROUPS, fill, material, polygon, symmetry, type PlaneGroup } from '../src/index.js';
import type { TransformOp } from '../src/execution.js';
import { grid, hexes, triangles } from '../src/layout.js';
import { placements } from '../src/symmetry.js';
import { toolkit } from './helpers/run.js';

const env = { bounds: { w: 100, h: 100 }, len: (l: number) => l as number };

/** A placement as the map `group()` applies: T(t)·T(p)·R·S·T(−p). */
function mapOf(op: TransformOp): (x: number, y: number) => [number, number] {
  const [tx, ty] = (op.translate ?? [0, 0]) as [number, number];
  const [px, py] = (op.origin === undefined || op.origin === 'center' ? [0, 0] : op.origin) as [number, number];
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

describe('GridCell answers the area protocol', () => {
  it('one closed loop of the four corners, counter-clockwise in a y-up reading', () => {
    const cell = grid({ w: 100, h: 50 }, { cols: 2, rows: 1 })[1];
    const cs = cell.contours();
    expect(cs).toHaveLength(1);
    expect(cs[0].closed).toBe(true);
    expect(cs[0].pts).toEqual([[50, 0], [100, 0], [100, 50], [50, 50]]);
    let a2 = 0;
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = cs[0].pts[k];
      const [bx, by] = cs[0].pts[(k + 1) % 4];
      a2 += ax * by - bx * ay;
    }
    expect(a2).toBeGreaterThan(0);
  });

  it('the cell still carries only its own eight fields', () => {
    const cell = grid({ w: 100, h: 100 }, { cols: 2, rows: 2, gap: 4 })[3];
    expect(Object.keys(cell)).toEqual(['x', 'y', 'w', 'h', 'cx', 'cy', 'i', 'j']);
    expect(JSON.parse(JSON.stringify(cell))).toEqual({ x: 52, y: 52, w: 48, h: 48, cx: 76, cy: 76, i: 1, j: 1 });
  });

  it('every area consumer takes a cell', () => {
    const t = toolkit();
    const cell = t.grid({ cols: 2, rows: 2 })[0];
    const shape = polygon(cell, { fill: fill('hatch') });
    expect(shape.geom.kind).toBe('path');
    expect(shape.geom.kind === 'path' && shape.geom.cmds.map((c) => c.op)).toEqual(['move', 'line', 'line', 'line', 'close']);
    const rules = material([[10, 10], [90, 10]], { edges: [[0, 1]] });
    const cut = t.within(rules, cell);
    expect(cut.n).toBe(2);
    expect(Math.max(cut.x[0], cut.x[1])).toBeCloseTo(50, 9);
    expect(t.distanceTo(cell)(25, 25)).toBeGreaterThan(0);
  });
});

describe('t.hexes', () => {
  it('cells are faces, every shared wall minted once', () => {
    const m = hexes(env, { spacing: 20 });
    const cells = m.faces();
    expect(cells.length).toBeGreaterThan(20);
    // Euler on a connected planar graph: V − E + F = 2 counting the outside.
    expect(m.n - m.edgeCount + cells.length).toBe(1);
    // A whole hex has six walls; no wall is drawn twice, so the average
    // degree stays near three however many cells there are.
    const interior = cells.faces.filter((f) => f.boundaryEdges.length === 6 && f.adjacent.length === 6);
    expect(interior.length).toBeGreaterThan(5);
    for (const f of interior) expect(f.area).toBeCloseTo((Math.sqrt(3) / 2) * 20 * 20, 6);
  });

  it('adjacency is real: neighbouring cells share an edge', () => {
    const m = hexes(env, { spacing: 25 });
    const cells = m.faces();
    const whole = (f: { area: number }) => Math.abs(f.area - (Math.sqrt(3) / 2) * 625) < 1e-6;
    const one = cells.faces.find((f) => whole(f) && f.adjacent.length === 6 && f.adjacent.every(whole))!;
    expect(one).toBeDefined();
    for (const n of one.adjacent) {
      expect(Math.hypot(n.centroid[0] - one.centroid[0], n.centroid[1] - one.centroid[1])).toBeCloseTo(25, 6);
      // Neighbours share a wall, not merely a corner.
      expect(one.boundaryEdges.indices.filter((e) => n.edges.indices.includes(e))).toHaveLength(1);
    }
  });

  it('each face carries its axial i and j', () => {
    const m = hexes(env, { spacing: 20 });
    const cells = m.faces();
    expect(m.faceAttrNames.sort()).toEqual(['i', 'j']);
    const seen = new Set<string>();
    for (const f of cells.faces) {
      const i = f.i as number;
      const j = f.j as number;
      expect(Number.isInteger(i)).toBe(true);
      expect(Number.isInteger(j)).toBe(true);
      seen.add(`${i},${j}`);
      // Axial coordinates place the cell where its centroid is, for a
      // whole cell: x = spacing·(i + j/2), y = spacing·(√3/2)·j.
      if (f.adjacent.length === 6) {
        expect(f.centroid[0]).toBeCloseTo(20 * (i + j / 2), 6);
        expect(f.centroid[1]).toBeCloseTo(20 * (Math.sqrt(3) / 2) * j, 6);
      }
    }
    expect(seen.size).toBe(cells.length);
  });

  it("'flat' turns the cells, and the count follows", () => {
    const pointy = hexes(env, { spacing: 20 }).faces().faces.find((f) => f.adjacent.length === 6)!;
    const flat = hexes(env, { spacing: 20, orientation: 'flat' });
    expect(flat.faces().length).toBeGreaterThan(20);
    expect(pointy.bounds.w).toBeCloseTo(20, 6);
    expect(pointy.bounds.h).toBeCloseTo((20 * 2) / Math.sqrt(3), 6);
    const one = flat.faces().faces.find((f) => f.adjacent.length === 6)!;
    // A flat-topped cell is as wide as √3/2 of its spacing and as tall as
    // its spacing: the bounding box is the other way round.
    expect(one.bounds.w).toBeCloseTo((20 * 2) / Math.sqrt(3), 6);
    expect(one.bounds.h).toBeCloseTo(20, 6);
  });

  it('gap shrinks each cell about its centre and shares nothing', () => {
    const m = hexes(env, { spacing: 20, gap: 4 });
    const cells = m.faces();
    const whole = cells.faces.filter((f) => f.boundaryEdges.length === 6);
    expect(whole.length).toBeGreaterThan(5);
    // Nothing shared: six vertices and six walls per cell, none reused.
    expect(m.edgeCount).toBe(cells.faces.reduce((n, f) => n + f.edges.length, 0));
    for (const f of whole) expect(f.area).toBeCloseTo((Math.sqrt(3) / 2) * 16 * 16, 6);
    for (const f of whole) expect(f.adjacent.length).toBe(0);
  });

  it('a degenerate spacing or a gap that eats the cell draws nothing', () => {
    expect(hexes(env, { spacing: 0 }).n).toBe(0);
    expect(hexes(env, { spacing: Number.NaN }).n).toBe(0);
    expect(hexes(env, { spacing: 20, gap: 20 }).n).toBe(0);
    expect(hexes({ bounds: { w: 0, h: 0 }, len: (l: number) => l }, { spacing: 20 }).n).toBe(0);
  });

  it('is on the toolkit, reading the drawable', () => {
    const t = toolkit({ aspect: [2, 1] });
    const m = t.hexes({ spacing: 20 });
    expect(m.faces().length).toBeGreaterThan(30);
    let x1 = 0;
    for (let i = 0; i < m.n; i++) x1 = Math.max(x1, m.x[i]);
    expect(x1).toBeCloseTo(t.bounds().w, 6);
  });
});

describe('t.triangles', () => {
  it('cells are faces, walls shared, area exact', () => {
    const m = triangles(env, { size: 20 });
    const cells = m.faces();
    expect(m.n - m.edgeCount + cells.length).toBe(1);
    const whole = cells.faces.filter((f) => f.boundaryEdges.length === 3 && f.adjacent.length === 3);
    expect(whole.length).toBeGreaterThan(10);
    for (const f of whole) expect(f.area).toBeCloseTo((Math.sqrt(3) / 4) * 400, 6);
  });

  it('an even i points up and an odd one points down', () => {
    const m = triangles(env, { size: 20 });
    expect(m.faceAttrNames.sort()).toEqual(['i', 'j']);
    for (const f of m.faces().faces) {
      if (f.adjacent.length !== 3) continue;
      const i = f.i as number;
      const j = f.j as number;
      // An upward cell has its single vertex on the row's top line.
      const top = f.points.filter((p) => Math.abs(p.y - f.bounds.y) < 1e-9).length;
      expect(top).toBe((i & 1) === 0 ? 1 : 2);
      expect(f.bounds.y).toBeCloseTo(j * 10 * Math.sqrt(3), 6);
    }
  });

  it('gap separates every cell', () => {
    const m = triangles(env, { size: 20, gap: 2 });
    const cells = m.faces();
    expect(m.edgeCount).toBe(cells.faces.reduce((n, f) => n + f.edges.length, 0));
    for (const f of cells.faces) expect(f.adjacent.length).toBe(0);
  });

  it('a degenerate size draws nothing', () => {
    expect(triangles(env, { size: 0 }).n).toBe(0);
    expect(triangles(env, { size: 20, gap: 20 }).n).toBe(0);
  });
});

const ORBITS: Record<PlaneGroup, number> = {
  p1: 1, p2: 2, pm: 2, pg: 2, cm: 2, pmm: 4, pmg: 4, pgg: 4, cmm: 4,
  p4: 4, p4m: 8, p4g: 8, p3: 3, p3m1: 6, p31m: 6, p6: 6, p6m: 12,
};
const HEXGROUP: readonly PlaneGroup[] = ['p3', 'p3m1', 'p31m', 'p6', 'p6m'];
const cellFor = (g: PlaneGroup): number | [number, number] =>
  HEXGROUP.includes(g) ? 12 : g === 'p4' || g === 'p4m' || g === 'p4g' ? [12, 12] : [12, 9];

describe('symmetry()', () => {
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

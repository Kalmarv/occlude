/**
 * A cut material stays an area: `t.within(material, area)` closes the part
 * of each face inside the area along the boundary, and marks the closing
 * edges with the edge column `cut`. An open chain ends at the boundary, as
 * it always did.
 *
 * `within-closes.golden.json` was written from HEAD (e4928d5) before the
 * change, by the same calls as the hatch and filter-form cases below: the
 * old function's rows, and the old face and edge filter answers.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { toolkit } from './helpers/run.js';
import { circle, material, rect, type Material } from '../src/index.js';

const golden = JSON.parse(readFileSync(new URL('./within-closes.golden.json', import.meta.url), 'utf8'));
const t = toolkit({ aspect: [1, 1] });

type P = [number, number];
/** Signed shoelace area. */
const shoelace = (pts: readonly (readonly [number, number])[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
};
/** A polygon clipped to an axis-aligned rect (Sutherland–Hodgman): exact
 * for the convex cells and rings these cases use. */
const clipToRect = (poly: readonly (readonly [number, number])[], x0: number, y0: number, x1: number, y1: number): P[] => {
  let out: P[] = poly.map(([x, y]) => [x, y]);
  const planes: [(p: P) => number, (a: P, b: P) => P][] = [
    [(p) => p[0] - x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => x1 - p[0], (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] - y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => y1 - p[1], (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [d, cross] of planes) {
    const next: P[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      if (d(a) >= 0) next.push(a);
      if ((d(a) >= 0) !== (d(b) >= 0)) next.push(cross(a, b));
    }
    out = next;
  }
  return out;
};
const cutOf = (m: Material, e: number) => m.edgeAttrs.cut[e];
const onRectEdge = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
  Math.abs(x - x0) < 1e-9 || Math.abs(x - x1) < 1e-9 || Math.abs(y - y0) < 1e-9 || Math.abs(y - y1) < 1e-9;

describe('a lattice cut to a rect', () => {
  const [x0, y0, x1, y1] = [13, 17, 74, 64];
  const src = t.hexes({ spacing: 12, orientation: 'pointy', gap: 0 }).attributes({ w: (p) => p.x * 2 + p.y });
  const out = t.within(src, rect(x0, y0, x1 - x0, y1 - y0));
  const cells = out.faces();
  const srcFaces = src.faces();

  it('every cell the rect overlaps comes back as a face, with the area it has inside', () => {
    const expected = srcFaces.map((f) => Math.abs(shoelace(clipToRect(f.contours()[0].pts, x0, y0, x1, y1)))).filter((a) => a > 1e-9);
    expect(cells.length).toBe(expected.length);
    const got = cells.map((f) => f.area).sort((a, b) => a - b);
    expected.sort((a, b) => a - b).forEach((a, i) => expect(got[i]).toBeCloseTo(a, 6));
    const total = cells.map((f) => f.area).reduce((s, a) => s + a, 0);
    expect(Math.abs(total - (x1 - x0) * (y1 - y0))).toBeLessThan(1e-6);
  });

  it("a rim cell's walls are its cut walls and rim pieces with cut = 1; an interior cell has none", () => {
    let rim = 0;
    for (const f of cells) {
      const walls = f.boundaryEdges.indices;
      const pieces = walls.filter((e) => cutOf(out, e) === 1);
      for (const e of pieces) {
        const a = out.edgeList[2 * e];
        const b = out.edgeList[2 * e + 1];
        // a rim piece lies along one side of the rect
        const mx = (out.x[a] + out.x[b]) / 2;
        const my = (out.y[a] + out.y[b]) / 2;
        expect(onRectEdge(mx, my, x0, y0, x1, y1)).toBe(true);
      }
      if (pieces.length > 0) rim++;
      for (const e of walls) if (cutOf(out, e) === 0) expect(out.edgeRoots[e]).toBeGreaterThan(0);
    }
    expect(rim).toBeGreaterThan(0);
    expect(rim).toBe(cells.length - t.within(srcFaces, rect(x0, y0, x1 - x0, y1 - y0)).length);
    expect(Object.keys(out.edgeTransfers)).not.toContain('cut');
  });

  it('interior cells are the rows they were, ids and all', () => {
    const contained = t.within(srcFaces, rect(x0, y0, x1 - x0, y1 - y0));
    expect(contained.length).toBeGreaterThan(0);
    const outPoints = new Set(out.pointIds);
    const outEdges = new Set(out.edgeIds);
    for (const f of contained) {
      for (const v of f.points.indices) expect(outPoints.has(src.pointIds[v])).toBe(true);
      for (const e of f.edges.indices) expect(outEdges.has(src.edgeIds[e])).toBe(true);
    }
  });

  it('a rim piece ends at the row the cut wall ends at: no duplicate at a crossing', () => {
    const at = new Set<string>();
    for (let i = 0; i < out.n; i++) at.add(`${out.x[i]},${out.y[i]}`);
    expect(at.size).toBe(out.n);
    // every rim endpoint on a crossing also ends a cut wall
    const degreeByKind = new Map<number, { rim: number; wall: number }>();
    for (let e = 0; e < out.edgeCount; e++) {
      for (const v of [out.edgeList[2 * e], out.edgeList[2 * e + 1]]) {
        const d = degreeByKind.get(v) ?? { rim: 0, wall: 0 };
        if (cutOf(out, e) === 1) d.rim++;
        else d.wall++;
        degreeByKind.set(v, d);
      }
    }
    const srcIds = new Set(src.pointIds);
    for (const [v, d] of degreeByKind) {
      if (d.rim === 0) continue;
      expect(d.rim).toBe(2);
      // a rim vertex is a crossing (a wall ends there) or a rect corner (new)
      if (d.wall === 0) {
        expect(srcIds.has(out.pointIds[v])).toBe(false);
        expect([[x0, y0], [x1, y0], [x1, y1], [x0, y1]].some(([x, y]) => out.x[v] === x && out.y[v] === y)).toBe(true);
      }
    }
  });

  it('a rect corner inside a cell is a vertex of that face, minted, with copied columns', () => {
    const corner = [...Array(out.n).keys()].find((v) => out.x[v] === x0 && out.y[v] === y0)!;
    expect(corner).toBeDefined();
    expect(new Set(src.pointIds).has(out.pointIds[corner])).toBe(false);
    const face = cells.containing([x0 + 0.1, y0 + 0.1]).at(0);
    expect(face.points.indices).toContain(corner);
    const neighbours: number[] = [];
    for (let e = 0; e < out.edgeCount; e++) {
      const a = out.edgeList[2 * e];
      const b = out.edgeList[2 * e + 1];
      if (a === corner) neighbours.push(b);
      if (b === corner) neighbours.push(a);
    }
    expect(neighbours.length).toBe(2);
    expect(neighbours.map((v) => out.attrs.w[v])).toContain(out.attrs.w[corner]);
  });
});

describe('the closure decides', () => {
  it('a single closed ring cut by a rect is one face, closed along the rect', () => {
    const ring = t.material(circle(50, 50, 20));
    const out = t.within(ring, rect(50, 30, 40, 40));
    const cells = out.faces();
    expect(cells.length).toBe(1);
    const ringPts: P[] = [...Array(ring.n).keys()].map((i) => [ring.x[i], ring.y[i]]);
    expect(cells.at(0).area).toBeCloseTo(Math.abs(shoelace(clipToRect(ringPts, 50, 30, 90, 70))), 6);
    const rim = [...out.edgeAttrs.cut].filter((c) => c === 1).length;
    expect(rim).toBe(1);
  });

  it('a lattice already clipped to the frame keeps its frame cells as faces', () => {
    // Caleb's case: the frame walls lie ON the boundary, where the cut drops them.
    const out = t.within(t.hexes({ spacing: 50, orientation: 'pointy', gap: 1 }), rect(0, 0, 100, 100));
    expect(out.faces().length).toBe(t.hexes({ spacing: 50, orientation: 'pointy', gap: 1 }).faces().length);
    for (const f of out.faces()) {
      const inner = t.within(t.hexes({ spacing: 15, orientation: 'pointy', gap: 1 }), f);
      expect(inner.faces().length).toBeGreaterThan(0);
    }
  });

  it('an open chain is cut exactly as before, and gets no cut column', () => {
    const pts: P[] = [];
    const edges: [number, number][] = [];
    for (let k = 0; k < 12; k++) { pts.push([-10 + k * 9, -5], [10 + k * 9, 105]); edges.push([2 * k, 2 * k + 1]); }
    for (let k = 0; k < 4; k++) { const i = pts.length; pts.push([30 + k * 10, 30], [40 + k * 10, 90], [30 + k * 10, 40]); edges.push([i, i + 1], [i + 2, i + 1]); }
    let hatch = material(pts, { edges }).attributes({ w: (p) => p.x * 0.5 + p.y });
    hatch = hatch.edgeAttributes({ len: 1, tone: (e) => e.index + 0.25 }, { transfer: { len: 'distribute' } });
    const cut = t.within(hatch, rect(20, 15, 60, 50));
    const g = golden.hatch;
    expect([...cut.x]).toEqual(g.x);
    expect([...cut.y]).toEqual(g.y);
    expect([...cut.edgeList]).toEqual(g.edges);
    for (const name of Object.keys(g.attrs)) expect([...cut.attrs[name]]).toEqual(g.attrs[name]);
    for (const name of Object.keys(g.edgeAttrs)) expect([...cut.edgeAttrs[name]]).toEqual(g.edgeAttrs[name]);
    expect(cut.attrNames.sort()).toEqual(Object.keys(g.attrs).sort());
    expect(cut.edgeAttrNames.sort()).toEqual(Object.keys(g.edgeAttrs).sort());
    expect([...cut.pointIds].map((id) => [...hatch.pointIds].indexOf(id))).toEqual(g.keptIds);
    // an open chain's own cut column is just a column: it travels as one
    const own = t.within(hatch.edgeAttributes({ cut: 3 }), rect(20, 15, 60, 50));
    expect([...own.edgeAttrs.cut].every((c) => c === 3)).toBe(true);
  });

  it('a bounded scatter stays a point cloud: no cut column for connect and steps to trip on', () => {
    const pts = t.scatter({ spacing: 13, within: circle(48, 50, 42) });
    expect(pts.edgeAttrNames).toEqual([]);
  });

  it('a lattice whose cut closes nothing still says so: a cut column of zeros', () => {
    const src = t.hexes({ spacing: 12, orientation: 'pointy', gap: 0 });
    const out = t.within(src, rect(-50, -50, 300, 300));
    expect(out.edgeAttrs.cut.length).toBe(out.edgeCount);
    expect([...out.edgeAttrs.cut].every((c) => c === 0)).toBe(true);
  });

  it('an existing cut column is replaced, not a throw', () => {
    const src = t.hexes({ spacing: 12, orientation: 'pointy', gap: 0 });
    const marked = src.edgeAttributes({ cut: 7 });
    const area = circle(50, 50, 30);
    const plain = t.within(src, area);
    const out = t.within(marked, area);
    expect(out.faces().length).toBe(plain.faces().length);
    expect([...out.edgeAttrs.cut]).toEqual([...plain.edgeAttrs.cut]);
    expect(out.edgeAttrs.cut.some((c) => c === 1)).toBe(true);
  });
});

describe('the filter forms do not change', () => {
  const cells = t.hexes({ spacing: 12, orientation: 'pointy', gap: 1 });
  const disc = circle(50, 50, 30);
  it('faces', () => {
    for (const form of ['contained', 'centroid', 'touching'] as const) {
      expect([...t.within(cells.faces(), disc, { faces: form })].map((f) => f.index)).toEqual(golden.faces[form]);
    }
  });
  it('edges', () => {
    for (const form of ['contained', 'midpoint', 'touching'] as const) {
      expect([...t.within(cells.edges, disc, { edges: form }).indices]).toEqual(golden.edges[form]);
    }
  });
});

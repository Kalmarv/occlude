/**
 * The face form of `replace`: every selected leaf face swapped for a
 * motif's faces, read in the face's frame — its source placement, or the
 * similarity from its first wall. The replaced face stays as the parent of
 * the new ones; a wall it shares with a kept face is split where the motif
 * puts points, and two replaced neighbours share those points once.
 */

import { describe, expect, it } from 'vitest';
import { material, space, type Face, type Material } from '../src/index.js';
import { toolkit } from './helpers/run.js';

const h = Math.sqrt(3) / 2;

/** The unit triangle cut in four: three corners and the middle. */
const sierpinski = (): Material =>
  material([[0, 0], [1, 0], [0.5, h], [0.5, 0], [0.75, h / 2], [0.25, h / 2]], {
    faces: [[0, 3, 5], [3, 1, 4], [5, 4, 2], [3, 4, 5]],
  });

/** A rhomb of two equilateral triangles of side 10, sharing the wall from
 * (10, 0) to (5, 10h), each stated from its own first corner. */
const rhomb = (): Material => material([[0, 0], [10, 0], [5, 10 * h], [15, 10 * h]], { faces: [[0, 1, 2], [1, 3, 2]] });
const middle: [number, number] = [7.5, 5 * h];

const near = (a: readonly number[], b: readonly number[], tol = 1e-9) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

/** Is (x, y) inside a closed loop of positions? */
function inside(pts: readonly (readonly number[])[], x: number, y: number): boolean {
  let odd = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

describe('replace on faces', () => {
  it('refuses an outline with another number of corners, by name', () => {
    const tri = material([[0, 0], [10, 0], [5, 8]], { faces: [[0, 1, 2]] });
    const quad = material([[0, 0], [1, 0], [1, 1], [0, 1]], { faces: [[0, 1, 2, 3]] });
    expect(() => tri.replace(tri.faces, quad)).toThrow("replace: the motif's outline has 4 corners and this face has 3");
  });

  it('nests: the replaced face is the parent, its children follow every face', () => {
    const start = material([[0, 0], [10, 0], [5, 10 * h]], { faces: [[0, 1, 2]] });
    let g = start;
    for (let i = 0; i < 3; i++) g = g.replace(g.faces.filter((f) => f.leaf), sierpinski());
    expect(g.faces.length).toBe(1 + 4 + 16 + 64);
    expect(g.n).toBe(45);
    expect(g.edgeCount).toBe(108);
    const root = g.faces.at(0);
    expect([root.depth, root.leaf, root.parent, root.children.length]).toEqual([0, false, undefined, 4]);
    // Parents before children, children in the motif's order.
    const first = g.faces.at(1);
    expect(first.parent).toBe(root);
    expect(first.source).toBe(root);
    expect(first.depth).toBe(1);
    const leaves = g.faces.filter((f) => f.leaf);
    expect(leaves.length).toBe(64);
    expect(leaves.every((f) => f.depth === 3)).toBe(true);
    // The area of a parent is its children's.
    expect(leaves.map((f) => f.area).reduce((a, b) => a + b, 0)).toBeCloseTo(root.area, 9);
    for (const f of g.faces) if (!f.leaf) expect(f.children.map((c) => c.area).reduce((a, b) => a + b, 0)).toBeCloseTo(f.area, 9);
    // The motif lands in the unit frame: the first corner child is at the
    // first corner of the face.
    expect(near([first.bounds.x, first.bounds.y, first.bounds.w], [0, 0, 5], 1e-9) && Math.abs(first.bounds.w - 5) < 1e-9).toBe(true);
  });

  it('skips a face that holds others: only a leaf is replaced', () => {
    const start = material([[0, 0], [10, 0], [5, 10 * h]], { faces: [[0, 1, 2]] });
    const once = start.replace(start.faces, sierpinski());
    expect(once.replace(once.faces.filter((f) => !f.leaf), sierpinski())).toBe(once);
    // An empty selection is nothing to do.
    expect(once.replace(once.faces.filter(() => false), sierpinski())).toBe(once);
  });

  it('two replaced neighbours share the points and pieces of their wall once', () => {
    const g = rhomb();
    const both = g.replace(g.faces, sierpinski());
    // Four corners, four outer midpoints and one on the shared wall.
    expect(both.n).toBe(9);
    // Five walls in two pieces each, three edges inside each triangle.
    expect(both.edgeCount).toBe(16);
    const mid = both.points.filter((p) => near([p.x, p.y], middle));
    expect(mid.length).toBe(1);
    expect(mid.at(0).edges.length).toBe(6);
    expect(both.faces.filter((f) => f.leaf).length).toBe(8);
  });

  it('a kept neighbour keeps its statement and columns, run through the new point', () => {
    const g = rhomb().faces.set('tag', (f: Face) => (f.index === 0 ? 1 : 2));
    const one = g.replace(g.faces.filter((f) => f.tag === 1), sierpinski());
    expect(one.n).toBe(7);
    const kept = one.faces.at(1);
    expect([kept.leaf, kept.depth, kept.tag]).toEqual([true, 0, 2]);
    expect(kept.area).toBeCloseTo(25 * Math.sqrt(3), 9);
    // Its loop runs through the midpoint of the shared wall.
    expect(kept.corners.length).toBe(4);
    expect(kept.contours()[0].pts.some((p) => near(p, middle))).toBe(true);
    // The same face in both states.
    expect(one.faces.rows(g.faces.at(1)).length).toBe(1);
    // The replaced face keeps its column; its children take it (nearest).
    expect(one.faces.at(0).tag).toBe(1);
    expect(one.faces.filter((f) => f.parent?.index === 0).map((f) => f.tag)).toEqual([1, 1, 1, 1]);
  });

  it('carries columns: a parent face column by its policy, the motif face column wins, edge columns', () => {
    const g = material([[0, 0], [4, 0], [4, 4], [0, 4]], { faces: [[0, 1, 2, 3]] })
      .faces.set({ tone: 5, kind: 'old' })
      .faces.set('gone', 7, { transfer: 'drop' })
      .edges.set({ w: 3, rest: 2 });
    const motif = material([[0, 0], [1, 0], [1, 1], [0, 1]], { faces: [[0, 1, 2], [0, 2, 3]] })
      .faces.set('kind', (f: Face) => (f.index === 0 ? 'a' : 'b'))
      .edges.set({ w: (e) => (e.a.index + e.b.index === 2 ? 9 : 1), mark: 1 });
    const out = g.replace(g.faces, motif);
    const [parent, a, b] = [out.faces.at(0), out.faces.at(1), out.faces.at(2)];
    expect([parent.kind, parent.tone, parent.gone]).toEqual(['old', 5, 7]);
    expect([a.kind, a.tone, a.gone]).toEqual(['a', 5, 0]);
    expect([b.kind, b.tone, b.gone]).toEqual(['b', 5, 0]);
    // The frame puts the unit square on the face: the diagonal from the
    // first corner.
    expect(near(a.centroid, [8 / 3, 4 / 3])).toBe(true);
    // The diagonal is the motif's edge inside; the walls take the outline's
    // `w`, keep their own `rest`, and gain the motif's `mark`.
    const diagonal = out.edges.filter((e) => near([e.a.x + e.b.x, e.a.y + e.b.y], [4, 4]) && e.length > 5);
    expect(diagonal.length).toBe(1);
    expect([diagonal.at(0).w, diagonal.at(0).rest, diagonal.at(0).mark]).toEqual([9, 0, 1]);
    const walls = out.edges.without(diagonal);
    expect(walls.map((e) => [e.w, e.rest, e.mark])).toEqual([[1, 2, 1], [1, 2, 1], [1, 2, 1], [1, 2, 1]]);
    // A new edge answers the face it came from.
    expect(diagonal.at(0).source).toBe(g.faces.at(0));
  });

  it('takes a hyperbolic cell through its placement: the motif is the model face, split', () => {
    const t = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) });
    const tiles = t.tiling(7, 3, { depth: 2 });
    // Face 0 of an unturned curved tiling is the model face, about the
    // centre of the space.
    const model = [...tiles.faces.at(0).points.filter((p) => p.corner)].map((p) => [p.x, p.y] as [number, number]);
    expect(model.length).toBe(7);
    const c = t.space.center;
    const motif = material([[c[0], c[1]], ...model], { faces: model.map((_, k) => [0, k + 1, ((k + 1) % 7) + 1]) });
    const cell = tiles.faces.at(1);
    const out = tiles.replace(cell, motif);
    expect(out.faces.length).toBe(tiles.faces.length + 7);
    // One new corner, the cell's centre, where its placement puts the
    // model's; each spoke is a geodesic, carried with its samples.
    const added = out.points.filter((p) => p.index >= tiles.n);
    const centre = added.filter((p) => p.corner === 1);
    expect(centre.length).toBe(1);
    expect(near([centre.at(0).x, centre.at(0).y], (cell.source as { point(p: [number, number]): number[] }).point([c[0], c[1]]), 1e-9)).toBe(true);
    expect(added.length).toBeGreaterThan(1);
    expect(out.edgeCount).toBe(tiles.edgeCount + 7 + added.length - 1);
    // Each spoke runs from the centre to a corner of the cell.
    for (const e of centre.at(0).edges) {
      let [from, at] = [centre.at(0), e.a.index === centre.at(0).index ? e.b : e.a];
      while (at.corner !== 1) [from, at] = [at, at.adjacent.filter((q) => q.index !== from.index).at(0)];
      expect(at.index).toBeLessThan(tiles.n);
    }
    const children = out.faces.filter((f) => f.parent?.index === 1);
    expect(children.length).toBe(7);
    const outline = cell.contours()[0].pts;
    for (const f of children) {
      expect(inside(outline, f.centroid[0], f.centroid[1])).toBe(true);
      expect(f.source).toBe(out.faces.at(1));
      expect(f.corners.filter((k) => k.point.corner).length).toBe(3);
    }
    // The children cover the cell exactly on the chart (the area in the
    // space is a quadrature, face by face).
    const chart = (f: Face) => {
      const pts = f.contours()[0].pts;
      let a = 0;
      for (let i = 0; i < pts.length; i++) a += pts[i][0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * pts[i][1];
      return a / 2;
    };
    expect(children.map(chart).reduce((a, b) => a + b, 0)).toBeCloseTo(chart(cell), 9);
    expect(children.map((f) => f.area).reduce((a, b) => a + b, 0) / cell.area).toBeCloseTo(1, 3);
    for (let g = 0; g < tiles.faces.length; g++) {
      if (g === 1) continue;
      expect(out.faces.at(g).id).toBe(tiles.faces.at(g).id);
      expect(out.faces.at(g).area).toBeCloseTo(tiles.faces.at(g).area, 9);
    }
  });

  it('replaces a kept curved neighbour in a later call: a point on its wall is not a corner', () => {
    const t = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) });
    const tiles = t.tiling(7, 3, { depth: 2 });
    const model = [...tiles.faces.at(0).points.filter((p) => p.corner)].map((p) => [p.x, p.y] as [number, number]);
    // The model heptagon cut through the points a third and two thirds
    // along each wall, on the geodesic: three triangles a wall.
    const at = (s: number) => model.map((a, k) => {
      const d = t.space.log(a, model[(k + 1) % 7]);
      return t.space.exp(a, [d[0] * s, d[1] * s]) as [number, number];
    });
    const c = t.space.center;
    const faces = model.flatMap((_, k) => [[0, 1 + k, 8 + k], [0, 8 + k, 15 + k], [0, 15 + k, 1 + ((k + 1) % 7)]]);
    const motif = material([[c[0], c[1]], ...model, ...at(1 / 3), ...at(2 / 3)], { faces });
    expect(tiles.faces.at(1).adjacent.has(tiles.faces.at(0))).toBe(true);
    const first = tiles.replace(tiles.faces.at(1), motif);
    // Face 0 kept its face, run through the two new points on the wall it
    // shares: they run straight on for it.
    const wall = first.points.filter((p) => p.index >= tiles.n && p.corner === 1 && first.faces.at(0).points.has(p));
    expect(wall.length).toBe(2);
    const second = first.replace(first.faces.at(0), motif);
    expect(second.faces.filter((f) => f.parent?.index === 0).length).toBe(21);
    // Welded: the second call adds the centre and twelve wall points, and
    // the two on the shared wall are the first call's.
    expect(second.points.filter((p) => p.index >= first.n && p.corner === 1).length).toBe(13);
    for (const p of wall) expect(second.points.filter((q) => near([q.x, q.y], [p.x, p.y], 1e-9)).length).toBe(1);
  });

  it('replaces a kept square in a later call: the point a neighbour put on its wall is not a corner', () => {
    const two = material([[0, 0], [10, 0], [20, 0], [20, 10], [10, 10], [0, 10]], { faces: [[0, 1, 4, 5], [1, 2, 3, 4]] });
    const quarters = material([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5], [0.5, 0.5]], {
      faces: [[0, 4, 8, 7], [4, 1, 5, 8], [8, 5, 2, 6], [7, 8, 6, 3]],
    });
    const first = two.replace(two.faces.at(0), quarters);
    expect(first.faces.at(1).corners.length).toBe(5);
    const second = first.replace(first.faces.at(1), quarters);
    expect(second.faces.filter((f) => f.parent?.index === 1).length).toBe(4);
    expect(second.n).toBe(6 + 5 + 4);
    expect(second.points.filter((p) => near([p.x, p.y], [10, 5])).length).toBe(1);
    expect(second.faces.filter((f) => f.leaf).every((f) => Math.abs(f.area - 25) < 1e-9)).toBe(true);
  });

  it('refuses a face without a placement in a curved space, by name', () => {
    const t = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) });
    const tiles = t.tiling(7, 3, { depth: 1 });
    // A split changes the edges: the faces are read off the picture again.
    const drawn = tiles.split(tiles.edges.at(0));
    const motif = material([[0, 0], [1, 0], [0.5, 1]], { faces: [[0, 1, 2]] });
    expect(() => drawn.replace(drawn.faces, motif)).toThrow('replace: a face in a curved space takes a motif through its source placement, and this face has none');
  });

  it('leaves the cells the drawable cut, and refuses a motif that no cell takes', () => {
    const t = toolkit({ aspect: [1, 1] });
    const side = 20;
    const tiles = t.tiling(6, 3, { side });
    const at = (k: number): [number, number] => [side * Math.cos((k * Math.PI) / 3), side * Math.sin((k * Math.PI) / 3)];
    const hexagon = material([[0, 0], ...[0, 1, 2, 3, 4, 5].map(at)], { faces: [0, 1, 2, 3, 4, 5].map((k) => [0, k + 1, ((k + 1) % 6) + 1]) });
    const out = tiles.replace(tiles.faces, hexagon);
    const whole = out.faces.filter((f) => !f.leaf);
    expect(whole.length).toBeGreaterThan(0);
    expect(whole.length).toBeLessThan(tiles.faces.length);
    for (const f of whole) expect(f.children.length).toBe(6);
    const square = material([[0, 0], [1, 0], [1, 1], [0, 1]], { faces: [[0, 1, 2, 3]] });
    expect(() => tiles.replace(tiles.faces, square)).toThrow("replace: the motif's outline has 4 corners and this face has 6");
  });

  it('refuses options, which are the edge form\'s', () => {
    const g = rhomb();
    // @ts-expect-error the face form takes no options
    expect(() => g.replace(g.faces, sierpinski(), { flip: true })).toThrow('replace: a face takes no options');
  });
});

// ---- Penrose: Robinson's half-rhombs ------------------------------------------------

const phi = (1 + Math.sqrt(5)) / 2;
type P = [number, number];
const mix = (p: P, q: P, s: number): P => [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];
const turns = (p: P, q: P, r: P) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
interface Half { kind: string; hand: string; loop: P[] }
const half = (kind: string, a: P, b: P, c: P): Half => (turns(a, b, c) > 0 ? { kind, hand: 'left', loop: [a, b, c] } : { kind, hand: 'right', loop: [a, c, b] });
function build(halves: Half[]): Material {
  const pts: P[] = [];
  const index = (p: P) => {
    const at = pts.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9);
    return at >= 0 ? at : pts.push(p) - 1;
  };
  const loops = halves.map((x) => x.loop.map(index));
  const bases = new Set(loops.map((l) => [l[1], l[2]].sort().join()));
  return material(pts, { faces: loops })
    .faces.set({ kind: (f: Face) => halves[f.index].kind, hand: (f: Face) => halves[f.index].hand })
    .edges.set('base', (e) => (bases.has([e.a.index, e.b.index].sort().join()) ? 1 : 0));
}
function cut(kind: string, hand: string): Material {
  const turn = kind === 'thin' ? Math.PI / 5 : (3 * Math.PI) / 5;
  const far: P = [Math.cos(turn), Math.sin(turn)];
  const [A, B, C]: P[] = hand === 'left' ? [[0, 0], [1, 0], far] : [[0, 0], far, [1, 0]];
  if (kind === 'thin') {
    const Pp = mix(A, B, 1 / phi);
    return build([half('thin', C, Pp, B), half('thick', Pp, C, A)]);
  }
  const Q = mix(B, A, 1 / phi);
  const R = mix(B, C, 1 / phi);
  return build([half('thick', R, C, A), half('thick', Q, R, B), half('thin', R, Q, A)]);
}

describe('replace on faces: the Penrose rhomb inflation', () => {
  it('makes only the two half-rhombs, in Robinson\'s counts, and every base pairs', () => {
    const motifs = ['thin', 'thick'].flatMap((kind) => ['left', 'right'].map((hand) => ({ kind, hand, motif: cut(kind, hand) })));
    const at = (k: number): P => [50 + 40 * Math.cos((k * Math.PI) / 10), 50 + 40 * Math.sin((k * Math.PI) / 10)];
    const c: P = [50, 50];
    let g = build(Array.from({ length: 10 }, (_, i) => (i % 2 ? half('thin', c, at(2 * i - 1), at(2 * i + 1)) : half('thin', c, at(2 * i + 1), at(2 * i - 1)))));
    let [thin, thick] = [10, 0];
    for (let step = 0; step < 4; step++) {
      const leaves = g.faces.filter((f) => f.leaf);
      g = motifs.reduce((m, { kind, hand, motif }) => m.replace(leaves.filter((f) => f.kind === kind && f.hand === hand), motif), g);
      [thin, thick] = [thin + thick, thin + 2 * thick];
      const now = g.faces.filter((f) => f.leaf);
      expect([now.filter((f) => f.kind === 'thin').length, now.filter((f) => f.kind === 'thick').length]).toEqual([thin, thick]);
    }
    const leaves = g.faces.filter((f) => f.leaf);
    for (const f of leaves) {
      // One base, the side between the corners after the apex: its share
      // of the perimeter is the half's own.
      const r = f.kind === 'thin' ? 1 / phi : phi;
      const base = f.boundaryEdges.filter((e) => e.base).map((e) => e.length).reduce((a, b) => a + b, 0);
      expect(base / f.perimeter).toBeCloseTo(r / (2 + r), 9);
    }
    // A base inside the tiling has the two halves of one rhomb on its sides.
    for (const e of g.edges.filter((x) => x.base)) {
      const sides = e.faces;
      if (sides.length === 2) expect(sides.at(0).kind).toBe(sides.at(1).kind);
    }
  });
});

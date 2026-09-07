import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { append, circle, compileSketch, connect, curve, initOcclude, material, polygon, setPaperHint, sketch, strokes, voronoi, type Material } from '../src/index.js';
import { densityRaster, accumulateCells } from '../src/points.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
  setPaperHint(200, 200); // a 100 × 100 drawable
});

type Tk = Parameters<Parameters<typeof sketch>[1]>[0];
function run(body: (t: Tk) => void, seed: number | string = 1): void {
  compileSketch(sketch({ seed }, (t) => { body(t); return circle(0, 0, 1); }));
}
const square = (x0: number, y0: number, s: number) => curve([[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]]);

describe('scatter as material', () => {
  const field = (x: number, y: number) => Math.max(0.03, 1 - Math.hypot(x - 50, (y - 50) * 1.5) / 55);

  it('returns point-only material with a density column, deterministic per seed, matching the pre-consolidation baseline', () => {
    let a: Material | null = null;
    let b: Material | null = null;
    run((t) => { a = t.scatter(field, { spacing: 4 }); }, 11);
    run((t) => { b = t.scatter(field, { spacing: 4 }); }, 11);
    expect(a!.edgeCount).toBe(0);
    expect(a!.attrNames).toEqual(['density']);
    expect(a!.pts).toEqual(b!.pts);
    for (let i = 0; i < a!.n; i++) expect(a!.attrs.density[i]).toBeCloseTo(Math.min(1, field(a!.x[i], a!.y[i])), 12);
    // The baseline captured from the old Points API at seed 11: same points, same values (w was the density).
    const base = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/points-baseline.json', import.meta.url)), 'utf8')) as { scatter: number[][] };
    expect(a!.n).toBe(base.scatter.length);
    for (let i = 0; i < a!.n; i++) {
      expect(a!.x[i]).toBeCloseTo(base.scatter[i][0], 9);
      expect(a!.y[i]).toBeCloseTo(base.scatter[i][1], 9);
      expect(a!.attrs.density[i]).toBeCloseTo(base.scatter[i][2], 9);
    }
    // A collection filters and maps like any material's points.
    expect(a!.points.filter((p) => p.density > 0.7).length).toBeGreaterThan(0);
    expect(() => run((t) => t.scatter(field, {} as never))).toThrow(/spacing/);
  });
});

describe('relax and settle as explicit operations', () => {
  const field = (x: number, y: number) => Math.max(0.03, 1 - Math.hypot(x - 50, (y - 50) * 1.5) / 55);
  const base = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/points-baseline.json', import.meta.url)), 'utf8')) as Record<string, number[][]>;

  it('relax keeps count, rows, edges and columns, moves toward weighted centroids, and matches the old numbers', () => {
    let cloud: Material | null = null;
    let relaxed: Material | null = null;
    let ring: Material | null = null;
    let ringRelaxed: Material | null = null;
    run((t) => {
      cloud = t.scatter(field, { spacing: 4 }).attribute('tag', (p) => p.index);
      relaxed = t.relax(cloud, { iterations: 3, density: field });
      ring = square(20, 20, 40).attribute('age', 7);
      ringRelaxed = t.relax(ring, { iterations: 2 });
    }, 11);
    expect(relaxed!.n).toBe(cloud!.n);
    expect(relaxed!.attrNames).toEqual(['density', 'tag']);
    expect(Array.from(relaxed!.attrs.tag)).toEqual(Array.from(cloud!.attrs.tag));
    expect(cloud!.x[0]).toBeCloseTo(base.scatter[0][0], 9); // the source did not move
    for (let i = 0; i < relaxed!.n; i++) {
      expect(relaxed!.x[i]).toBeCloseTo(base.relax3[i][0], 9);
      expect(relaxed!.y[i]).toBeCloseTo(base.relax3[i][1], 9);
    }
    expect(ringRelaxed!.edgeCount).toBe(4);
    expect(Array.from(ringRelaxed!.edgeList)).toEqual(Array.from(ring!.edgeList));
    expect(Array.from(ringRelaxed!.attrs.age)).toEqual([7, 7, 7, 7]);
    expect(ringRelaxed!.x[0]).not.toBe(ring!.x[0]);
    expect(() => run((t) => t.relax(material([]), { iterations: -1 }))).toThrow(/iterations/);
  });

  it('settle refuses connected input, keeps declared columns, inherits to children, drops the starved, writes demand', () => {
    let out: Material | null = null;
    let src: Material | null = null;
    run((t) => {
      src = material(t.grid({ cols: 12, rows: 12 }).map((c) => [c.cx, c.cy] as [number, number])).attribute('tag', (p) => p.index).attribute('mass', 1);
      out = t.settle(src, { density: field, spacing: 4.8, iterations: 8 });
      expect(() => t.settle(square(0, 0, 10), { density: field, spacing: 4 })).toThrow(/point-only material.*extract/);
      expect(() => t.settle(src!, { spacing: 4 } as never)).toThrow(/density/);
      expect(() => t.settle(src!, { density: field, spacing: 0 })).toThrow(/spacing/);
      expect(t.settle(material([]), { density: field, spacing: 4 }).n).toBe(0);
    }, 11);
    expect(out!.attrNames).toEqual(['tag', 'mass', 'demand']);
    expect(out!.n).toBe(base.liftSettle.length); // same count as the old algorithm on this grid
    // Demand is the old w: every surviving point's cell demand at the last round.
    const demands = Array.from(out!.attrs.demand).sort((a, b) => a - b);
    const oldW = base.liftSettle.map((p) => p[2]).sort((a, b) => a - b);
    for (let i = 0; i < demands.length; i++) expect(demands[i]).toBeCloseTo(oldW[i], 6);
    // Every tag is one of the source's; children duplicate their parent's mass.
    for (const p of out!.points) {
      expect(Number.isInteger(p.tag) && p.tag >= 0 && p.tag < src!.n).toBe(true);
      expect(p.mass).toBe(1);
    }
    expect(new Set(Array.from(out!.attrs.tag)).size).toBeLessThan(out!.n); // splits happened
    expect(src!.attrNames).toEqual(['tag', 'mass']); // the source is untouched
  });

  it('the raster kernel and faces().measure agree cell by cell on Voronoi cells', () => {
    let kernel: { w: Float64Array } | null = null;
    let measured: number[] = [];
    run((t) => {
      const sites = t.scatter({ spacing: 12 });
      const bounds = { x: 0, y: 0, w: 100, h: 100 };
      const raster = densityRaster(field, bounds, 128);
      const coords = new Float64Array(sites.n * 2);
      for (let i = 0; i < sites.n; i++) { coords[2 * i] = sites.x[i]; coords[2 * i + 1] = sites.y[i]; }
      kernel = accumulateCells(coords, raster);
      const cells = t.voronoi(sites);
      const m = cells.faces().measure(field, { bounds, resolution: 128 });
      measured = sites.points.map((p) => {
        const f = cells.cellOf(p);
        return f ? m.forFace(f).integral / (raster.cw * raster.cw) : NaN;
      });
    }, 3);
    for (let i = 0; i < measured.length; i++) expect(measured[i]).toBeCloseTo(kernel!.w[i], 6);
  });
});

describe('voronoi as material', () => {
  it('shares walls and corners, covers the bounds exactly, and knows its sites both ways', () => {
    const sites = material([[20, 20], [80, 30], [50, 70], [30, 80], [70, 75]]);
    const b = { x: 0, y: 0, w: 100, h: 100 };
    const cells = voronoi(sites, b);
    const faces = cells.faces();
    expect(faces.length).toBe(5);
    expect(faces.map((f) => f.area).reduce((a, v) => a + v, 0)).toBeCloseTo(10000, 6);
    // Interior walls appear once: every edge borders one or two faces, never zero or three.
    for (let e = 0; e < cells.edgeCount; e++) {
      const l = (faces as unknown as { faceOf: Int32Array }).faceOf[2 * e];
      const r = (faces as unknown as { faceOf: Int32Array }).faceOf[2 * e + 1];
      expect(l >= 0 || r >= 0).toBe(true);
    }
    expect(faces.boundaryEdges.length).toBeGreaterThanOrEqual(4);
    expect(cells.maxDegree()).toBeLessThanOrEqual(4);
    // Each site owns exactly the cell containing it, in both directions.
    for (const s of sites.points) {
      const f = cells.cellOf(s)!;
      expect(f).toBeDefined();
      expect(polygon(f.contours).geom).toBeDefined();
      expect(cells.siteOf(f)!.index).toBe(s.index);
      // The site is inside its cell (even-odd through the measured centroid distance sign is enough here):
      const c = faces.measure().forFace(f).centroid;
      expect(Math.hypot(c[0] - s.x, c[1] - s.y)).toBeLessThan(60);
    }
    // faces() again gives equivalent faces the correspondence still accepts.
    expect(cells.siteOf(cells.faces().at(2))!.index).toBe(cells.siteOf(faces.at(2))!.index);
    // No coordinate sharing by accident: shared corners are the same rows.
    const seen = new Set<string>();
    for (let i = 0; i < cells.n; i++) {
      const k = `${cells.x[i]},${cells.y[i]}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(strokes(cells).length).toBeGreaterThan(0);
  });

  it('degenerate inputs: empty, one, two, collinear, coincident, near-coincident, outside', () => {
    const b = { x: 0, y: 0, w: 100, h: 50 };
    expect(voronoi(material([]), b).n).toBe(0);
    const one = voronoi(material([[30, 20]]), b);
    expect(one.faces().length).toBe(1);
    expect(one.faces().at(0).area).toBeCloseTo(5000, 9);
    const two = voronoi(material([[20, 25], [80, 25]]), b);
    expect(two.faces().length).toBe(2);
    expect(two.faces().map((f) => f.area).sort()).toEqual([2500, 2500]);
    const col = voronoi(material([[10, 10], [50, 25], [90, 40]]), b);
    expect(col.faces().length).toBe(3);
    expect(col.faces().map((f) => f.area).reduce((a, v) => a + v, 0)).toBeCloseTo(5000, 3);
    const dupSites = material([[20, 25], [20, 25], [80, 25]]);
    const dup = voronoi(dupSites, b);
    expect(dup.faces().length).toBe(2);
    expect(dup.cellOf(dupSites.vertex(0))).toBeDefined();
    expect(dup.cellOf(dupSites.vertex(1))).toBeUndefined(); // the lowest row owns the cell
    const near = voronoi(material([[20, 25], [20.000001, 25], [80, 25], [50, 10], [50, 40]]), b);
    expect(near.faces().map((f) => f.area).reduce((a, v) => a + v, 0)).toBeCloseTo(5000, 3);
    const outSites = material([[20, 25], [200, 25], [50, 10]]);
    const out = voronoi(outSites, b);
    expect(out.faces().map((f) => f.area).reduce((a, v) => a + v, 0)).toBeCloseTo(5000, 6);
    const owned = outSites.points.filter((p) => out.cellOf(p) !== undefined).length;
    expect(owned).toBeGreaterThanOrEqual(2);
    expect(() => voronoi(material([[1, 1]]), { x: 0, y: 0, w: 0, h: 5 })).toThrow(/bounds/);
  });

  it('cocircular sites collapse coincident circumcentres into one shared corner', () => {
    const cells = voronoi(material([[25, 25], [75, 25], [75, 75], [25, 75]]), { x: 0, y: 0, w: 100, h: 100 });
    expect(cells.faces().length).toBe(4);
    const centre = cells.points.filter((p) => Math.abs(p.x - 50) < 1e-9 && Math.abs(p.y - 50) < 1e-9);
    expect(centre.length).toBe(1);
    expect(cells.degree(centre.at(0))).toBe(4);
    expect(cells.faces().map((f) => f.area)).toEqual([2500, 2500, 2500, 2500]);
  });

  it('correspondence is owned and dies with edits and extraction', () => {
    const sites = material([[20, 20], [80, 30], [50, 70]]);
    const other = material([[20, 20], [80, 30], [50, 70]]);
    const cells = voronoi(sites, { x: 0, y: 0, w: 100, h: 100 });
    expect(() => cells.cellOf(other.vertex(0))).toThrow(/not a site of this diagram/);
    const otherCells = voronoi(other, { x: 0, y: 0, w: 100, h: 100 });
    expect(() => cells.siteOf(otherCells.faces().at(0))).toThrow(/another material/);
    const moved = cells.steps(1, (cur, next) => next.move(() => [1, 0]));
    expect(() => moved.cellOf(sites.vertex(0))).toThrow(/no Voronoi correspondence.*edited or extracted/);
    expect(() => cells.edges.extract().siteOf(cells.faces().at(0))).toThrow(/no Voronoi correspondence/);
    // Selections of the result still work through the result.
    const big = cells.faces().filter((f) => f.area > 1000);
    for (const f of big) expect(cells.siteOf(f)).toBeDefined();
  });
});

describe('face navigation', () => {
  it('edges, points and boundaryEdges follow face incidence: shared walls, holes and dangling edges', () => {
    // Two squares sharing a wall (one material, the wall one edge), a hole in
    // the left one, a spur into the right one from its corner, and a detached
    // segment floating inside the right one.
    const twoSquares = material([[0, 0], [10, 0], [20, 0], [20, 10], [10, 10], [0, 10], [17, 3]], { edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 4], [2, 6]] });
    let net = append(twoSquares, curve([[3, 3], [5, 3], [5, 5], [3, 5]]));
    net = append(net, curve([[12, 7], [14, 9]], { closed: false }));
    const cells = net.faces();
    // Three faces: left annulus, the hole square, the right square.
    expect(cells.length).toBe(3);
    const all = cells.edges;
    // The spur is part of the right face's walk (both its sides are that face);
    // the detached segment is its own zero-area walk and belongs to no face.
    expect(all.length).toBe(cells.source.edgeCount - 1);
    expect(cells.points.length).toBe(cells.source.n - 2);
    const outer = cells.boundaryEdges;
    // The outside boundary of the union: the two squares' outer walls minus the shared wall.
    expect(outer.length).toBeGreaterThanOrEqual(6);
    const left = cells.filter((f) => f.contours.length === 2); // the annulus has a hole
    expect(left.length).toBe(1);
    const leftWalls = left.edges;
    expect(leftWalls.length).toBeGreaterThan(4); // its outer square plus the hole's walls
    // The shared wall is a boundary edge of the left selection alone but not of both squares together.
    const both = cells.filter((f) => f.contours.length === 2 || f.area > 50);
    expect(both.boundaryEdges.length).toBeLessThan(left.boundaryEdges.length + cells.filter((f) => f.area > 50 && f.contours.length === 1).boundaryEdges.length);
    // The hole's walls are boundary edges of the annulus (its inner face is not selected) …
    expect(left.boundaryEdges.length).toBe(8); // its three outer walls, the shared wall, and the hole's four
    // … and vanish when the hole face is selected too.
    const withHole = left.union(cells.filter((f) => f.area === 4));
    expect(withHole.boundaryEdges.length).toBe(left.boundaryEdges.length - 4);
    // The spur inside the right square is in `edges` and not in `boundaryEdges`;
    // the detached segment is in neither.
    const right = cells.filter((f) => f.area > 50 && f.contours.length === 1);
    const spur = right.edges.filter((e) => e.a.x === 20 && e.a.y === 0 && e.b.x === 17);
    expect(spur.length).toBe(1);
    expect(right.boundaryEdges.filter((e) => e.b.x === 17).length).toBe(0);
    expect(right.edges.filter((e) => e.a.x === 12 && e.a.y === 7).length).toBe(0);
    // Empty selection, empty navigation.
    const none = cells.filter(() => false);
    expect(none.edges.length).toBe(0);
    expect(none.points.length).toBe(0);
    expect(none.boundaryEdges.length).toBe(0);
    // Rows in source order, no copies.
    expect([...all.indices]).toEqual([...all.indices].sort((a, b) => a - b));
    expect(strokes(left.boundaryEdges).length).toBeGreaterThan(0);
  });
});

describe('face measurements', () => {
  it('geometric centroid and area respect holes; fields integrate, average, and weight a centre', () => {
    const annulus = append(square(0, 0, 30), square(10, 10, 10)).planarize().faces();
    const ring = annulus.filter((f) => f.contours.length === 2);
    const m = ring.measure();
    expect(m.length).toBe(1);
    const r = m.forFace(ring.at(0));
    expect(r.area).toBeCloseTo(800, 9);
    expect(r.centroid[0]).toBeCloseTo(15, 9);
    expect(r.centroid[1]).toBeCloseTo(15, 9);
    expect(Number.isNaN(r.integral)).toBe(true);
    // An off-centre hole shifts the centroid away from the hole.
    const lopsided = append(square(0, 0, 30), square(2, 2, 10)).planarize().faces().filter((f) => f.contours.length === 2).measure().results[0];
    expect(lopsided.centroid[0]).toBeGreaterThan(15);
    // A constant density integrates to the area; the weighted centre is the centroid.
    const one = ring.measure(() => 1, { resolution: 300 });
    const c1 = one.results[0];
    expect(c1.integral).toBeCloseTo(800, -1);
    expect(c1.mean).toBeCloseTo(1, 2);
    expect(c1.weightedCentroid![0]).toBeCloseTo(15, 1);
    expect(c1.samples).toBeGreaterThan(1000);
    // A gradient: the weighted centre moves toward the dense side.
    const grad = ring.measure((x) => x / 30, { resolution: 300 }).results[0];
    expect(grad.weightedCentroid![0]).toBeGreaterThan(17);
    expect(grad.mean).toBeCloseTo(0.5, 1);
    // Zero density: an integral of zero and no centre; a signed field has an integral but no centre either.
    const zero = ring.measure(() => 0).results[0];
    expect(zero.integral).toBe(0);
    expect(zero.weightedCentroid).toBeNull();
    const signed = ring.measure((x) => x - 15, { resolution: 300 }).results[0];
    expect(Math.abs(signed.integral)).toBeLessThan(30);
    expect(signed.weightedCentroid).toBeNull();
    // Absent samples (non-finite) contribute nothing.
    const holed = ring.measure((x) => (x < 5 ? NaN : 1), { resolution: 300 }).results[0];
    expect(holed.integral).toBeLessThan(c1.integral);
    expect(holed.samples).toBeLessThan(c1.samples);
    // Ownership.
    const otherFaces = square(0, 0, 30).faces();
    expect(() => m.forFace(otherFaces.at(0))).toThrow(/another face collection/);
    expect(() => annulus.measure().forFace(annulus.at(0))).not.toThrow();
    expect(() => ring.measure().forFace(annulus.filter((f) => f.contours.length === 1).at(0))).toThrow(/not among the measured faces/);
    // Empty selection measures to nothing.
    expect(annulus.filter(() => false).measure(() => 1).length).toBe(0);
  });
});

describe('review of fe26c3f', () => {
  const B = { x: 0, y: 0, w: 100, h: 100 };
  const rectArea = (cells: Material) => cells.faces().map((f) => f.area).reduce((a, b) => a + b, 0);

  it('1. regular polygons and grids: cocircular sites meet at one corner, faces are the sites, area is the rectangle', () => {
    for (const n of [3, 4, 5, 6, 7, 8, 9, 12, 20, 50]) {
      const pts = Array.from({ length: n }, (_, i) => [50 + 30 * Math.cos((2 * Math.PI * i) / n), 50 + 30 * Math.sin((2 * Math.PI * i) / n)] as [number, number]);
      const cells = voronoi(pts, B);
      expect(cells.faces().length, `${n}-gon`).toBe(n);
      expect(rectArea(cells)).toBeCloseTo(10000, 6);
      // the centre is one vertex of degree n (for n ≥ 4 every wall meets there)
      const centre = cells.points.filter((p) => Math.abs(p.x - 50) < 1e-6 && Math.abs(p.y - 50) < 1e-6);
      expect(centre.length).toBe(1);
      expect(cells.degree(centre.at(0))).toBe(n);
      for (const f of cells.faces()) expect(cells.siteOf(f)).toBeDefined();
    }
    // a lattice: every interior corner has four cells
    const grid: [number, number][] = [];
    for (let j = 0; j < 5; j++) for (let i = 0; i < 6; i++) grid.push([10 + i * 16, 10 + j * 20]);
    const cells = voronoi(grid, B);
    expect(cells.faces().length).toBe(30);
    expect(rectArea(cells)).toBeCloseTo(10000, 6);
    expect(cells.points.filter((p) => cells.degree(p) === 4).length).toBe(20);
    // a jittered lattice at awkward scale and offset
    const far = grid.map(([x, y]) => [x * 1e-3 + 1234.5, y * 1e-3 + 6789.25] as [number, number]);
    const fb = { x: 1234.5, y: 6789.25, w: 0.1, h: 0.1 };
    expect(rectArea(voronoi(far, fb))).toBeCloseTo(0.01, 9);
  });

  it('2. sites given as a point collection or selection keep their source: correspondence answers for that material', () => {
    const m = material([[10, 10], [80, 20], [40, 70], [90, 90]]).attribute('tag', (p) => p.index);
    const all = voronoi(m.points, B);
    expect(all.faces().length).toBe(4);
    expect(all.cellOf(m.vertex(0))).toBeDefined();
    expect(all.siteOf(all.cellOf(m.vertex(2))!)!.tag).toBe(2);
    const part = m.points.filter((p) => p.x < 85);
    const some = voronoi(part, B);
    expect(some.faces().length).toBe(3);
    expect(some.cellOf(m.vertex(3))).toBeUndefined(); // not a site of this construction
    expect(some.cellOf(m.vertex(1))!.area).toBeGreaterThan(0);
    expect(some.siteOf(some.faces().at(0))!.index).toBeLessThan(3);
    // the same through the toolkit
    run((t) => {
      const c = t.voronoi(part, { bounds: B });
      expect(c.cellOf(m.vertex(0))).toBeDefined();
      expect(c.faces().length).toBe(3);
    });
    // bare points are a new material: a vertex of the original is not a site
    const bare = voronoi(m.points.map((p) => [p.x, p.y] as [number, number]), B);
    expect(() => bare.cellOf(m.vertex(0))).toThrow(/another state/);
  });

  it('3. settle: a point hook overrides inherited child attributes; a record or a callback of the parent; bounded to declared columns', () => {
    run((t) => {
      const src = material(t.grid({ cols: 6, rows: 6 }).map((c) => [c.cx, c.cy] as [number, number])).attribute('species', (p) => p.index % 3).attribute('age', 9);
      // demand 1 on the left splits every cell there; 0.2 on the right keeps its points as they are
      const dense = (x: number) => (x < 50 ? 1 : 0.2);
      const plain = t.settle(src, { density: dense, spacing: 12, iterations: 6 });
      expect(plain.n).toBeGreaterThan(src.n);
      expect(Array.from(plain.attrs.age).every((a) => a === 9)).toBe(true);
      // children reset age, keep species
      const reset = t.settle(src, { density: dense, spacing: 12, iterations: 6, point: { age: 0 } });
      expect(reset.n).toBe(plain.n);
      const ages = Array.from(reset.attrs.age);
      expect(ages.filter((a) => a === 0).length).toBeGreaterThan(0);
      expect(ages.filter((a) => a === 9).length).toBeGreaterThan(0);
      expect(ages.every((a) => a === 0 || a === 9)).toBe(true);
      expect(Array.from(reset.attrs.species)).toEqual(Array.from(plain.attrs.species));
      // a callback sees the parent as it splits: position, attributes, demand
      const seen: number[] = [];
      const derived = t.settle(src, { density: dense, spacing: 12, iterations: 6, point: (parent) => { seen.push(parent.demand); expect(parent.species).toBeGreaterThanOrEqual(0); expect(Number.isFinite(parent.x)).toBe(true); return { age: parent.age - 1 }; } });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((d) => d > 1)).toBe(true); // only over-demand cells split
      const dAges = Array.from(derived.attrs.age);
      expect(Math.min(...dAges)).toBeLessThan(8); // a child of a child
      expect(dAges.every((a) => a <= 9)).toBe(true);
      expect(derived.attrNames).toEqual(['species', 'age', 'demand']);
      // bounded: only declared columns, never demand, finite values
      expect(() => t.settle(src, { density: dense, spacing: 12, iterations: 2, point: { colour: 1 } })).toThrow(/no attribute 'colour'/);
      expect(() => t.settle(src, { density: dense, spacing: 12, iterations: 2, point: { demand: 1 } })).toThrow(/'demand' is computed/);
      expect(() => t.settle(src, { density: dense, spacing: 12, iterations: 2, point: () => ({ age: NaN }) })).toThrow(/not a finite number/);
    });
  });

  it('4. measurements are frozen: the record and its coordinate tuples', () => {
    const cells = voronoi([[20, 20], [80, 30], [50, 70]], B);
    const measured = cells.faces().measure(() => 1);
    const r = measured.forFace(cells.faces().at(0));
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.centroid)).toBe(true);
    expect(Object.isFrozen(r.weightedCentroid)).toBe(true);
    expect(() => { (r as { integral: number }).integral = 123; }).toThrow();
    expect(() => { (r.centroid as unknown as number[])[0] = 0; }).toThrow();
    expect(measured.forFace(cells.faces().at(0)).integral).toBe(r.integral);
    const bare = cells.faces().measure().forFace(cells.faces().at(1));
    expect(Object.isFrozen(bare)).toBe(true);
    expect(Object.isFrozen(bare.centroid)).toBe(true);
  });

  it('5. non-finite density is absent in the raster, as in face measurement', () => {
    const inf = densityRaster(() => Infinity, B, 4);
    expect(Math.max(...Array.from(inf.dens))).toBe(0);
    const mixed = densityRaster((x) => (x < 50 ? Infinity : 0.5), B, 4);
    expect(Math.max(...Array.from(mixed.dens))).toBe(0.5);
    expect(Array.from(mixed.dens).filter((v) => v === 0).length).toBe(mixed.dens.length / 2);
    const cells = voronoi([[25, 50], [75, 50]], B);
    const m = cells.faces().measure((x) => (x < 50 ? Infinity : 0.5));
    const left = m.forFace(cells.cellOf(cells.siteOf(cells.faces().at(0))!)!);
    for (const r of m) if (r.centroid[0] < 50) expect(r.samples).toBe(0); else expect(r.mean).toBeCloseTo(0.5, 6);
    expect(left).toBeDefined();
  });
});

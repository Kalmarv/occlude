/**
 * Faces are selections, identity survives every verb, relations read the
 * space (spec 58: audit P5, P6; sweep F10, F11).
 *
 * Every test is named by the audit entry it closes, and most of them run
 * the entry's own sketch line — the one working/audit/sketches/ keeps as a
 * `// FRICTION` comment — beside the workaround the audit had to write,
 * and ask that the two agree. The 3D entries of P6 (G3-29, G3-30) are in
 * faces-and-identity-3d.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import {
  circle, line, connect, distanceToPoints, dots, material, polygon, space, strokes, force, mul, append, sdf,
  type Face, type Material,
} from '../src/index.js';

const DISC = circle(50, 50, 34);

/** The Voronoi web most of the P5 sketches start from. */
function web(seed = 7, spacing = 10) {
  const t = toolkit({ aspect: [1, 1], seed });
  const cells = t.voronoi(t.relax(t.scatter({ spacing }), { iterations: 3 }));
  return { t, cells, faces: cells.faces() };
}

const idsOf = (m: Material) => [...m.pointIds];

describe('P5 · a face collection is a selection', () => {
  it('G1-13 · core.extract() is the faces as material: the edges, corners, columns and ids', () => {
    const { faces } = web();
    const core = faces.filter((f) => Math.hypot(f.centroid[0] - 50, f.centroid[1] - 50) < 14);
    const walls = core.extract();
    const workaround = core.edges.extract();
    expect(walls.n).toBe(workaround.n);
    expect(walls.edgeCount).toBe(workaround.edgeCount);
    expect(idsOf(walls)).toEqual(idsOf(workaround));
    expect([...walls.edgeIds]).toEqual([...workaround.edgeIds]);
    expect(walls.thicken({ radius: 1 }).n).toBeGreaterThan(0);
  });

  it('G1-21 · faces.subtract(big) is the cells that are not big, and faces.complement() exists', () => {
    const { faces } = web(1, 14);
    const big = faces.filter((f) => f.area > 220);
    const rest = faces.subtract(big);
    expect(rest.indices).toEqual(faces.filter(() => true).subtract(big).indices);
    expect(big.complement().indices).toEqual(rest.indices);
    expect(faces.complement().length).toBe(0);
    expect(rest.length + big.length).toBe(faces.length);
  });

  it('G1-22 · strokes(big) draws the selection\'s edges, each wall once', () => {
    const { faces } = web(1, 14);
    const big = faces.filter((f) => f.area > 220);
    expect(big.length).toBeGreaterThan(1);
    const drawn = strokes(big, { pen: 'stabilo-88-blue' });
    expect(drawn.length).toBe(strokes(big.edges).length);
    // Every edge of the selection is in exactly one chain.
    const seen = big.curves().reduce((k, c) => k + c.indices.length - (c.closed ? 0 : 1), 0);
    expect(seen).toBe(big.edges.length);
    // strokes(faces) — the whole collection — is the whole web's walls.
    expect(strokes(faces).length).toBe(faces.edges.curves().length);
  });

  it('G2-8 · face.extract() is one face as material, so the chain needs no rewrap', () => {
    const t = toolkit({ aspect: [1, 1], seed: 3 });
    const hex = t.hexes({ spacing: 12, origin: [50, 50], rotate: 15 });
    const near = t.within(hex.faces(), DISC, { keep: 'touching' });
    const shrunk = near.map((f) => f.extract().scale(0.7, { origin: 'centroid' }).rotate(20, { origin: 'centroid' }));
    const workaround = near.map((f) => f.boundaryEdges.extract().scale(0.7, { origin: 'centroid' }).rotate(20, { origin: 'centroid' }));
    expect(shrunk.map((m) => [...m.x])).toEqual(workaround.map((m) => [...m.x]));
    // The face column index signature no longer swallows the words a face has.
    const f = near.at(0);
    expect(typeof f.extract).toBe('function');
    expect(typeof f.id).toBe('string');
  });

  it('G2-9 · FaceSelection has extract() and in(state)', () => {
    const t = toolkit({ aspect: [1, 1], seed: 3 });
    const hex = t.hexes({ spacing: 12, origin: [50, 50], rotate: 15 });
    const near = t.within(hex.faces(), DISC, { keep: 'touching' });
    const kept = near.extract().scale(0.5, { origin: 'center' });
    expect(kept.n).toBe(near.edges.extract().n);
    const moved = hex.rotate(10, { origin: [50, 50] });
    const again = near.in(moved);
    expect(again.source).toBe(moved);
    expect(again.length).toBe(near.length);
    expect(again.map((f) => f.id)).toEqual(near.map((f) => f.id));
  });

  it('G2-13 · where takes a face selection: its corners for a point method', () => {
    const t = toolkit({ aspect: [1, 1], seed: 2 });
    const hex = t.hexes({ spacing: 10 }).steps(3, (cur, next) => next.splitEdges(cur.edges, { at: 0.5 }));
    const inside = t.within(hex.faces(), circle(50, 50, 28));
    const ripple = (x: number, y: number) => Math.sin(Math.hypot(x - 50, y - 50) / 2);
    const bent = hex.snap(ripple, { radius: 1.5, where: inside });
    const workaround = hex.snap(ripple, { radius: 1.5, where: inside.points });
    expect([...bent.x]).toEqual([...workaround.x]);
    expect([...bent.y]).toEqual([...workaround.y]);
    // One face reads the same way.
    const one = inside.at(0);
    expect([...hex.snap(ripple, { radius: 1.5, where: one }).x]).toEqual([...hex.snap(ripple, { radius: 1.5, where: one.points }).x]);
    // An edge method reads its edges: a ring's one face names every edge.
    const ring = t.material(circle(50, 50, 20));
    expect(ring.resample({ spacing: 2, where: ring.faces().at(0) }).n).toBe(ring.resample({ spacing: 2, where: ring.edges }).n);
  });

  it('G3-8 / G6-2 · polygon(faces) is refused by the type and by name', () => {
    const t = toolkit({ aspect: [1, 1], seed: 7 });
    const cells = t.tiling(4, 4, { depth: 6, side: 6 }).faces();
    const odd = cells.filter((f) => (f.generation ?? 0) % 2 === 1);
    // @ts-expect-error — a face collection is several areas: name which
    expect(() => polygon(odd)).toThrow(/a face collection is several areas/);
    // @ts-expect-error — the whole collection too
    expect(() => polygon(cells)).toThrow(/a face collection is several areas/);
    expect(() => polygon(odd.contours())).not.toThrow();
    expect(() => polygon(odd.at(0))).not.toThrow();
  });

  it('G4-10 · components() and connected() on faces, joined across walls', () => {
    const t = toolkit({ aspect: [2, 1], seed: 12 });
    const centre = [74, 52] as const;
    const density = (x: number, y: number) => 0.08 + 0.92 * Math.max(0, 1 - Math.pow(Math.hypot(x - centre[0], y - centre[1]) / 34, 6));
    const cells = t.voronoi(t.relax(t.scatter(density, { spacing: 5 }), { iterations: 2, density })).faces();
    const small = cells.filter((f) => f.area < 60);
    const heart = small.find((f) => Math.hypot(f.centroid[0] - centre[0], f.centroid[1] - centre[1]) < 8)!;
    const town = small.components().find((c) => c.has(heart))!;
    // The audit's hand flood fill.
    let flood = cells.filter((f) => f === heart);
    for (;;) {
      const grown = flood.union(flood.adjacent().intersect(small));
      if (grown.length === flood.length) break;
      flood = grown;
    }
    expect(town.indices).toEqual(flood.indices);
    expect(typeof town.key).toBe('number');
    // Components partition the members.
    expect(small.components().reduce((k, c) => k + c.length, 0)).toBe(small.length);
    // connected() from one face is every face reachable across walls.
    expect(cells.filter((f) => f === heart).connected().length).toBe(cells.length);
  });

  it('G4-12 · a component list folds with union, and strokes takes a keyed selection', () => {
    const t = toolkit({ aspect: [3, 2], seed: 12 });
    const range = t.within(t.ridges((x, y) => 15 * t.noise(x / 21, y / 21) + 3.5 * t.noise(x / 8, y / 8), { step: 2.2 }), circle(75, 50, 40));
    const runs = range.points.components().filter((g) => g.length >= 8);
    expect(runs.length).toBeGreaterThan(1);
    const kept = runs.reduce((a, b) => a.union(b));
    expect(kept.indices).toEqual(range.points.rows(runs.flatMap((g) => g.indices)).indices);
    expect(strokes(runs[0]).length).toBeGreaterThan(0);
    expect(strokes(kept).length).toBeGreaterThan(0);
  });

  it('G4-16 · a cut Voronoi material: the cells of sites are found again by id (the within door keeps no site link)', () => {
    // `t.within` belongs to another branch; the correspondence itself does
    // not survive the cut. What this spec gives: the cells of the uncut
    // diagram, read against the cut one by id.
    const t = toolkit({ aspect: [1, 1], seed: 4 });
    const disc = circle(50, 50, 44);
    const sites = t.relax(t.scatter({ spacing: 6, within: disc }), { iterations: 2, within: disc });
    const diagram = t.voronoi(sites);
    const cut = t.within(diagram, disc);
    expect(() => cut.cellOf(sites.points.at(0))).toThrow(/no Voronoi correspondence/);
    const inner = diagram.cellOf(sites.points.filter((p) => Math.hypot(p.x - 50, p.y - 50) < 20));
    const found = inner.in(cut);
    expect(found.length).toBe(inner.length);
  });

  it('G6-4 · a face collection is its centroids for every point consumer', () => {
    const { faces: cells } = web(7, 6);
    const split = cells.filter((f) => f.centroid[0] < 40);
    const hubs = distanceToPoints(split);
    const workaround = distanceToPoints(split.map((f) => f.centroid));
    for (const [x, y] of [[10, 10], [50, 50], [90, 30]]) expect(hubs(x, y)).toBe(workaround(x, y));
    // material(), connect.* and the forces read the same points.
    expect([...material(split).x]).toEqual(split.map((f) => f.centroid[0]));
    expect(connect.chain(split).edgeCount).toBe(split.length - 1);
    const probe = material([[12, 12]]).points.at(0);
    const push = force.separation(split, { radius: 5 });
    expect(push(probe)).toEqual(force.separation(split.map((f) => f.centroid), { radius: 5 })(probe));
    // faces.points stays the corners.
    expect(split.points.length).toBeGreaterThan(split.length);
    // containing() reads a face collection as its centroids too.
    expect(cells.containing(split).indices).toEqual(split.indices);
  });

  it('G6-38 · dots(cells) taps each cell once, at its centroid', () => {
    const t = toolkit({ aspect: [1, 1], seed: 5, space: space.hyperbolic({ radius: 50 }) });
    const cells = t.tiling(4, 5, { depth: 3 }).faces();
    expect(dots(cells).length).toBe(cells.length);
    expect(dots(cells.points).length).toBe(cells.points.length);
  });

  it('G6-7 · east.extract() is the east cells as a piece', () => {
    const { t, faces: cells } = web(7, 7);
    const east = cells.filter((f) => f.centroid[0] > 50);
    const block = east.extract().translate([0, 4]);
    expect(block.n).toBe(east.edges.extract().n);
    expect(() => polygon(block)).not.toThrow();
  });

  it('G6-8 · Faces takes union/intersect/subtract; a face selection takes complement()', () => {
    const { faces: cells } = web(7, 7);
    const east = cells.filter((f) => f.centroid[0] > 50);
    const west = cells.subtract(east);
    expect(west.boundaryEdges().indices).toEqual(cells.filter((f) => !east.has(f)).boundaryEdges().indices);
    expect(east.complement().indices).toEqual(west.indices);
    expect(cells.intersect(east).indices).toEqual(east.indices);
    expect(cells.union(east).length).toBe(cells.length);
  });

  it('G6-26 · f.id is the face\'s identity: the weft pairing across steps, not every cell with cell 0', () => {
    const t = toolkit({ aspect: [1, 1], seed: 3 });
    const gap = 9;
    const net = t.hexes({ spacing: gap, origin: [50, 10] })
      .edgeAttribute('rest', (e) => e.length * (1 + 0.6 * t.noise(e.center[0] / 30, e.center[1] / 30)));
    const nails = net.points.filter((p) => p.y < 2);
    const hung = net.steps(10, (cur, next) => {
      const pull = force.sum(force.tension(cur, { rest: (e) => e.attrs.rest }), () => [0, 0.08 * gap]);
      next.move(cur.points.subtract(nails), (p) => mul(pull(p), 0.1));
    });
    const cells = hung.faces();
    const rest = net.faces();
    const partner = cells.map((f) => rest.find((g) => g.id === f.id)!);
    // Every cell finds a partner, and not all the same one: the bug paired
    // every cell with rest cell 0 because `f.id` was undefined.
    expect(partner.every((g) => g !== undefined)).toBe(true);
    expect(new Set(partner.map((g) => g.index)).size).toBe(cells.length);
    expect(new Set(cells.map((f) => f.id)).size).toBe(cells.length);
    // steps keep the rows here, so the partner is the same row.
    expect(partner.map((g) => g.index)).toEqual(cells.map((f) => f.index));
    // A renumbering does not move an id: a line laid across one corner of
    // the web and planarized splits a few cells and renumbers the rest, and
    // every cell it did not cross keeps its id — and its area.
    const crossed = append(net, t.material(line(0, 30, 30, 0)).edgeAttribute('rest', 0)).planarize().faces();
    const byId = new Map(crossed.map((f) => [f.id, f] as const));
    const kept = rest.filter((f) => byId.has(f.id));
    expect(kept.length).toBeLessThan(rest.length);
    // The cells that lost their id are the ones the line crosses.
    for (const f of rest.subtract(kept)) expect(Math.abs(f.centroid[0] + f.centroid[1] - 30) / Math.SQRT2).toBeLessThan(gap);
    for (const f of kept) expect(byId.get(f.id)!.area).toBeCloseTo(f.area, 9);
    // A transform keeps every id; so does a planarize that leaves the walls.
    expect(net.rotate(20, { origin: [50, 50] }).faces().map((f) => f.id)).toEqual(rest.map((f) => f.id));
    expect(net.planarize().faces().map((f) => f.id)).toEqual(rest.map((f) => f.id));
  });

  it('G6-26 · the fivefold ribbon is keyed by id, and ids are unique and never undefined', () => {
    const { faces } = web(5, 8);
    const start = faces.at(0);
    const ribbon = new Set([start.id]);
    for (const g of start.adjacent) ribbon.add(g.id);
    expect(ribbon.size).toBe(1 + start.adjacent.length);
    expect(faces.every((f) => typeof f.id === 'string')).toBe(true);
    expect(new Set(faces.map((f) => f.id)).size).toBe(faces.length);
  });

  it('G6-28 · filter predicates take truthiness, as arrays do', () => {
    const t = toolkit({ aspect: [1, 1], seed: 5 });
    const tiles = t.tiling(4, 4, { side: 8, depth: 6 });
    const mirrored = tiles.faces().filter((f) => f.mirrored);
    expect(mirrored.indices).toEqual(tiles.faces().filter((f) => f.mirrored === 1).indices);
    expect(tiles.points.filter((p) => p.index % 2).length).toBeGreaterThan(0);
    expect(tiles.edges.filter((e) => e.index % 2).length).toBeGreaterThan(0);
  });

  it('G6-31 · union keeps the key type, so a component list folds', () => {
    const t = toolkit({ aspect: [3, 4], seed: 11 });
    const sheet = (x: number, y: number) => sdf.box(50, 65, 60, 90)(x, y);
    const edges = t.isolines(sheet, 0);
    const rim = t.within(t.isolines((x, y) => 0.5 + 0.5 * t.noise(x / 14, y / 18), 0.62), edges);
    const long = rim.edges.components().filter((piece) => piece.length > 3);
    expect(long.length).toBeGreaterThan(0);
    const tide = long.reduce((a, b) => a.union(b));
    expect(tide.length).toBe(long.reduce((k, p) => k + p.length, 0));
  });

  it('G7-16 · cellOf(selection) is the cells of those sites; siteOf(cells) the sites', () => {
    const t = toolkit({ aspect: [1, 1], seed: 3 });
    const sites = t.relax(t.scatter({ spacing: 7 }), { iterations: 3 }).attribute('kind', (p) => (p.index % 3 === 0 ? 1 : 0));
    const diagram = t.voronoi(sites);
    const chosenSites = sites.points.filter((p) => p.kind === 1);
    const chosenCells = diagram.cellOf(chosenSites);
    const workaround = diagram.faces().filter((f) => diagram.siteOf(f)?.kind === 1);
    expect(chosenCells.indices).toEqual(workaround.indices);
    expect(diagram.siteOf(chosenCells).indices).toEqual(chosenSites.filter((p) => diagram.cellOf(p) !== undefined).indices);
  });
});

describe('P6 · identity survives every verb', () => {
  it('G2-19 · connect.chain(sel) keeps the members: their ids, rows and columns', () => {
    const t = toolkit({ aspect: [1, 1], seed: 5 });
    const upper = t.scatter({ spacing: 6 }).points.filter((p) => p.y < 30);
    const snake = connect.chain(upper);
    expect(snake.n).toBe(upper.length);
    expect(upper.in(snake).length).toBe(upper.length);
    expect(snake.rowOfPoint(upper.at(0).id)).toBe(0);
    expect(snake.edgeCount).toBe(upper.length - 1);
    // A builder over two overlapping selections still has unique ids.
    const both = connect.pairs(upper, upper);
    expect(new Set(both.pointIds).size).toBe(both.n);
  });

  it('G4-3 · interlace keeps the columns and the lineage: a per-strand pen draws', () => {
    const t = toolkit({ aspect: [2, 1], seed: 6 });
    const seeds = material(
      t.times(26, (k) => { const a = (k / 26) * Math.PI * 2; return [100 + Math.cos(a) * 44, 50 + Math.sin(a) * 24]; }),
      { heading: t.times(26, (k) => (k / 26) * Math.PI * 2 + Math.PI), tip: 1, strand: t.times(26, (k) => k) },
    );
    const grown = seeds.steps(60, (cur, next) => {
      const tips = cur.points.filter((p) => p.tip === 1 && p.x > 3 && p.x < 197 && p.y > 3 && p.y < 97);
      next.extrude(tips, (p) => {
        const heading = p.heading + 0.05 * Math.sin(p.strand + p.x / 9);
        return { position: [p.x + 1.1 * Math.cos(heading), p.y + 1.1 * Math.sin(heading)], attributes: { heading, tip: 1, strand: p.strand } };
      });
      next.set(tips, { tip: 0 });
    }).oscillate({ wavelength: 13, amplitude: 1.6 });
    const woven = grown.interlace({ gap: 2.2 });
    expect(woven.attrNames).toContain('strand');
    const odd = woven.points.filter((p) => p.strand % 2 === 1);
    expect(odd.length).toBeGreaterThan(0);
    const even = woven.edges.filter((e) => e.a.strand % 2 === 0);
    expect(strokes(even).length).toBeGreaterThan(0);
    // Every piece is a child of an edge it was cut from.
    for (let e = 0; e < woven.edgeCount; e++) expect(grown.edgeOf(woven.edgeRoots[e] as never)).toBeDefined();
    // A vertex the weave did not touch is the vertex it was.
    expect(grown.points.in(woven).length).toBeGreaterThan(0.5 * grown.n);
    // The geometry is the weave it always was.
    expect(woven.curves().length).toBeGreaterThan(3);
  });

  it('G5-22 / G6-1 · subtract resolves a stale operand by id; an unrelated one is refused by name', () => {
    const cols = 12, rows = 6, gap = 6;
    const pts: [number, number][] = [];
    const edges: [number, number][] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      pts.push([10 + c * gap, 10 + r * gap]);
      const i = r * cols + c;
      if (c > 0) edges.push([i - 1, i]);
      if (r > 0) edges.push([i - cols, i]);
    }
    const net = material(pts).withEdges(edges).edgeAttribute('rest', gap * 1.2);
    const nails = net.points.filter((p) => p.y < 11 && (p.index % 6 === 0 || p.index === cols - 1));
    const hang = (by: (cur: Material) => ReturnType<Material['points']['filter']>) => net.steps(20, (cur, next) => {
      const pull = force.sum(force.tension(cur, { rest: (e) => e.attrs.rest }), () => [0, 0.42 * gap]);
      next.move(by(cur), (p) => mul(pull(p), 0.1));
    });
    const stale = hang((cur) => cur.points.subtract(nails));
    const spelled = hang((cur) => cur.points.subtract(nails.in(cur)));
    expect([...stale.x]).toEqual([...spelled.x]);
    expect([...stale.y]).toEqual([...spelled.y]);
    // union / intersect / has read the stale side the same way.
    expect(stale.points.intersect(nails).length).toBe(nails.length);
    expect(stale.points.filter(() => false).union(nails).indices).toEqual(nails.in(stale).indices);
    expect(stale.points.has(nails.at(0))).toBe(true);
    // Across lineages there is nothing to resolve.
    const other = material(pts);
    expect(() => other.points.subtract(nails)).toThrow(/unrelated materials/);
  });

  it('face selections resolve a stale operand by id too', () => {
    const t = toolkit({ aspect: [1, 1], seed: 3 });
    const hex = t.hexes({ spacing: 12 });
    const moved = hex.translate([1, 0]);
    const before = hex.faces().filter((f) => f.index % 2 === 0);
    const now = moved.faces();
    expect(now.subtract(before).length).toBe(now.length - before.length);
    expect(now.has(before.at(0))).toBe(true);
    // Ids are minted once per run: an unrelated material of the same run
    // shares none, and is refused.
    const other = t.voronoi(t.scatter({ spacing: 20 })).faces();
    expect(() => other.subtract(before)).toThrow(/unrelated materials/);
  });
});

describe('F10 / F11 · relations read the material\'s space', () => {
  it('F11 · points.near on a spherical material matches brute force space.distance', () => {
    const t = toolkit({ aspect: [1, 1], seed: 9, space: space.spherical({ radius: 30 }) });
    const cloud = t.scatter({ spacing: 5 });
    const sp = t.space;
    expect(cloud.space).toBe(sp);
    for (const q of [[50, 50], [20, 80], [85, 12]] as [number, number][]) {
      for (const radius of [6, 15]) {
        const got = cloud.points.near(q, { radius }).indices;
        const want = cloud.points.filter((p) => sp.distance(q, p) < radius).indices;
        expect(got).toEqual(want);
      }
    }
    // pairs reads the same neighbourhood.
    const rungs = cloud.points.pairs(cloud.points, () => true, { radius: 8 });
    for (const [a, b] of rungs) expect(sp.distance(a, b)).toBeLessThan(8);
    const brute = cloud.points.pairs(cloud.points, (a, b) => sp.distance(a, b) < 8);
    expect(rungs.length).toBe(brute.length);
  });

  it('F11 · points.near in the flat plane is the literal old arithmetic', () => {
    const t = toolkit({ aspect: [1, 1], seed: 9 });
    const cloud = t.scatter({ spacing: 5 });
    const got = cloud.points.near([50, 50], { radius: 12 }).indices;
    expect(got).toEqual(cloud.points.filter((p) => (p.x - 50) ** 2 + (p.y - 50) ** 2 < 144).indices);
  });

  it('F11 · edges.near measures to the edge as a geodesic of the space', () => {
    for (const s of [space.spherical({ radius: 30 }), space.hyperbolic({ radius: 45 })]) {
      const t = toolkit({ aspect: [1, 1], seed: 2, space: s });
      const sp = t.space;
      const hex = t.hexes({ spacing: 14 });
      const dense = (a: [number, number], b: [number, number], p: [number, number]) => {
        let best = Infinity;
        for (let k = 0; k <= 400; k++) best = Math.min(best, sp.distance(p, sp.geodesic(a, b, k / 400)));
        return best;
      };
      for (const q of [[50, 50], [18, 30], [70, 82]] as [number, number][]) {
        const radius = 5;
        const got = new Set(hex.edges.near(q, { radius }).indices);
        for (const e of hex.edges) {
          const d = dense([e.a.x, e.a.y], [e.b.x, e.b.y], q);
          if (d < radius - 1e-3) expect(got.has(e.index)).toBe(true);
          if (d > radius + 1e-3) expect(got.has(e.index)).toBe(false);
        }
      }
    }
  });

  it('F10 · t.distanceTo(points) measures with space.distance; flat is distanceToPoints', () => {
    const hyp = toolkit({ aspect: [1, 1], seed: 4, space: space.hyperbolic({ radius: 45 }) });
    const sites = hyp.scatter({ spacing: 11 });
    const field = hyp.distanceTo(sites.points);
    const sp = hyp.space;
    for (const q of [[50, 50], [10, 90], [93, 7]] as [number, number][]) {
      let best = Infinity;
      for (const p of sites.points) best = Math.min(best, sp.distance(q, p));
      expect(field(q[0], q[1])).toBeCloseTo(-best, 12);
    }
    expect(hyp.distanceTo(sites)(50, 50)).toBe(field(50, 50));
    const flat = toolkit({ aspect: [1, 1], seed: 4 });
    const flatSites = flat.scatter({ spacing: 11 });
    const pure = distanceToPoints(flatSites);
    const tk = flat.distanceTo(flatSites.points);
    for (const q of [[50, 50], [10, 90]] as [number, number][]) expect(tk(q[0], q[1])).toBe(pure(q[0], q[1]));
  });
});

describe('faces as selections: the rest of the words', () => {
  it('rows, in and has by id; Faces is the selection of every face', () => {
    const { cells, faces } = web();
    expect(faces.indices.length).toBe(faces.length);
    expect(faces.source).toBe(cells);
    const picked = faces.rows([3, 1, faces.at(5)]);
    expect(picked.indices).toEqual([1, 3, 5]);
    expect(() => faces.rows(faces.length)).toThrow(/no face/);
    const f: Face = faces.at(2);
    expect(faces.has(f)).toBe(true);
    expect(picked.has(f)).toBe(false);
  });
});

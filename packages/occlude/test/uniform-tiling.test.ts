/**
 * `t.tiling([a, b, c, …])` — the uniform tiling whose every corner meets
 * those polygons in that order — and the `source` of a face, which carries
 * the model face (the regular polygon of its kind about the model's
 * origin, a corner toward `+x`) onto it.
 *
 * The plane's eleven are built on the sheet and read back corner by
 * corner: every corner well inside the drawable meets the configuration in
 * its cyclic order, every whole face is a regular polygon with walls of
 * `side`, and the faces cover the drawable exactly once. The sphere's
 * solids close (Euler 2, the known face counts); a disk configuration
 * comes out of the general rule. A flat tiling's `source` stands the model
 * face on the UNCUT face, the ones the drawable edge cuts included, so
 * `group(f.source, motif)` lands on the cell.
 */

import { describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { circle, space, Material } from '../src/index.js';
import type { Placement } from '../src/placement.js';
import { faceTableOf } from '../src/faces.js';
import { canonicalCorner, PLANE_UNIFORM, SPHERE_UNIFORM, wythoffOf } from '../src/uniformTiling.js';

const sheet = () => toolkit({ aspect: [1, 1] });
const disk = () => toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) });
const ball = () => toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) });

/** The eleven uniform tilings of the plane. */
const PLANE: number[][] = [
  [3, 3, 3, 3, 3, 3], [4, 4, 4, 4], [6, 6, 6],
  [3, 6, 3, 6], [3, 12, 12], [4, 8, 8], [3, 4, 6, 4], [4, 6, 12],
  [3, 3, 3, 3, 6], [3, 3, 4, 3, 4], [3, 3, 3, 4, 4],
];

type Pt = [number, number];

/** A face's corners as pairs, round its loop: the points a curved tiling's
 * `corner` column marks, every point of a flat one. */
const cornersOf = (f: { readonly corners: Iterable<{ readonly point: { readonly x: number; readonly y: number; readonly [column: string]: unknown } }> }): Pt[] =>
  Array.from(f.corners, (c) => c.point).filter((p) => p.corner !== 0).map((p) => [p.x, p.y]);

/** The regular `n`-gon with walls of `side` about `[0, 0]`, a corner
 * toward `+x`: the model face a flat `source` carries. */
const modelFace = (n: number, side: number): Pt[] => {
  const r = side / (2 * Math.sin(Math.PI / n));
  return Array.from({ length: n }, (_, k) => [r * Math.cos((2 * Math.PI * k) / n), r * Math.sin((2 * Math.PI * k) / n)]);
};

/** The farthest a point of `want` stands from the nearest point of `got`. */
const offBy = (want: readonly Pt[], got: readonly Pt[]): number =>
  Math.max(...want.map((w) => Math.min(...got.map((g) => Math.hypot(g[0] - w[0], g[1] - w[1])))));

/** Is `v` inside the convex loop, or on it, whichever way the loop runs? */
const inConvex = (v: Pt, loop: readonly Pt[], tol: number): boolean => {
  let pos = false;
  let neg = false;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = ((b[0] - a[0]) * (v[1] - a[1]) - (b[1] - a[1]) * (v[0] - a[0])) / len;
    if (d > tol) pos = true;
    if (d < -tol) neg = true;
  }
  return !(pos && neg);
};

const area = (loop: readonly Pt[]): number => {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
};

/**
 * A flat tiling read back: the faces cover the drawable once; every face's
 * source carries the model face of its `sides` onto the uncut face — equal
 * to it where the edge did not cut, holding what is left where it did;
 * every whole face is regular with walls of `side`; and every corner well
 * inside the drawable meets `config` in its cyclic order.
 */
function readFlat(tiles: Material, config: readonly number[], side: number, box: { x: number; y: number; w: number; h: number }) {
  const onRim = ([x, y]: Pt): boolean => Math.abs(x - box.x) < 1e-9 || Math.abs(x - box.x - box.w) < 1e-9 || Math.abs(y - box.y) < 1e-9 || Math.abs(y - box.y - box.h) < 1e-9;
  let covered = 0;
  let whole = 0;
  let cut = 0;
  const round = new Map<number, { at: Pt; faces: { sides: number; centre: Pt }[] }>();
  for (const f of tiles.faces) {
    const loop = cornersOf(f);
    covered += area(loop);
    const source = f.source as Placement;
    const model = modelFace(f.sides as number, side).map((v) => source.point(v) as Pt);
    const centre = source.point([0, 0]) as Pt;
    if (loop.some(onRim)) {
      cut++;
      for (const v of loop) expect(inConvex(v, model, 1e-7)).toBe(true);
    } else {
      whole++;
      expect(loop.length).toBe(f.sides);
      expect(offBy(model, loop)).toBeLessThan(1e-9);
      expect(offBy(loop, model)).toBeLessThan(1e-9);
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(side, 9);
      }
    }
    for (const p of Array.from(f.corners, (c) => c.point)) {
      const seat = round.get(p.index) ?? { at: [p.x, p.y] as Pt, faces: [] };
      seat.faces.push({ sides: f.sides as number, centre });
      round.set(p.index, seat);
    }
  }
  expect(covered).toBeCloseTo(box.w * box.h, 6);
  const want = canonicalCorner(config).join('.');
  const inner = [...round.values()].filter(({ at: [x, y] }) => x > box.x + 3 * side && x < box.x + box.w - 3 * side && y > box.y + 3 * side && y < box.y + box.h - 3 * side);
  for (const { at, faces } of inner) {
    const turn = faces
      .map((g) => ({ sides: g.sides, angle: Math.atan2(g.centre[1] - at[1], g.centre[0] - at[0]) }))
      .sort((a, b) => a.angle - b.angle)
      .map((g) => g.sides);
    expect(canonicalCorner(turn).join('.')).toBe(want);
  }
  return { whole, cut, corners: inner.length };
}

/** A curved tiling's corners, walls and faces, and the polygons round
 * every corner that has all of its faces. */
function readCurved(tiles: Material) {
  const corner = tiles.attrs.corner!;
  const V = [...corner].filter((v) => v === 1).length;
  // A wall of `s` samples is `s + 1` edges.
  const E = tiles.edgeCount - (tiles.n - V);
  const round = new Map<number, number[]>();
  const counts: Record<number, number> = {};
  for (const f of tiles.faces) {
    counts[f.sides as number] = (counts[f.sides as number] ?? 0) + 1;
    for (const p of Array.from(f.corners, (c) => c.point)) {
      if (p.corner !== 1) continue;
      round.set(p.index, [...(round.get(p.index) ?? []), f.sides as number]);
    }
  }
  return { V, E, F: tiles.faces.length, counts, round: [...round.values()] };
}

describe('a flat tiling\'s source stands the model face on the uncut face', () => {
  it('puts [0, 0] at the centre of the uncut cell, the cut ones too: {6, 3} at side 10', () => {
    const t = sheet();
    const tiles = t.tiling(6, 3, { side: 10 });
    const b = t.bounds();
    let cutCells = 0;
    for (const f of tiles.faces) {
      const i = f.i as number;
      const j = f.j as number;
      const centre = [b.cx + 15 * i, b.cy + 10 * Math.sqrt(3) * (i / 2 + j)];
      const at = (f.source as Placement).point([0, 0]);
      expect(Math.hypot(at[0] - centre[0], at[1] - centre[1])).toBeLessThan(1e-9);
      if (Math.abs(f.area - (3 * Math.sqrt(3) / 2) * 100) > 1e-6) cutCells++;
    }
    expect(cutCells).toBeGreaterThan(0);
    // The owner's probe: the cell at 3, −4 is cut, its centroid is not its
    // centre, and its source stands on the centre.
    const probe = tiles.faces.find((f) => f.i === 3 && f.j === -4)!;
    expect(probe.centroid[0]).toBeCloseTo(93.556, 2);
    const at = (probe.source as Placement).point([0, 0]);
    expect(at[0]).toBeCloseTo(95, 9);
    expect(at[1]).toBeCloseTo(50 - 25 * Math.sqrt(3), 9);
    expect(tiles.faces.at(0).centroid[0]).toBeCloseTo(50, 9);
    expect((tiles.faces.at(0).source as Placement).point([0, 0])).toEqual([50, 50]);
  });

  it('holds for the regular three and every configuration, moved and turned', () => {
    const t = sheet();
    const box = t.bounds();
    for (const config of PLANE) {
      const headings: number[] = [];
      for (const opts of [{ side: 7, origin: [box.cx, box.cy] as Pt, rotate: 0 }, { side: 6, origin: [31, 12] as Pt, rotate: 17 }]) {
        const tiles = t.tiling(config, opts);
        const read = readFlat(tiles, config, opts.side, { x: box.x, y: box.y, w: box.w, h: box.h });
        expect(read.whole).toBeGreaterThan(0);
        expect(read.cut).toBeGreaterThan(0);
        // The first face stands on the origin, turned by `rotate`.
        const first = tiles.faces.at(0).source as Placement;
        expect(first.point([0, 0])[0]).toBeCloseTo(opts.origin[0], 9);
        expect(first.point([0, 0])[1]).toBeCloseTo(opts.origin[1], 9);
        headings.push(first.heading);
      }
      const turned = (((headings[1] - headings[0]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(turned).toBeCloseTo((17 * Math.PI) / 180, 9);
    }
    for (const [p, q] of [[6, 3], [4, 4], [3, 6]]) {
      readFlat(t.tiling(p, q, { side: 6, origin: [31, 12], rotate: 17 }), Array(q).fill(p), 6, { x: box.x, y: box.y, w: box.w, h: box.h });
    }
  });

  it('carries a motif drawn about the origin onto its cell', () => {
    const t = sheet();
    const tiles = t.tiling([3, 6, 3, 6], { side: 8, rotate: 10 });
    const ring = t.sample(circle(0, 0, 1), { count: 8 });
    for (const f of tiles.faces) {
      const moved = ring.transform(f.source as Placement);
      const c = (f.source as Placement).point([0, 0]);
      for (const p of moved.points) expect(Math.hypot(p.x - c[0], p.y - c[1])).toBeCloseTo(1, 9);
    }
  });
});

describe('the eleven uniform tilings of the plane', () => {
  it('build, and meet every inner corner with the configuration\'s polygons in order', () => {
    const t = sheet();
    const box = t.bounds();
    for (const config of PLANE) {
      const read = readFlat(t.tiling(config, { side: 6 }), config, 6, { x: box.x, y: box.y, w: box.w, h: box.h });
      expect(read.corners).toBeGreaterThan(20);
    }
  });

  it('carry sides, generation, mirrored and source; i and j only on the regular three', () => {
    const t = sheet();
    for (const config of PLANE) {
      const tiles = t.tiling(config, { side: 8 });
      const regular = config.every((n) => n === config[0]);
      expect(new Set(tiles.faces.map((f) => f.sides))).toEqual(new Set(config));
      for (const f of tiles.faces) {
        expect(typeof f.generation).toBe('number');
        expect(f.mirrored).toBe((f.source as Placement).orientation < 0 ? 1 : 0);
        expect(f.i === undefined).toBe(!regular);
        expect(f.j === undefined).toBe(!regular);
      }
      expect(tiles.faces.at(0).generation).toBe(0);
    }
  });

  it('gives [p, p, …] q times the rows of {p, q}', () => {
    const t = sheet();
    for (const [p, q] of [[3, 6], [4, 4], [6, 3]]) {
      const opts = { side: 9, origin: [40, 45] as Pt, rotate: 12, gap: 0.5 };
      const a = t.tiling(Array(q).fill(p), opts);
      const b = t.tiling(p, q, opts);
      expect([...a.x]).toEqual([...b.x]);
      expect([...a.y]).toEqual([...b.y]);
      expect([...a.edgeList]).toEqual([...b.edgeList]);
      expect(a.faces.length).toBe(b.faces.length);
      a.faces.forEach((f, k) => {
        const g = b.faces.at(k);
        expect(Array.from(f.corners, (c) => c.point.index)).toEqual(Array.from(g.corners, (c) => c.point.index));
        for (const col of ['i', 'j', 'generation', 'mirrored', 'sides']) expect(f[col]).toBe(g[col]);
        expect((f.source as Placement).m).toEqual((g.source as Placement).m);
      });
    }
    const h = disk();
    const a = h.tiling([7, 7, 7], { depth: 2 });
    const b = h.tiling(7, 3, { depth: 2 });
    expect([...a.x]).toEqual([...b.x]);
    expect([...a.edgeList]).toEqual([...b.edgeList]);
  });

  it('keeps the one hand of a snub throughout', () => {
    const t = sheet();
    const tiles = t.tiling([3, 3, 3, 3, 6], { side: 5 });
    expect(tiles.faces.every((f) => f.mirrored === 0)).toBe(true);
    // Every hexagon is a sixth-turn of every other: one hand. A copy of
    // the other hand would stand turned the other way from the lattice.
    const sixth = Math.PI / 3;
    const turn = (f: { source?: unknown }): number => {
      const h = (f.source as Placement).heading;
      return ((h % sixth) + sixth) % sixth;
    };
    const hexes = tiles.faces.filter((f) => f.sides === 6);
    const first = turn(hexes.at(0));
    for (const f of hexes) {
      const d = Math.abs(turn(f) - first);
      expect(Math.min(d, sixth - d)).toBeLessThan(1e-9);
    }
  });

  it('takes side as the wall, and gap parts the faces', () => {
    const t = sheet();
    const box = t.bounds();
    const tiles = t.tiling([4, 8, 8], { side: 6, gap: 1 });
    // Parted faces share nothing.
    const owner = new Map<number, number>();
    tiles.faces.forEach((f, k) => {
      for (const c of f.corners) {
        expect(owner.get(c.point.index) ?? k).toBe(k);
        owner.set(c.point.index, k);
      }
    });
    // Each whole face gives up half the gap from its inradius.
    for (const f of tiles.faces) {
      const loop = cornersOf(f);
      if (loop.some(([x, y]) => x <= box.x + 1e-9 || y <= box.y + 1e-9 || x >= box.x + box.w - 1e-9 || y >= box.y + box.h - 1e-9)) continue;
      const n = f.sides as number;
      const c = (f.source as Placement).point([0, 0]);
      const [a, b] = loop;
      const inradius = Math.hypot((a[0] + b[0]) / 2 - c[0], (a[1] + b[1]) / 2 - c[1]);
      expect(inradius).toBeCloseTo(6 / (2 * Math.tan(Math.PI / n)) - 0.5, 9);
    }
  });

  it('draws nothing for a degenerate side or a gap that eats every face', () => {
    const t = sheet();
    expect(t.tiling([3, 6, 3, 6], { side: 0 }).faces.length).toBe(0);
    expect(t.tiling([3, 6, 3, 6], { side: 4, gap: 50 }).faces.length).toBe(0);
  });
});

describe('the table and the rule', () => {
  it('holds wythoffOf to the tables wherever a Wythoff construction exists', () => {
    let held = 0;
    for (const [key, form] of [...PLANE_UNIFORM, ...SPHERE_UNIFORM]) {
      const corner = key.split('.').map(Number);
      if (form.form === 'elongated') {
        expect(wythoffOf(corner)).toBeUndefined();
        continue;
      }
      expect(wythoffOf(corner)).toEqual(form);
      // Read in any direction, from any polygon.
      expect(wythoffOf([...corner].reverse().slice(1).concat([...corner].reverse().slice(0, 1)))).toEqual(form);
      held++;
    }
    expect(PLANE_UNIFORM.size).toBe(11);
    expect(SPHERE_UNIFORM.size).toBe(18);
    expect(held).toBe(10 + 18);
  });
});

describe('what the corner says is refused by name', () => {
  it('refuses a corner no uniform tiling has, with its angle sum', () => {
    const t = sheet();
    expect(() => t.tiling([3, 3, 4, 12], { side: 5 })).toThrow('tiling: no uniform tiling has the corner [3, 3, 4, 12] — its angles, 60° + 60° + 90° + 150° = 360°, fill a full turn, but none of the 11 uniform tilings of the plane meets its corners that way');
    expect(() => t.tiling([5, 5, 10], { side: 5 })).toThrow(/108° \+ 108° \+ 144° = 360°/);
    expect(() => ball().tiling([3, 4, 4, 5])).toThrow(/no uniform tiling has the corner \[3, 4, 4, 5\] — its angles, 60° \+ 90° \+ 90° \+ 108° = 348°, close a corner of the sphere/);
    expect(() => disk().tiling([3, 3, 3, 3, 3, 4])).toThrow(/\[3, 3, 3, 3, 3, 4\] is not a tiling t\.tiling builds — its angles, .* = 390°, pass a full turn/);
    expect(() => ball().tiling([4, 4, 5])).toThrow(/prism/);
    expect(() => ball().tiling([3, 3, 3, 5])).toThrow(/antiprism/);
    expect(() => t.tiling([3, 6], { side: 5 })).toThrow(/three or more whole numbers of 3 or more/);
    expect(() => t.tiling([3, 6, 2.5, 6], { side: 5 })).toThrow(/three or more whole numbers of 3 or more/);
  });

  it('refuses another geometry with the words of {p, q}', () => {
    const h = disk();
    const words = (f: () => unknown): string => {
      try {
        f();
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    const regular = words(() => h.tiling(6, 3));
    const uniform = words(() => h.tiling([3, 6, 3, 6]));
    expect(regular).toMatch(/set space/);
    expect(uniform).toBe(regular.replace('{6, 3}', '[3, 6, 3, 6]'));
    const s = sheet();
    expect(words(() => s.tiling([7, 6, 6]))).toBe(words(() => s.tiling(7, 3)).replace('{7, 3}', '[7, 6, 6]'));
  });

  it('refuses the options of the other geometry by name', () => {
    expect(() => sheet().tiling([3, 6, 3, 6], { depth: 2 })).toThrow(/depth counts the generations of a curved one/);
    expect(() => disk().tiling([7, 6, 6], { side: 3 })).toThrow(/\[7, 6, 6\] has the side its curvature fixes, [\d.]+ here — leave side out/);
    expect(() => disk().tiling([7, 6, 6], { gap: 1 })).toThrow(/gap parts the cells of a flat one/);
    expect(() => disk().tiling([7, 6, 6], { origin: [1, 1] })).toThrow(/not origin/);
    expect(() => sheet().tiling([3, 6, 3, 6], 5 as never)).toThrow(/a vertex configuration is one list, and the options come second/);
  });
});

describe('the sphere closes', () => {
  const solids: [number[], Record<number, number>][] = [
    [[3, 4, 3, 4], { 3: 8, 4: 6 }],
    [[5, 6, 6], { 5: 12, 6: 20 }],
    [[3, 3, 3, 3, 4], { 3: 32, 4: 6 }],
    [[4, 6, 10], { 4: 30, 6: 20, 10: 12 }],
    [[3, 4, 5, 4], { 3: 20, 4: 30, 5: 12 }],
  ];
  it('builds the Archimedean solids whole: Euler 2, the face counts, every corner the configuration', () => {
    const t = ball();
    for (const [config, counts] of solids) {
      const tiles = t.tiling(config);
      const read = readCurved(tiles);
      expect(read.counts).toEqual(counts);
      expect(read.V - read.E + read.F).toBe(2);
      const want = canonicalCorner(config).join('.');
      for (const faces of read.round) expect(faces.length).toBe(config.length);
      for (const faces of read.round) expect([...faces].sort().join('.')).toBe([...want.split('.').map(Number)].sort().join('.'));
      // A closed surface has no outside.
      expect([...faceTableOf(tiles.faces).faceOf].filter((f) => f < 0).length).toBe(0);
      // Every wall one length, in the sphere's own metric.
      const walls = tiles.faces.map((f) => {
        const loop = cornersOf(f);
        return loop.map((v, i) => t.space.distance(v, loop[(i + 1) % loop.length]));
      }).flat();
      expect(Math.max(...walls) - Math.min(...walls)).toBeLessThan(1e-9);
    }
  });
});

describe('the disk takes the rule', () => {
  it('builds [7, 6, 6] at depth 3: heptagons and hexagons, walls shared', () => {
    const t = disk();
    const tiles = t.tiling([7, 6, 6], { depth: 3 });
    const read = readCurved(tiles);
    expect(Object.keys(read.counts).map(Number).sort()).toEqual([6, 7]);
    // A patch of the disk: one short of the closed count, so no wall is
    // stored twice.
    expect(read.V - read.E + read.F).toBe(1);
    const full = read.round.filter((faces) => faces.length === 3);
    expect(full.length).toBeGreaterThan(10);
    for (const faces of full) expect([...faces].sort().join('.')).toBe('6.6.7');
    for (const f of tiles.faces) {
      expect(f.i).toBeUndefined();
      expect(typeof f.generation).toBe('number');
    }
  });

  it('stands every face on its source: the model face about the centre, pulled back one polygon per kind', () => {
    for (const [t, tiles] of [[disk(), disk().tiling([7, 6, 6], { depth: 2 })], [disk(), disk().tiling([3, 3, 3, 3, 7], { depth: 1 })], [ball(), ball().tiling([3, 4, 3, 4])]] as const) {
      const c = t.space.center as unknown as Pt;
      const kinds = new Map<number, Pt[]>();
      for (const f of tiles.faces) {
        const back = cornersOf(f).map((v) => (f.source as Placement).inverse().point(v) as Pt);
        const seen = kinds.get(f.sides as number);
        if (!seen) {
          kinds.set(f.sides as number, back);
          // One corner of the model face stands on the ray toward +x.
          const r = t.space.distance(c, back[0]);
          const ray = t.placement(c).step(r);
          expect(offBy([[ray.x, ray.y]], back)).toBeLessThan(1e-9);
        } else {
          expect(offBy(back, seen)).toBeLessThan(1e-9);
        }
      }
    }
  });
});

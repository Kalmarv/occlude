/**
 * Spec 62 · one area door, one pivot, one boundary judgement (audit P1, P3,
 * P4). Every closed audit entry by id, each from its audit sketch
 * (working/audit/sketches/, the line kept as `// FRICTION`); the rim test;
 * and every `Origin` door on every value.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SQ, toolkit } from './helpers/run.js';
import {
  append, circle, clip, compileSketch, evalPrim, group, initOcclude, invert, line, mask, material, ngon, polygon, rect,
  render, rotate, scale, sketch, space, strokes, svg, vectorField,
  type SketchDef, type Toolkit, type Tree,
} from '../src/index.js';
import { box } from '../src/three/api/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** A toolkit on the 100 × 100 drawable. */
const tk = (): Toolkit => toolkit({ aspect: [1, 1] });

/** Every fragment's ends and middle, rounded, as one sorted string: two
 * sketches that ink the same agree here. */
function inkOf(def: SketchDef): string {
  const out = render(def, SQ);
  const pts: string[] = [];
  for (const frag of out.frags) {
    for (const s of [0, 0.5, 1]) {
      const [x, y] = evalPrim(frag.geom, s);
      pts.push(`${x.toFixed(3)},${y.toFixed(3)}`);
    }
  }
  return pts.sort().join(' ');
}
const same = (a: (t: Toolkit) => Tree, b: (t: Toolkit) => Tree): void => {
  expect(inkOf(sketch({ aspect: [1, 1], seed: 3 }, a))).toBe(inkOf(sketch({ aspect: [1, 1], seed: 3 }, b)));
};
const bbox = (pts: readonly (readonly [number, number])[]): number[] => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

describe('P1 · one area door', () => {
  const ground = (x: number, y: number): number => Math.sin(x / 7) + Math.cos(y / 9);

  it('G1-10 G2-2 G4-4 G5-3 · t.within(field, face) bounds the field as polygon(face) does', () => {
    const t = tk();
    const face = t.hexes({ spacing: 30 }).faces().at(3)!;
    const viaFace = t.isolines(t.within(ground, face), [0]);
    const viaPolygon = t.isolines(t.within(ground, polygon(face)), [0]);
    expect(viaFace.n).toBeGreaterThan(0);
    expect(viaFace.pts).toEqual(viaPolygon.pts);
  });

  it('G2-2 G3-4 G6-13 G7-13 · a field is bounded by a faced material, a face seed, contours and a vector field', () => {
    const t = tk();
    const hex = t.hexes({ spacing: 30 });
    const coast = t.isolines(ground, [0]);
    for (const area of [hex, hex.faces().at(0)!, coast, coast.contours()]) {
      const f = t.within(ground, area);
      expect(Number.isNaN(f(-50, -50))).toBe(true);
    }
    const tiles = t.tiling(4, 4, { side: 20, depth: 1 });
    const pts = t.scatter(t.within(() => 1, tiles.faces().at(0)!), { spacing: 1.5 });
    expect(pts.n).toBeGreaterThan(0);
    const swirl = t.within(vectorField((x: number, y: number): [number, number] => [y - 50, 50 - x]), circle(50, 50, 20));
    expect(Number.isNaN(swirl(5, 5)[0])).toBe(true);
    expect(swirl(50, 60)).toEqual([10, 0]);
  });

  it('G6-22 G7-11 · invert(area) is an area wherever an area is taken', () => {
    const t = tk();
    const disc = circle(50, 50, 20);
    const outside = t.within(ground, invert(disc));
    expect(Number.isNaN(outside(50, 50))).toBe(true);
    expect(outside(5, 5)).toBe(ground(5, 5));
    const rules = append(...t.times(5, (k, u) => t.sample(line(0, 10 + u * 80, 100, 10 + u * 80), { count: 2 })));
    const cut = t.within(rules, invert(disc));
    for (const p of cut.pts) expect(Math.hypot(p[0] - 50, p[1] - 50)).toBeGreaterThan(19.99);
    expect(t.within(t.material(rect(0, 0, 100, 100)).planarize().faces(), invert(disc)).length).toBe(0);
    // Twice outside is inside, through the drawable.
    expect(t.within(ground, invert(invert(disc)))(50, 50)).toBe(ground(50, 50));
  });

  it('G3-5 G5-19 · t.material(face) is the face\'s walls with their ids; t.sample(face) samples every contour', () => {
    const t = tk();
    const cells = t.hexes({ spacing: 30 });
    const face = cells.faces().at(4)!;
    const walls = t.material(face);
    expect(walls.edgeCount).toBe(face.boundaryEdges.length);
    expect([...walls.edgeIds].sort()).toEqual([...face.boundaryEdges.extract().edgeIds].sort());
    const ring = t.sample(face, { count: 60 });
    expect(ring.n).toBe(60);
    expect(ring.edgeCount).toBe(60);
  });

  it('G4-7 G6-30 · t.sample(area) samples a face with a hole on both contours', () => {
    const t = tk();
    const annulus = t.material(circle(50, 50, 30), circle(50, 50, 10)).planarize().faces().filter((f) => f.contours().length === 2).at(0)!;
    expect(annulus).toBeDefined();
    const both = t.sample(annulus, { spacing: 2 });
    expect(both.contours().length).toBe(2);
    expect(t.sample(annulus, { count: 30 }).scale(1.35, { origin: 'centroid' }).n).toBe(60);
  });

  it('G2-5 · contour records go straight to t.material and on to planarize', () => {
    const t = tk();
    const levels = t.isolines(ground, [0]).contours();
    const pieces = t.material(levels).planarize().faces();
    expect(pieces.length).toBeGreaterThan(0);
  });

  it('G6-9 · t.material of a material is that material', () => {
    const t = tk();
    const m = t.material(circle(50, 50, 10));
    expect(t.material(m)).toBe(m);
  });

  it('G1-15 G7-2 G6-10 · a group is an area through its transform: an svg import, a group({ translate }), a placed shape', () => {
    const t = tk();
    const moved = t.material(group({ translate: [30, 0] }, rect(15, 25, 20, 10)));
    expect(bbox(moved.pts)).toEqual([45, 25, 65, 35]);
    const art = svg('<svg viewBox="0 0 10 10"><path d="M0 5 L10 5"/><path d="M0 8 L10 8"/></svg>', { x: 0, y: 60, width: 100 });
    const waves = t.material(art);
    expect(waves.n).toBeGreaterThan(0);
    expect(waves.curves().length).toBe(2);
    const st = t.station(50, 50, { heading: 90 });
    const tag = st.place(rect(-5, -1, 10, 2));
    // Turned a quarter, the tag stands upright: 2 wide and 10 tall.
    const pts = material(t.times(21, (i) => t.times(21, (j) => [40 + i, 40 + j] as [number, number])).flat());
    const cleared = t.within(pts.points, tag);
    expect(cleared.length).toBe(3 * 11);
    for (const p of cleared) expect(Math.abs(p.x - 50)).toBeLessThanOrEqual(1);
  });

  it('G4-13 · t.distanceTo(group) is the distance to the union of its shapes', () => {
    const t = tk();
    const d = t.distanceTo(group({}, circle(40, 50, 10), circle(55, 50, 10)));
    // (47.5, 50) is inside both discs. The union has no wall inside it: the
    // nearest boundary is where the two circles meet, √(10² − 7.5²) away.
    expect(d(47.5, 50)).toBeCloseTo(Math.sqrt(100 - 56.25), 1);
    expect(d(80, 50)).toBeLessThan(0);
  });

  it('G1-4 G6-21 · clip and mask take a face and a material', () => {
    same(
      (t) => { const one = t.hexes({ spacing: 30 }).faces().at(4)!; return clip(one, t.times(10, (k, u) => line(0, u * 100, 100, u * 100))); },
      (t) => { const one = t.hexes({ spacing: 30 }).faces().at(4)!; return clip(polygon(one), t.times(10, (k, u) => line(0, u * 100, 100, u * 100))); },
    );
    same(
      (t) => [t.times(10, (k, u) => line(0, u * 100, 100, u * 100)), mask(t.material(circle(50, 50, 20)))],
      (t) => [t.times(10, (k, u) => line(0, u * 100, 100, u * 100)), mask(polygon(t.material(circle(50, 50, 20))))],
    );
  });

  it('mask(group) hides the union, mask(invert(area)) hides all but the area', () => {
    same(
      (t) => [t.times(10, (k, u) => line(0, u * 100, 100, u * 100)), mask(group({ translate: [10, 0] }, circle(40, 50, 10), circle(55, 50, 10)))],
      (t) => [t.times(10, (k, u) => line(0, u * 100, 100, u * 100)), mask(circle(50, 50, 10)), mask(circle(65, 50, 10))],
    );
    same(
      (t) => [t.times(10, (k, u) => line(0, u * 100, 100, u * 100)), mask(invert(circle(50, 50, 20)))],
      (t) => clip(circle(50, 50, 20), t.times(10, (k, u) => line(0, u * 100, 100, u * 100))),
    );
  });

  it('G7-1 · a clip is ink, not an area: refused by name with the door', () => {
    const t = tk();
    const hill = clip(rect(0, 0, 100, 60), circle(50, 60, 30));
    expect(() => t.sample(hill as never, { count: 60 })).toThrow(/t\.sample: a clip is ink, not an area — cut a material with t\.within/);
  });

  it('refuses a value that is no area by name, and still refuses a face collection', () => {
    const t = tk();
    expect(() => t.within(ground, 42 as never)).toThrow(/t\.within: a number is not an area — give a face, contours, a closed material or a shape/);
    const cells = t.hexes({ spacing: 30 }).faces();
    expect(() => t.within(ground, cells as never)).toThrow(/face collection is several areas/);
    expect(() => clip(7 as never)).toThrow(/^clip: a number is not an area/);
  });
});

describe('P3 · within judges the boundary with the one ink tolerance', () => {
  const lines = (t: Toolkit) => t.times(12, (k, u) => t.sample(line(0, 3 + u * 94, 100, 97 - u * 60), { count: 2 }));

  it('verify-within-rim · faces cut from a frame and tested against it keep their rim', () => {
    const t = tk();
    const disc = circle(50, 50, 44);
    const dFaces = append(t.material(disc), ...lines(t)).planarize().faces();
    expect(dFaces.length).toBe(24);
    expect(t.within(dFaces, disc).length).toBe(24);
    const frame = rect(6, 6, 88, 88);
    const bFaces = append(t.material(frame), ...lines(t)).planarize().faces();
    expect(t.within(bFaces, frame).length).toBe(bFaces.length);
  });

  it('G4-9 · every cell of a disc frame is kept, the rim included', () => {
    const t = toolkit({ aspect: [1, 1], seed: 11 });
    const disc = circle(50, 50, 44);
    const through = (x: number, y: number, a: number) => t.sample(line([x - Math.cos(a) * 200, y - Math.sin(a) * 200], [x + Math.cos(a) * 200, y + Math.sin(a) * 200]), { count: 2 });
    const all = append(t.material(disc), ...t.times(18, () => through(60 + t.rnd(-15, 15), 40 + t.rnd(-15, 15), t.rnd(Math.PI)))).planarize().faces();
    const inDisc = all.filter((f) => Math.hypot(f.centroid[0] - 50, f.centroid[1] - 50) < 44);
    expect(t.within(all, disc).length).toBe(inDisc.length);
  });

  it('G7-9 · chapter 6\'s frame keeps every cell, the bottom and right rims included', () => {
    const t = toolkit({ aspect: [2, 1], seed: 12 });
    const frame = rect(4, 4, 192, 92);
    const chord = () => t.sample(line(t.rnd(0, 200), 0, t.rnd(0, 200), 100), { count: 2 });
    const across = () => t.sample(line(0, t.rnd(0, 100), 200, t.rnd(0, 100)), { count: 2 });
    const cells = append(t.material(frame), ...t.times(10, chord), ...t.times(4, across)).planarize().faces();
    const inside = cells.filter((f) => f.centroid[0] > 4 && f.centroid[0] < 196 && f.centroid[1] > 4 && f.centroid[1] < 96);
    expect(t.within(cells, frame).length).toBe(inside.length);
  });

  it('G2-15 · a point on the boundary is within, as a wall along it is', () => {
    const t = tk();
    const hex = t.hexes({ spacing: 30 });
    // A whole cell: six corners, all on its own boundary.
    const middle = hex.faces().filter((f) => f.contours()[0].pts.length === 6).at(0)!;
    expect(t.within(hex.points, middle).length).toBe(6);
    expect(t.within(hex.edges, middle).length).toBe(6);
  });

  it('G5-24 · one keep vocabulary on points, edges and faces; the old names refuse by name', () => {
    const t = tk();
    const hex = t.hexes({ spacing: 30 });
    const area = circle(50, 50, 25);
    for (const keep of ['contained', 'centroid', 'touching'] as const) {
      expect(() => t.within(hex.points, area, { keep })).not.toThrow();
      expect(() => t.within(hex.edges, area, { keep })).not.toThrow();
      expect(() => t.within(hex.faces(), area, { keep })).not.toThrow();
    }
    // An edge's centroid is its middle.
    const byMiddle = t.within(hex.edges, area, { keep: 'centroid' });
    for (const e of byMiddle) expect(Math.hypot(e.center[0] - 50, e.center[1] - 50)).toBeLessThanOrEqual(25.001);
    expect(() => t.within(hex.edges, area, { edges: 'midpoint' } as never)).toThrow(/'edges' option is spelled keep/);
    expect(() => t.within(hex.faces(), area, { faces: 'centroid' } as never)).toThrow(/'faces' option is spelled keep/);
  });
});

describe('P4 · one pivot type', () => {
  it('G1-18 G2-20 G4-8 G6-15 · a shape and a group pivot on their centroid, and it no longer reaches the engine as a NaN', () => {
    // verify-shape-centroid: an ngon's area centroid is its centre.
    same(() => ngon(50, 50, 3, 30, { scale: 0.5, origin: 'centroid' }), () => ngon(50, 50, 3, 30, { scale: 0.5, origin: [50, 50] }));
    same(
      (t) => { const f = t.hexes({ spacing: 30 }).faces().at(4)!; return polygon(f, { scale: 0.8, origin: 'centroid' }); },
      (t) => { const f = t.hexes({ spacing: 30 }).faces().at(4)!; return polygon(f, { scale: 0.8, origin: f.centroid }); },
    );
    same(
      () => group({ rotate: 20, origin: 'centroid' }, ngon(30, 50, 6, 10, 30)),
      () => group({ rotate: 20, origin: [30, 50] }, ngon(30, 50, 6, 10, 30)),
    );
  });

  it('G7-7 G1-19 · a record and a number[] are points, so a station and a centroid go straight in', () => {
    same(
      (t) => { const st = t.station(30, 40); return group({ rotate: 30, origin: st }, rect(st, 12, 6)); },
      () => group({ rotate: 30, origin: [30, 40] }, rect(30, 40, 12, 6)),
    );
    const c: number[] = [30, 40];
    same(() => group({ scale: 0.8, origin: c }, rect(20, 30, 20, 20)), () => group({ scale: 0.8, origin: [30, 40] }, rect(20, 30, 20, 20)));
  });

  it("G5-21 · 'center' is the value's own middle on a shape, a group and a material alike", () => {
    same(() => ngon(28, 28, 5, 18, { rotate: 36, origin: 'center' }), (t) => {
      const b = bbox(t.material(ngon(28, 28, 5, 18)).pts);
      return ngon(28, 28, 5, 18, { rotate: 36, origin: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] });
    });
    const t = tk();
    const plate = ngon(28, 28, 5, 18);
    const turned = t.material(ngon(28, 28, 5, 18, { rotate: 36, origin: 'center' }));
    const alsoTurned = t.material(plate).rotate(36, { origin: 'center' });
    for (let i = 0; i < turned.n; i++) {
      expect(turned.pts[i][0]).toBeCloseTo(alsoTurned.pts[i][0], 6);
      expect(turned.pts[i][1]).toBeCloseTo(alsoTurned.pts[i][1], 6);
    }
  });

  it('an unknown word refuses by name before the engine sees it', () => {
    expect(() => rect(0, 0, 10, 10, { rotate: 5, origin: 'middle' as never })).toThrow(/shape: origin is a point \(\[x, y\] or \{ x, y \}\), 'center' or 'centroid' — got 'middle'/);
    expect(() => group({ rotate: 5, origin: 'page' as never })).toThrow(/group: origin is a point/);
    const t = tk();
    expect(() => t.material(rect(0, 0, 10, 10)).scale(2, { origin: 'middle' as never })).toThrow(/m\.scale: origin is a point/);
    expect(() => t.hexes({ spacing: 10, origin: 'middle' as never })).toThrow(/hexes: origin is a point/);
  });

  it("G2-7 · t.hexes and t.triangles take 'center': the middle of the drawable they cover", () => {
    const t = tk();
    expect(t.hexes({ spacing: 12, origin: 'center', rotate: 15 }).pts).toEqual(t.hexes({ spacing: 12, origin: [50, 50], rotate: 15 }).pts);
    expect(t.triangles({ size: 12, origin: 'centroid' }).pts).toEqual(t.triangles({ size: 12, origin: { x: 50, y: 50 } }).pts);
  });

  it('G6-27 · a flat t.tiling takes origin and rotate; a curved one refuses origin by name', () => {
    const t = tk();
    const plain = t.tiling(4, 4, { side: 10, depth: 1 });
    const moved = t.tiling(4, 4, { side: 10, depth: 1, origin: [60, 50] });
    for (let i = 0; i < plain.n; i++) {
      expect(moved.pts[i][0]).toBeCloseTo(plain.pts[i][0] + 10, 9);
      expect(moved.pts[i][1]).toBeCloseTo(plain.pts[i][1], 9);
    }
    expect(t.tiling(4, 4, { side: 10, depth: 1, origin: 'center' }).pts).toEqual(plain.pts);
    const turned = t.tiling(4, 4, { side: 10, depth: 1, rotate: 90 });
    for (let i = 0; i < turned.n; i++) {
      const [x, y] = plain.pts[i];
      expect(turned.pts[i][0]).toBeCloseTo(50 - (y - 50), 9);
      expect(turned.pts[i][1]).toBeCloseTo(50 + (x - 50), 9);
    }
    const disk = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 45 }) });
    expect(() => disk.tiling(7, 3, { depth: 1, origin: [10, 10] })).toThrow(/tiling: a .* tiling stands on its chart's centre/);
    expect(disk.tiling(7, 3, { depth: 1, rotate: 10 }).faces().length).toBe(disk.tiling(7, 3, { depth: 1 }).faces().length);
  });

  it('G2-1 G6-33 · a field turns and scales about a point, and refuses a word by name', () => {
    const stripes = (x: number, _y: number): number => x;
    const turned = rotate(stripes, 90, { origin: [50, 50] });
    expect(turned(50, 50)).toBeCloseTo(50, 9);
    expect(turned(50, 60)).toBeCloseTo(60, 9);
    const grown = scale(stripes, 2, { origin: { x: 50, y: 50 } });
    expect(grown(50, 0)).toBeCloseTo(50, 9);
    expect(grown(70, 0)).toBeCloseTo(60, 9);
    expect(() => rotate(stripes, 30, { origin: 'center' as never })).toThrow(/rotate: a field has no bounds, so it has no 'center'/);
    expect(() => scale(stripes, 2, { origin: 'centroid' as never })).toThrow(/scale: a field has no bounds, so it has no 'centroid'/);
  });

  it('G3-17 · 3D rotate and scale take origin, and refuse about by name', () => {
    const bar = box([4, 1, 1]).translate([10, 0, 0]);
    const turned = bar.rotate('z', 90, { origin: 'center' });
    const xs = turned.points.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(9.5, 9);
    expect(Math.max(...xs)).toBeCloseTo(10.5, 9);
    const bigger = bar.scale(2, { origin: 'centroid' });
    const bx = bigger.points.map((p) => p.x);
    expect(Math.min(...bx)).toBeCloseTo(6, 9);
    expect(bar.rotate('z', 90, { origin: [0, 0, 0] }).points.map((p) => p.y).every((y) => y > 7)).toBe(true);
    expect(() => bar.rotate('z', 90, { about: 'world' } as never)).toThrow(/rotate: 'about' is spelled origin/);
    expect(() => bar.scale(2, { about: 'world' } as never)).toThrow(/scale: 'about' is spelled origin/);
  });

  it('every Origin door on every value: shape, group, polygon, material, hexes, triangles, tiling, field, 3D', () => {
    const t = tk();
    const doors: (() => unknown)[] = [
      () => compileSketch(sketch({ aspect: [1, 1] }, () => [
        circle(30, 30, 5, { scale: 2, origin: 'center' }), circle(30, 30, 5, { scale: 2, origin: 'centroid' }),
        circle(30, 30, 5, { scale: 2, origin: [30, 30] }), circle(30, 30, 5, { scale: 2, origin: { x: 30, y: 30 } }),
        group({ rotate: 10, origin: 'center' }, line(0, 0, 10, 10)), group({ rotate: 10, origin: 'centroid' }, line(0, 0, 10, 10)),
        polygon(circle(30, 30, 5, { scale: 2, origin: 'centroid' })),
      ]), SQ),
      () => t.material(rect(0, 0, 10, 10)).rotate(10, { origin: { x: 5, y: 5 } }),
      () => t.hexes({ spacing: 10, origin: { x: 5, y: 5 } }),
      () => t.triangles({ size: 10, origin: 'center' }),
      () => t.tiling(4, 4, { side: 10, depth: 1, origin: { x: 5, y: 5 } }),
      () => rotate((x: number) => x, 10, { origin: { x: 1, y: 2 } }),
      () => box(1).scale(2, { origin: [1, 1, 1] }),
    ];
    for (const door of doors) expect(door).not.toThrow();
    const drawn = render(sketch({ aspect: [1, 1] }, () => strokes(t.material(circle(30, 30, 5, { scale: 2, origin: 'centroid' })))), SQ);
    expect(drawn.stats.fragments).toBeGreaterThan(0);
  });
});

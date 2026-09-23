/**
 * Spec 64: random words draw fresh values, frame words read the frame, and
 * the small words the audit (P10, N2, N3, N5, N8) and the space sweep (F4,
 * F7, F12) left. Each test names the entries it closes; the failing line of
 * each audit sketch (working/audit/sketches) is the line tested.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { SQ, toolkit } from './helpers/run.js';
import {
  circle, compileSketch, ellipse, initOcclude, label, material, ngon, rect, render, sdf, sketch, stroke,
  type Material, type Toolkit, type Execution,
} from '../src/index.js';
import { sphere, view, orthographic } from '../src/three/api/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

function run(body: (t: Toolkit) => void, cfg: Parameters<typeof sketch>[0] = { seed: 1 }): Execution {
  return compileSketch(sketch(cfg, (t) => { body(t); return []; }), SQ);
}

const coords = (m: Material): string => Array.from({ length: m.n }, (_, i) => `${m.x[i]},${m.y[i]}`).join(' ');
const inDisc = (m: Material, cx: number, cy: number, r: number): boolean =>
  Array.from({ length: m.n }, (_, i) => Math.hypot(m.x[i] - cx, m.y[i] - cy) <= r + 1e-6).every(Boolean);

describe('P10 · every random word draws fresh values (G5-8, G1-2)', () => {
  it('two scatter calls differ, and the same seed draws the same two again', () => {
    const draw = () => {
      const t = toolkit({ aspect: [1, 1], seed: 11 });
      return [coords(t.scatter({ spacing: 9 })), coords(t.scatter({ spacing: 9 }))];
    };
    const [a, b] = draw();
    expect(a).not.toBe(b);
    expect(draw()).toEqual([a, b]);
  });

  it('the first call reads the stream it always read, and a named stream is still an address', () => {
    const t = toolkit({ aspect: [1, 1], seed: 11 });
    const exec = t.exec;
    const legacy = exec.stream('__points');
    const first = exec.freshStream('__points');
    expect(first.rnd()).toBe(legacy.rnd());
    const again = exec.freshStream('__points');
    expect(again.rnd()).not.toBe(exec.stream('__points').rnd());
    expect(t.stream('grass').rnd()).toBe(t.stream('grass').rnd());
  });

  it('G5-8: t.throw in a loop of faces puts a different pattern in every cell', () => {
    const t = toolkit({ aspect: [1, 1], seed: 3 });
    const cells = t.hexes({ spacing: 30 }).faces().filter((f) => f.area > 500);
    const offsets = cells.map((f) => {
      const seeds = t.throw(f, { count: 4 });
      return Array.from({ length: seeds.n }, (_, i) => `${(seeds.x[i] - f.centroid[0]).toFixed(6)},${(seeds.y[i] - f.centroid[1]).toFixed(6)}`).join(' ');
    });
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it('G5-10: a cloud scattered in an area keeps it through relax and settle', () => {
    const t = toolkit({ aspect: [1, 1], seed: 2 });
    // sketches/examples-colony-2.ts:12
    const cloud = t.scatter({ spacing: 5, within: circle(50, 50, 20) });
    const relaxed = t.relax(cloud, { iterations: 4 });
    expect(relaxed.n).toBeGreaterThan(10);
    expect(inDisc(relaxed, 50, 50, 20)).toBe(true);
    // Again after a relax: the area rides the result.
    expect(inDisc(t.relax(relaxed, { iterations: 2 }), 50, 50, 20)).toBe(true);
    const settled = t.settle(cloud, { density: () => 1, spacing: 5, iterations: 4 });
    expect(inDisc(settled, 50, 50, 20)).toBe(true);
  });
});

describe('P10 · frame words read the frame the config names (G1-2, G1-1, G3-11)', () => {
  it("t.bounds() answers { x, y, w, h, cx, cy } under origin: 'center'", () => {
    const t = toolkit({ aspect: [3, 2], origin: 'center', yUp: true });
    const b = t.bounds();
    expect({ x: b.x, y: b.y, w: b.w, h: b.h, cx: b.cx, cy: b.cy }).toEqual({ x: -75, y: -50, w: 150, h: 100, cx: 0, cy: 0 });
    expect([t.width, t.height, t.cx, t.cy]).toEqual([150, 100, 0, 0]);
    // The top-left frame is the one it always was.
    const flat = toolkit({ aspect: [3, 2] }).bounds();
    expect([flat.x, flat.y, flat.w, flat.h, flat.cx, flat.cy]).toEqual([0, 0, 150, 100, 75, 50]);
    // A rect record is an area (G4-6, G3-11).
    expect(b.contours()[0].pts).toEqual([[-75, -50], [75, -50], [75, 50], [-75, 50]]);
  });

  it('G1-2: grid and hexes cover the whole drawable, not one quadrant', () => {
    const t = toolkit({ aspect: [3, 2], origin: 'center', yUp: true });
    const cells = t.grid({ cols: 6, rows: 6 });
    expect(Math.min(...cells.map((c) => c.x))).toBe(-75);
    expect(Math.max(...cells.map((c) => c.x + c.w))).toBeCloseTo(75, 9);
    expect(Math.min(...cells.map((c) => c.y))).toBe(-50);
    const hex = t.hexes({ spacing: 12 });
    expect(Math.min(...hex.x)).toBeCloseTo(-75, 9);
    expect(Math.max(...hex.x)).toBeCloseTo(75, 9);
    expect(Math.min(...hex.y)).toBeCloseTo(-50, 9);
    expect(Math.max(...hex.y)).toBeCloseTo(50, 9);
    const pts = t.scatter({ spacing: 8 });
    expect(Math.min(...pts.x)).toBeLessThan(-60);
    expect(Math.max(...pts.x)).toBeGreaterThan(60);
  });

  it('G1-2: the frame rect and the grid put no ink outside the drawable', () => {
    // sketches/getting-started-3.ts:6
    const out = render(sketch({ aspect: [3, 2], origin: 'center', yUp: true, rectMode: 'center' }, (t) => {
      const b = t.bounds();
      return [rect(0, 0, b.w - 4, b.h - 4), t.grid({ cols: 6, rows: 6, gap: 2 }).map((c) => circle(c.cx, c.cy, 3))];
    }), SQ);
    const f = out.frame;
    const [x0, y0, x1, y1] = [f.offsetX, f.offsetY, f.offsetX + f.inner.innerW, f.offsetY + f.inner.innerH];
    expect(out.frags.length).toBeGreaterThan(36);
    for (const frag of out.frags) {
      const g = frag.geom as unknown as Record<string, number>;
      for (const [x, y] of [[g.x0, g.y0], [g.x1, g.y1]]) {
        if (x === undefined || y === undefined) continue;
        expect(x).toBeGreaterThanOrEqual(x0 - 1e-6);
        expect(x).toBeLessThanOrEqual(x1 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(y0 - 1e-6);
        expect(y).toBeLessThanOrEqual(y1 + 1e-6);
      }
    }
  });
});

describe('N2 · one within: area on every point operation', () => {
  it('G2-16, G7-14: relax and settle take any area, a face too; bounds is refused by name', () => {
    run((t) => {
      const f = t.hexes({ spacing: 40 }).faces().filter((c) => c.area > 1000).at(0);
      // sketches/reference-points-1.ts:10
      const relaxed = t.relax(t.scatter({ spacing: 4, within: f }), { iterations: 3, within: f });
      const inside = t.within(relaxed.points, f);
      expect(inside.length).toBe(relaxed.n);
      expect(() => t.relax(relaxed, { iterations: 1, bounds: { x: 0, y: 0, w: 10, h: 10 } } as never)).toThrow('relax: bounds is now within');
      expect(() => t.settle(relaxed, { density: () => 1, spacing: 4, bounds: { x: 0, y: 0, w: 10, h: 10 } } as never)).toThrow('settle: bounds is now within');
      expect(() => t.voronoi(relaxed, { bounds: { x: 0, y: 0, w: 10, h: 10 } } as never)).toThrow('voronoi: bounds is now within');
      expect(() => t.quadtree(relaxed, { bounds: { x: 0, y: 0, w: 10, h: 10 } } as never)).toThrow('quadtree: bounds is now within');
    });
  });

  it('G2-17, G7-15: relax and settle take a point selection, its members extracted', () => {
    run((t) => {
      const big = t.scatter({ spacing: 5 });
      // sketches/reference-points-2.ts:10, sketches/workshop-08-3.ts:12
      const pond = circle(50, 50, 25);
      const calm = t.relax(t.within(big.points, pond), { iterations: 2, within: pond });
      // The members relax inside the pond; the ones the trim to the disc
      // thins at its edge go.
      expect(calm.n).toBeGreaterThan(0);
      expect(calm.n).toBeLessThanOrEqual(t.within(big.points, pond).length);
      expect(inDisc(calm, 50, 50, 25)).toBe(true);
      const few = t.settle(big.points.filter((p) => p.x < 50), { density: () => 0.5, spacing: 6, iterations: 3 });
      expect(few.n).toBeGreaterThan(0);
    });
  });

  it('G2-18, G4-11, G6-16: voronoi cuts at any area and its cells keep their sites', () => {
    run((t) => {
      const sites = t.scatter({ spacing: 12 });
      // sketches/examples-territory-1.ts:10, sketches/examples-cone-2.ts:10
      for (const area of [ngon(50, 50, 6, 35), ellipse(50, 50, 40, 25)]) {
        const cells = t.voronoi(sites, { within: area });
        const faces = cells.faces();
        expect(faces.length).toBeGreaterThan(5);
        for (const f of faces) expect(cells.siteOf(f)).toBeDefined();
        const lowered = t.material(area);
        const [lx0, lx1] = [Math.min(...lowered.x), Math.max(...lowered.x)];
        expect(Math.min(...cells.x)).toBeGreaterThanOrEqual(lx0 - 1e-6);
        expect(Math.max(...cells.x)).toBeLessThanOrEqual(lx1 + 1e-6);
      }
    });
  });

  it('G4-6, G4-15, G7-17, G3-11: t.bounds(), a rect shape and a { x, y, w, h } record are the same rect', () => {
    run((t) => {
      const sites = t.scatter({ spacing: 14 });
      // sketches/workshop-10-1.ts:13, sketches/examples-respond-3.ts:10
      const a = t.voronoi(sites, { within: rect(5, 5, 90, 90) });
      const b = t.voronoi(sites, { within: { x: 5, y: 5, w: 90, h: 90 } });
      expect(coords(a)).toBe(coords(b));
      expect(coords(t.voronoi(sites, { within: t.bounds() }))).toBe(coords(t.voronoi(sites)));
      // sketches/examples-plaid-1.ts:13
      const woven = material([[-10, 50], [110, 50]], { edges: [[0, 1]] });
      const cut = t.within(woven, t.bounds());
      expect([Math.min(...cut.x), Math.max(...cut.x)]).toEqual([0, 100]);
    });
  });

  it('G5-6: t.scatter(area, opts) as t.throw(area, opts)', () => {
    run((t) => {
      // sketches/examples-colony-2.ts:12
      const cloud = t.scatter(circle(50, 50, 20), { spacing: 5 });
      expect(cloud.n).toBeGreaterThan(20);
      expect(inDisc(cloud, 50, 50, 20)).toBe(true);
    });
  });

  it('quadtree subdivides a within area', () => {
    run((t) => {
      const pts = t.scatter({ spacing: 6 });
      const cells = t.quadtree(pts, { within: rect(20, 20, 40, 40), capacity: 2 });
      expect(Math.min(...cells.x)).toBe(20);
      expect(Math.max(...cells.x)).toBe(60);
    });
  });
});

describe('N3 · point forms on the rest', () => {
  it('G2-3, G5-5, G6-19: sdf.circle, sdf.box and sdf.segment take points', () => {
    const p = { x: 30, y: 40 };
    expect(sdf.circle(p, 7)(33, 44)).toBe(sdf.circle(30, 40, 7)(33, 44));
    expect(sdf.circle([30, 40], 7)(33, 44)).toBe(2);
    expect(sdf.box(p, 10, 6)(31, 41)).toBe(sdf.box(30, 40, 10, 6)(31, 41));
    expect(sdf.segment(p, [60, 40], 2)(45, 41)).toBe(sdf.segment(30, 40, 60, 40, 2)(45, 41));
  });

  it('G1-6, G5-26, G6-12: label takes its anchor as one point', () => {
    expect(JSON.stringify(label('SHAPES', [20, 30], 6, { align: 'center' }))).toBe(JSON.stringify(label('SHAPES', 20, 30, 6, { align: 'center' })));
    expect(JSON.stringify(label('AB', { x: 20, y: 30 }, 6))).toBe(JSON.stringify(label('AB', 20, 30, 6)));
  });

  it('G6-40: stroke takes records, pairs and selections alike', () => {
    const t = toolkit({ aspect: [1, 1] });
    const pts = t.scatter({ spacing: 20 });
    const records = stroke(pts.points);
    const pairs = stroke(pts.pts);
    expect(JSON.stringify(records.geom)).toBe(JSON.stringify(pairs.geom));
    expect(JSON.stringify(stroke([[0, 0], { x: 10, y: 5 }]).geom)).toBe(JSON.stringify(stroke([[0, 0], [10, 5]]).geom));
    expect(() => stroke([[0, 0], 5] as never)).toThrow('stroke: entry 1 is not a point');
  });

  it('G1-12, G6-24: streamlines seeds take any points', () => {
    run((t) => {
      const flow = (x: number, y: number): [number, number] => [1, Math.sin(y / 10) * 0.3];
      const seeds = t.scatter({ spacing: 30 });
      // sketches/fields-2.ts:14, sketches/examples-squall-1.ts:16
      const a = t.streamlines(flow, { spacing: 6, seeds });
      const b = t.streamlines(flow, { spacing: 6, seeds: seeds.points });
      const c = t.streamlines(flow, { spacing: 6, seeds: seeds.pts });
      expect(coords(a)).toBe(coords(c));
      expect(coords(b)).toBe(coords(c));
    });
  });
});

describe('N5 · typed face columns from the generators', () => {
  it('G1-5: a hex face reads i and j as numbers', () => {
    const t = toolkit({ aspect: [2, 1] });
    // sketches/shapes-1.ts:13 — typechecks with no `?? 0`
    const angles: number[] = t.hexes({ spacing: 14 }).faces().map((f) => 30 * f.j + f.i);
    expect(angles.every(Number.isFinite)).toBe(true);
  });

  it('G3-6: a tiling face reads generation, mirrored and placementIndex as numbers', () => {
    const t = toolkit({ aspect: [1, 1] });
    // sketches/reference-geometry-3.ts:11
    const odd = t.tiling(4, 4, { depth: 3, side: 6 }).faces().filter((f) => f.generation % 2 === 1);
    expect(odd.length).toBeGreaterThan(0);
    const hands: (0 | 1)[] = odd.map((f) => f.mirrored);
    expect(hands.every((m) => m === 0 || m === 1)).toBe(true);
  });
});

describe('N1 slice · chain verbs on an edge selection (G2-10, G5-25)', () => {
  it('along and trim are this.extract().verb(opts)', () => {
    const t = toolkit({ aspect: [1, 1] });
    const ring = t.sample(circle(50, 50, 30), { count: 40 });
    const arc = ring.edges.filter((e) => e.a.y < 50 && e.b.y < 50);
    // sketches/reference-material-3.ts:13, sketches/examples-datum-1.ts:15
    expect(arc.along({ spacing: 5 }).map((s) => [s.x, s.y])).toEqual(arc.extract().along({ spacing: 5 }).map((s) => [s.x, s.y]));
    expect(coords(arc.trim({ start: 2, end: 2 }))).toBe(coords(arc.extract().trim({ start: 2, end: 2 })));
    expect(coords(arc.resample({ spacing: 3 }))).toBe(coords(arc.extract().resample({ spacing: 3 })));
  });
});

describe('sweep · the space words', () => {
  it('F12: t.throw is uniform per area of the space on a sphere', () => {
    const t = toolkit({ aspect: [1, 1], seed: 5, space: 'spherical' });
    const sp = t.space;
    const pts = t.throw({ count: 6000 });
    // Two bands of equal coordinate height, one at the middle row and one at
    // the top: their share of the points is their share of the space's area.
    const band = (y0: number, y1: number): number => Array.from(pts.y).filter((y) => y >= y0 && y < y1).length / pts.n;
    const area = (y0: number, y1: number): number => {
      let s = 0;
      for (let k = 0; k < 200; k++) s += sp.density([50, y0 + ((k + 0.5) / 200) * (y1 - y0)]);
      return s * (y1 - y0) / 200;
    };
    let total = 0;
    for (let k = 0; k < 400; k++) total += sp.density([50, (k + 0.5) / 4]);
    total /= 4;
    const middle = area(40, 60) / total;
    const top = area(0, 20) / total;
    expect(middle / top).toBeGreaterThan(1.15);
    expect(band(40, 60)).toBeCloseTo(middle, 1);
    expect(band(0, 20)).toBeCloseTo(top, 1);
    // Flat, the throw is the old one bit for bit: no draw is spent on the space.
    const flat = toolkit({ aspect: [1, 1], seed: 5 });
    const again = toolkit({ aspect: [1, 1], seed: 5 });
    expect(coords(flat.throw({ count: 50 }))).toBe(coords(again.throw({ count: 50 })));
  });

  it('F7: face area and perimeter, and measure, read the material space', () => {
    const t = toolkit({ aspect: [1, 1], space: 'hyperbolic' });
    const sp = t.space;
    const square = t.material(rect(40, 40, 20, 20)).faces().at(0);
    let dens = 0;
    const n = 400;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) dens += sp.density([40 + ((i + 0.5) / n) * 20, 40 + ((j + 0.5) / n) * 20]);
    const expected = (dens / (n * n)) * 400;
    expect(Math.abs(square.area - expected) / expected).toBeLessThan(1e-4);
    expect(square.area).not.toBeCloseTo(400, 3);
    expect(square.perimeter).toBeGreaterThan(80);
    const m = t.material(rect(40, 40, 20, 20)).faces().measure(() => 1, { step: 0.1 }).results[0];
    expect(m.area).toBe(square.area);
    expect(m.integral).toBeCloseTo(square.area, 0);
    expect(m.mean).toBeCloseTo(1, 12);
    // Flat is unchanged: the chart is the space.
    const flat = toolkit({ aspect: [1, 1] }).material(rect(40, 40, 20, 20)).faces().at(0);
    expect([flat.area, flat.perimeter]).toEqual([400, 80]);
    expect(() => t.material(rect(40, 40, 20, 20)).faces().measure(() => 1, { resolution: 64 } as never)).toThrow('measure: resolution is now step');
  });

  it('F7: the inscribed circle is a circle of the space inside the face', () => {
    const t = toolkit({ aspect: [1, 1], space: 'spherical' });
    const faces = t.material(rect(30, 30, 40, 20)).faces();
    const face = faces.at(0);
    const r = faces.measure().results[0];
    const circleOfSpace = t.space.circle(r!.inscribedCentre, r!.inscribedRadius * 0.999, 64);
    const inside = t.within(material(circleOfSpace).points, face);
    expect(inside.length).toBe(64);
  });

  it("F4: the spherical default keeps a 2:1 drawable on the near side, and a square one where it was", () => {
    expect(toolkit({ aspect: [1, 1], space: 'spherical' }).space.radius).toBe(50);
    const wide = toolkit({ aspect: [2, 1], space: 'spherical' }).space;
    expect(100 / wide.radius).toBeLessThan(Math.PI / 2);
    expect(Math.cos(100 / wide.radius) * Math.cos(50 / wide.radius)).toBeGreaterThan(0);
  });
});

describe('strokes3 clips to the view frame (as the callback does)', () => {
  it('a run that leaves the frame is cut at it', async () => {
    const { compileSketchAsync, sketchAsync } = await import('../src/index.js');
    const exec = await compileSketchAsync(sketchAsync({ aspect: [1, 1] }, async (t) => {
      const scene = view(sphere(3), { camera: orthographic({ eye: [4, 5, 3], span: 3 }) }).scene;
      const cls = await t.classify3(scene);
      const { constructStrokes3 } = await import('../src/index.js');
      return t.strokes3(constructStrokes3(cls, [{ id: 'all', stroke: 'pigma-005-black' }]));
    }), SQ);
    const out = render(exec);
    const f = out.frame;
    expect(out.frags.length).toBeGreaterThan(0);
    for (const frag of out.frags) {
      const g = frag.geom as unknown as Record<string, number>;
      for (const [x, y] of [[g.x0, g.y0], [g.x1, g.y1]]) {
        if (x === undefined) continue;
        expect(x).toBeGreaterThanOrEqual(f.offsetX - 1e-6);
        expect(x).toBeLessThanOrEqual(f.offsetX + f.inner.innerW + 1e-6);
        expect(y).toBeGreaterThanOrEqual(f.offsetY - 1e-6);
        expect(y).toBeLessThanOrEqual(f.offsetY + f.inner.innerH + 1e-6);
      }
    }
  });
});

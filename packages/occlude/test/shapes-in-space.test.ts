/**
 * Shapes in a space, as the laws say (spec 57).
 *
 * 1. A round shape — `circle`, `ellipse`, `ngon` — is steps from its
 *    anchor: the point at angle θ is `space.exp(c, r·(cos θ, sin θ))`, and
 *    an ngon's edges are the geodesics between its stepped corners.
 * 2. `t.material(shape)` keeps the shape's own vertices in every space.
 * 3. `smooth` rounds the shape's corners before the placement, not the
 *    samples of the placed outline.
 * 4. An area's loop keeps the side its winding names: an edge longer than
 *    half the circumference of a sphere runs the long way.
 *
 * The flat cases are bit-identical to the code before the change:
 * `shapes-in-space.golden.json` was written from HEAD (6c5b953) by
 * `flatGolden()` below, with `WRITE_GOLDEN=1`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SQ, toolkit } from './helpers/run.js';
import {
  append, circle, compileSketch, ellipse, group, initOcclude, line, material, modify, ngon, polygon, rect, render, sketch, smooth, space, stroke, strokes,
  type ShapeValue, type SketchConfig,
} from '../src/index.js';
import { lowerShape } from '../src/record.js';
import { flattenPrim } from '../src/prims.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

type Pt = [number, number];

const FLAT: SketchConfig = { aspect: [1, 1] };
const WIDE: SketchConfig = { aspect: [2, 1] };
const SPACES: [string, SketchConfig][] = [
  ['hyperbolic', { aspect: [1, 1], space: space.hyperbolic({ radius: 45 }) }],
  ['spherical', { aspect: [1, 1], space: space.spherical({ radius: 30 }) }],
];

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/** The contours of one shape as the ink door lowers it, in paper mm. */
function ink(cfg: SketchConfig, shape: ShapeValue): Pt[][] {
  const exec = compileSketch(sketch(cfg, () => shape), SQ);
  return lowerShape(exec.shapes[0], exec.frame).contours.map((c) => {
    const pts: Pt[] = [];
    for (const p of c) for (const q of flattenPrim(p, 0.05)) pts.push(q);
    return pts;
  });
}

/** The drawn fragments of a whole sketch, as the engine hands them back. */
function frags(cfg: SketchConfig, tree: () => ShapeValue | ReturnType<typeof modify>): unknown[] {
  return render(sketch(cfg, tree), SQ).frags.map((f) => f.geom);
}

/** A bounded field read over a grid of sketch points. */
function bound(cfg: SketchConfig, area: ShapeValue, w: number, h: number): number[] {
  const t = toolkit(cfg);
  const f = t.within(() => 1, area);
  const out: number[] = [];
  for (let y = 0.5; y < h; y += 3) for (let x = 0.5; x < w; x += 3) out.push(f(x, y));
  return out;
}

/** The flat cases the change must not move, one hash each. */
function flatGolden(): Record<string, string> {
  const t = toolkit(FLAT);
  const c = circle(37, 41, 23);
  const e = ellipse(55, 45, 30, 14, 25);
  const hex = ngon(50, 50, 6, 30, 15);
  const pent = ngon(100, 50, 5, 30);
  return {
    circleInk: hash(ink(FLAT, c)),
    ellipseInk: hash(ink(FLAT, e)),
    ngonInk: hash(ink(FLAT, hex)),
    circleMaterial: hash(t.material(c).pts),
    ngonMaterial: hash(t.material(hex).pts),
    rectMaterial: hash(t.material(rect(10, 12, 60, 30)).pts),
    circleSample: hash(t.sample(c, { count: 72 }).pts),
    smoothPentagon: hash(frags(WIDE, () => modify([smooth(3)], pent))),
    smoothCircle: hash(frags(FLAT, () => modify([smooth(2)], circle(50, 50, 30)))),
    bound: hash(bound(FLAT, rect(6, 6, 88, 40), 100, 100)),
    wideBound: hash(bound(WIDE, rect(6, 6, 188, 88), 200, 100)),
  };
}

/** The largest distance from a point of `a` to the polyline `b`. */
function gap(a: readonly Pt[], b: readonly Pt[]): number {
  let worst = 0;
  for (const p of a) {
    let best = Infinity;
    for (let k = 1; k < b.length; k++) {
      const [ax, ay] = b[k - 1];
      const dx = b[k][0] - ax;
      const dy = b[k][1] - ay;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(p[0] - ax - dx * u, p[1] - ay - dy * u));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

for (const [name, cfg] of SPACES) {
  describe(`${name}: a round shape is steps from its anchor`, () => {
    const t = toolkit(cfg);
    const s = t.space;

    it.each([
      [50, 50, 40],
      [80, 30, 10],
      [20, 75, 12],
    ])('every sample of circle(%d, %d, %d) is at distance r from its centre', (cx, cy, r) => {
      const m = t.sample(circle(cx, cy, r), { count: 72 });
      expect(m.n).toBe(72);
      for (const p of m.pts) expect(Math.abs(s.distance([cx, cy], p) - r)).toBeLessThan(1e-9);
    });

    it('the ink of a circle is the circle of the space, sheet for sheet', () => {
      // Every point the ink door draws, back in sketch coordinates through
      // the chart, is a step of r from the centre: the ink samples ON the
      // curve, so the only error left is the paper grid's snap.
      const c: Pt = [80, 30];
      const truth = s.circle(c, 10, 720).map((p) => s.project(p));
      const exec = compileSketch(sketch(cfg, () => circle(c, 10)), SQ);
      const unit = Math.min(exec.frame.inner.innerW, exec.frame.inner.innerH) / 100;
      const drawn = ink(cfg, circle(c, 10)).flat().map(([x, y]): Pt => [(x - exec.frame.offsetX) / unit, (y - exec.frame.offsetY) / unit]);
      expect(gap(drawn, [...truth, truth[0]] as Pt[])).toBeLessThan(0.05);
    });

    it('an ellipse is (rx cos θ, ry sin θ) stepped from its centre, turned by its rotation', () => {
      const [cx, cy, rx, ry, rot] = [45, 60, 20, 9, 30];
      const m = t.material(ellipse(cx, cy, rx, ry, rot));
      const a = (rot * Math.PI) / 180;
      for (const p of m.pts) {
        // Read the step back and undo the turn: the point is on the flat
        // ellipse of the step's own coordinates.
        const [u, v] = s.log([cx, cy], p);
        const lx = u * Math.cos(a) + v * Math.sin(a);
        const ly = -u * Math.sin(a) + v * Math.cos(a);
        expect(Math.abs(Math.hypot(lx / rx, ly / ry) - 1)).toBeLessThan(1e-9);
      }
    });

    it('an ngon has its corners at distance r and geodesics for edges', () => {
      const c: Pt = [50, 50];
      const m = t.material(ngon(c, 6, 30));
      for (const p of m.pts) expect(Math.abs(s.distance(c, p) - 30)).toBeLessThan(1e-9);
      // Each corner turns 60° about the centre from the one before it.
      for (let k = 0; k < 6; k++) {
        const [u0, v0] = s.log(c, m.pts[k]);
        const [u1, v1] = s.log(c, m.pts[(k + 1) % 6]);
        const turn = Math.atan2(u0 * v1 - v0 * u1, u0 * u1 + v0 * v1);
        expect(Math.abs(turn - Math.PI / 3)).toBeLessThan(1e-9);
      }
      // The sampled outline of the same ngon lies on the geodesics between
      // those corners.
      const outline = t.sample(ngon(c, 6, 30), { count: 60 }).pts;
      for (const p of outline) {
        let best = Infinity;
        for (let k = 0; k < 6; k++) {
          const a = m.pts[k];
          const b = m.pts[(k + 1) % 6];
          best = Math.min(best, s.distance(a, p) + s.distance(p, b) - s.distance(a, b));
        }
        expect(best).toBeLessThan(1e-6);
      }
    });
  });

  describe(`${name}: t.material(shape) keeps the shape's own vertices`, () => {
    const t = toolkit(cfg);

    it('six for a hexagon, four for a rect, two for a line', () => {
      expect(t.material(ngon(50, 50, 6, 40)).n).toBe(6);
      expect(t.material(rect(10, 12, 60, 30)).n).toBe(4);
      const r = t.material(rect(10, 12, 60, 30)).pts;
      expect(r).toEqual([[10, 12], [70, 12], [70, 42], [10, 42]]);
    });

    it('a rect material draws the rect: its strokes are the same ink', () => {
      const shape = rect(10, 20, 70, 50);
      const exec = compileSketch(sketch(cfg, (k) => [shape, strokes(k.material(shape))]), SQ);
      const [a, b] = [0, 1].map((i) => lowerShape(exec.shapes[i], exec.frame).contours.flatMap((c) => c.flatMap((p) => flattenPrim(p, 0.05))));
      expect(Math.max(gap(a, b), gap(b, a))).toBeLessThan(1e-9);
    });

    it('a circle keeps its flattening, every vertex on the circle of the space', () => {
      const m = t.material(circle(50, 50, 20));
      expect(m.n).toBeGreaterThan(24);
      for (const p of m.pts) expect(Math.abs(t.space.distance([50, 50], p) - 20)).toBeLessThan(1e-9);
    });
  });

  describe(`${name}: an edge carries what it is`, () => {
    const t = toolkit(cfg);
    /** The ink of shape `i` of a compiled run, flattened, in paper mm. */
    const inkOf = (exec: ReturnType<typeof compileSketch>, i: number): Pt[] =>
      lowerShape(exec.shapes[i], exec.frame).contours.flatMap((c) => c.flatMap((p) => flattenPrim(p, 0.05)));

    it('t.material writes geodesic = 1 on round shapes and lines, 0 on rects and paths', () => {
      for (const sv of [line(10, 15, 90, 80), circle(70, 30, 20), ellipse(40, 60, 25, 10, 30), ngon(50, 50, 6, 30)]) {
        expect(Array.from(t.material(sv).edgeAttrs.geodesic)).toEqual(new Array(t.material(sv).edgeCount).fill(1));
      }
      for (const sv of [rect(10, 12, 60, 30), stroke([[10, 10], [60, 40], [80, 10]])]) {
        expect(Array.from(t.material(sv).edgeAttrs.geodesic)).toEqual(new Array(t.material(sv).edgeCount).fill(0));
      }
      // A material of points has no column: its edges are coordinate edges.
      expect(material([[0, 0], [10, 0]], { edges: [[0, 1]] }).edgeAttrs.geodesic).toBeUndefined();
    });

    it.each([
      ['ngon', ngon(50, 50, 6, 40)],
      ['rect', rect(10, 20, 70, 50)],
      ['line', line(10, 15, 90, 80)],
      ['circle', circle(70, 30, 20)],
    ] as const)('strokes and polygon of t.material(%s) ink as the shape inks', (_, sv) => {
      const closed = sv.geom.kind !== 'line';
      const exec = compileSketch(sketch(cfg, (k) => [sv, strokes(k.material(sv)), ...(closed ? [polygon(k.material(sv))] : [])]), SQ);
      const shape = inkOf(exec, 0);
      for (const i of closed ? [1, 2] : [1]) {
        const drawn = inkOf(exec, i);
        expect(Math.max(gap(shape, drawn), gap(drawn, shape))).toBeLessThan(0.01);
      }
    });

    it('m.transform carries a geodesic edge exactly: two moved ends, drawn as the placed shape', () => {
      const arrow = line(40, 50, 52, 50);
      const place = t.station(50, 50).toward([60, 40]).placement();
      const moved = t.material(arrow).transform(place);
      expect(moved.n).toBe(2);
      expect(Array.from(moved.edgeAttrs.geodesic)).toEqual([1]);
      const exec = compileSketch(sketch(cfg, (k) => [group(place, arrow), strokes(k.material(arrow).transform(place))]), SQ);
      const a = inkOf(exec, 0);
      const b = inkOf(exec, 1);
      expect(Math.max(gap(a, b), gap(b, a))).toBeLessThan(0.01);
    });

    it('the column survives the verbs, and its absence reads as 0', () => {
      const m = t.material(ngon(50, 50, 6, 30));
      // A new edge that does not name it is a coordinate edge; the kept
      // walls keep theirs.
      const joined = m.withEdges([...m.edges.map((e) => [e.a.index, e.b.index] as [number, number]), [0, 3]]);
      expect(Array.from(joined.edgeAttrs.geodesic)).toEqual([1, 1, 1, 1, 1, 1, 0]);
      // Appending a flat material fills its side with 0.
      const piled = append(m, material([[0, 0], [5, 5]], { edges: [[0, 1]] }));
      expect(Array.from(piled.edgeAttrs.geodesic)).toEqual([1, 1, 1, 1, 1, 1, 0]);
      // A closing edge `within` adds along the boundary is a coordinate
      // segment: 0, while the walls it cut keep their 1.
      const hex = t.material(ngon(50, 50, 6, 30)).planarize();
      const cut = t.within(hex, rect(50, 0, 60, 100));
      for (let e = 0; e < cut.edgeCount; e++) {
        expect(cut.edgeAttrs.geodesic[e]).toBe(cut.edgeAttrs.cut[e] === 1 ? 0 : 1);
      }
      expect(Array.from(cut.edgeAttrs.cut).some((v) => v === 1)).toBe(true);
      // A split edge's children are pieces of the same geodesic.
      const split = m.steps(1, (cur, next) => next.split(cur.edge(0)));
      expect(Array.from(split.edgeAttrs.geodesic).every((v) => v === 1)).toBe(true);
    });
  });

  describe(`${name}: smooth rounds the shape, not its samples`, () => {
    it('a smoothed pentagon is the rounded pentagon of flat, placed', () => {
      // The flat outline, smoothed as the engine smooths it, then stepped
      // from the centre: the ink of the smoothed ngon in the space is that
      // curve, and a pentagon's corners are gone.
      const c: Pt = [50, 50];
      const t = toolkit(cfg);
      const s = t.space;
      const drawn = frags(cfg, () => modify([smooth(3)], ngon(c, 5, 30)));
      const exec = compileSketch(sketch(cfg, () => ngon(c, 5, 30)), SQ);
      const f = exec.frame;
      const unit = Math.min(f.inner.innerW, f.inner.innerH) / 100;
      const pts = (drawn as { x0: number; y0: number }[]).map((g): Pt => [(g.x0 - f.offsetX) / unit, (g.y0 - f.offsetY) / unit]);
      expect(pts.length).toBeGreaterThan(30);
      // On the sheet, the smoothed pentagon's farthest point from the
      // projected centre over its nearest is the flat ratio of the smoothed
      // outline — near 1, where the unsmoothed pentagon's is 1/cos 36°.
      const at = s.project(c);
      const radii = pts.map((p) => Math.hypot(p[0] - at[0], p[1] - at[1]));
      const ratio = Math.max(...radii) / Math.min(...radii);
      expect(ratio).toBeLessThan(1.05);
    });

    it('smooth after roughen stays in the engine, in stack order', () => {
      const exec = compileSketch(sketch(cfg, () => ngon(50, 50, 5, 30)), SQ);
      const shape = exec.shapes[0];
      shape.modifiers = [
        { __occludeModifier: true, kind: 'smooth', passes: 2 },
        { __occludeModifier: true, kind: 'roughen', amount: 1 },
        { __occludeModifier: true, kind: 'smooth', passes: 3 },
      ];
      expect(lowerShape(shape, exec.frame).modifiers.map((m) => m.kind)).toEqual(['roughen', 'smooth']);
    });
  });
}

describe('an area keeps the side its winding names', () => {
  it('t.within(() => 1, rect(6, 6, 188, 88)) on a 2:1 sphere reads 1 at the centre', () => {
    const t = toolkit({ aspect: [2, 1], space: { kind: 'spherical', radius: 50 } });
    // A radius whose half circumference is narrower than the rect (the
    // default before it read the half-diagonal).
    expect(Math.PI * t.space.radius).toBeLessThan(188);
    const f = t.within(() => 1, rect(6, 6, 188, 88));
    expect(f(100, 50)).toBe(1);
    expect(f(20, 20)).toBe(1);
    expect(f(180, 80)).toBe(1);
    expect(Number.isNaN(f(2, 2))).toBe(true);
    expect(Number.isNaN(f(198, 98))).toBe(true);
  });

  it('a stroke still takes the short way between two names', () => {
    // An open path across more than half the sphere: its one segment is
    // the short way round, as its author drew it between two names.
    const t = toolkit({ aspect: [2, 1], space: { kind: 'spherical', radius: 50 } });
    const period = 2 * Math.PI * t.space.radius;
    const open = t.material(stroke([[6, 50], [194, 50]])).pts;
    expect(open[1][0]).toBeCloseTo(194 - period, 9);
    // The same edge in a closed loop is walked as drawn.
    const loop = t.material(rect(6, 6, 188, 88)).pts;
    expect(loop.map((p) => p[0])).toEqual([6, 194, 194, 6]);
  });
});

const goldenPath =fileURLToPath(new URL('./shapes-in-space.golden.json', import.meta.url));

describe('flat sketches draw what they drew', () => {
  it('every flat case is bit-identical to the code before the change', () => {
    const now = flatGolden();
    if (process.env.WRITE_GOLDEN === '1' || !existsSync(goldenPath)) {
      writeFileSync(goldenPath, JSON.stringify(now, null, 2) + '\n');
    }
    expect(now).toEqual(JSON.parse(readFileSync(goldenPath, 'utf8')));
  });
});

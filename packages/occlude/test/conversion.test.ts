import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  append, boundaryLoops, circle, compileSketch, connect, curve, distanceTo, force, initOcclude, line, material, ngon, path, polygon, rect,
  render, setPaperHint, sketch, stroke, strokes, mm,
  type Material, type SketchConfig, type SketchDef, type Toolkit,
} from '../src/index.js';
import { isolinesOf, type IsoEnv } from '../src/isolines.js';
import { streamlinesOf } from '../src/streamlines.js';
import { getState } from '../src/state.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
  setPaperHint(200, 200); // Square20: a 100×100 drawable, the kernel env below
});

/** Run a sketch body for its side effects on Square20 (a 100×100 drawable). */
function run(body: (t: Toolkit) => void, opts: SketchConfig = {}): void {
  compileSketch(sketch({ seed: 1, ...opts }, (t) => { body(t); return circle(0, 0, 1); }));
}
const env: IsoEnv = { bounds: { x: 0, y: 0, w: 100, h: 100 }, len: (l) => (typeof l === 'number' ? l : l.value) };
const ink = (def: SketchDef) => render(def, { paper: 'Square20' }).frags.map((f) => JSON.stringify(f.geom)).join('|');

describe('t.material: a shape boundary with its own vertices', () => {
  it('keeps a rectangle\'s four corners and a regular polygon\'s vertices, as rings', () => {
    let r: Material | null = null;
    let n: Material | null = null;
    run((t) => {
      r = t.material(rect(10, 10, 60, 40));
      n = t.material(ngon(50, 50, 7, 20));
    });
    expect(r!.n).toBe(4);
    expect(r!.edgeCount).toBe(4);
    expect(r!.closed).toBe(true);
    expect(r!.pts.map((p) => p.map((v) => +v.toFixed(6)))).toEqual([[10, 10], [70, 10], [70, 50], [10, 50]]);
    expect(n!.n).toBe(7);
    expect(n!.closed).toBe(true);
    for (const [x, y] of n!.pts) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(20, 9);
    // Sampling three points along that rectangle keeps only the start corner.
    let s: Material | null = null;
    run((t) => { s = t.sample(rect(10, 10, 60, 40), { count: 3 }); });
    expect(s!.n).toBe(3);
    expect(s!.pts[0]).toEqual([10, 10]); // the seam is the start
    const corners = new Set(['70,10', '70,50', '10,50']);
    expect(s!.pts.slice(1).some(([x, y]) => corners.has(`${x},${y}`))).toBe(false);
  });

  it('flattens curves at the tolerance and honours transforms, rectMode and the frame', () => {
    let coarse: Material | null = null;
    let fine: Material | null = null;
    let turned: Material | null = null;
    let centred: Material | null = null;
    run((t) => {
      coarse = t.material(circle(50, 50, 20), { tolerance: mm(1) });
      fine = t.material(circle(50, 50, 20));
      turned = t.material(rect(0, 0, 20, 10, { translate: [50, 50], rotate: 90 }));
      centred = t.material(rect(50, 50, 20, 10, { mode: 'center' }));
    });
    expect(coarse!.n).toBeLessThan(fine!.n);
    expect(fine!.closed).toBe(true);
    for (const [x, y] of fine!.pts) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(20, 1);
    const xs = turned!.pts.map((p) => +p[0].toFixed(6)).sort((a, b) => a - b);
    const ys = turned!.pts.map((p) => +p[1].toFixed(6)).sort((a, b) => a - b);
    expect([xs[0], xs[3]]).toEqual([40, 50]); // 10 wide after the turn
    expect([ys[0], ys[3]]).toEqual([50, 70]); // 20 tall
    expect(centred!.pts.map((p) => +p[0].toFixed(6)).sort((a, b) => a - b)[0]).toBe(40);
    // A 2:1 drawable: units are still percent of the short side.
    let wide: Material | null = null;
    run((t) => { wide = t.material(rect(0, 0, 200, 100)); }, { aspect: [2, 1] });
    expect(wide!.pts.map((p) => +p[0].toFixed(6)).sort((a, b) => b - a)[0]).toBe(200);
  });

  it('keeps a path\'s open and closed subpaths separate, never welding coincident points', () => {
    let m: Material | null = null;
    run((t) => {
      m = t.material(path().moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).close().moveTo(10, 10).lineTo(30, 10).build());
    });
    const cs = m!.curves();
    expect(cs).toHaveLength(2);
    const ring = cs.find((c) => c.closed)!;
    const chain = cs.find((c) => !c.closed)!;
    expect(ring.pts).toHaveLength(3);            // no duplicate seam vertex
    expect(chain.pts).toEqual([[10, 10], [30, 10]]);
    // Rows keep contour order: the ring's three vertices, then the chain's two.
    expect(m!.pts).toEqual([[0, 0], [10, 0], [10, 10], [10, 10], [30, 10]]);
    expect(m!.n).toBe(5);                         // (10, 10) exists twice, one per contour
    expect(m!.degree(2)).toBe(2);
    expect(m!.degree(3)).toBe(1);
    expect(() => run((t) => t.material([[1, 2]] as never))).toThrow(/expected a shape/);
  });

  it('sample: outputs unchanged in count, spacing and closure', () => {
    let byCount: Material | null = null;
    let bySpacing: Material | null = null;
    run((t) => {
      byCount = t.sample(circle(50, 50, 10), { count: 12 });
      bySpacing = t.sample(line(0, 0, 100, 0), { spacing: 10 });
    });
    expect(byCount!.n).toBe(12);
    expect(byCount!.closed).toBe(true);
    for (const [x, y] of byCount!.pts) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(10, 1);
    expect(bySpacing!.closed).toBe(false);
    expect(bySpacing!.n).toBe(11);
    expect(bySpacing!.pts[10]).toEqual([100, 0]);
  });
});

describe('isolines and streamlines as material', () => {
  const bowl = (x: number, y: number): number => 40 - Math.hypot(x - 50, y - 50);

  it('one material per call: chains in contour order, levels on the edges, geometry identical to the kernel', () => {
    let m: Material | null = null;
    run((t) => { m = t.isolines(bowl, [10, 25, 10, 50], { step: 1 }); });
    const raw = isolinesOf(env, bowl, [10, 25, 10, 50], { step: 1 });
    const cs = m!.curves();
    expect(cs).toHaveLength(3); // 10, 25, 10 again; 50 is empty and adds nothing
    expect(raw[3]).toHaveLength(0);
    expect(cs.map((c) => c.pts)).toEqual([raw[0][0].pts, raw[1][0].pts, raw[2][0].pts]);
    expect(cs.every((c) => c.closed)).toBe(true);
    expect(m!.edgeAttrNames).toEqual(['level']);
    expect(m!.edgeTransfers.level).toBe('copy');
    const levels = new Set(Array.from(m!.edgeAttrs.level));
    expect([...levels].sort((a, b) => a - b)).toEqual([10, 25]);
    // Selecting by value takes both rings at level 10.
    const ten = m!.edges.filter((e) => e.attrs.level === 10);
    expect(ten.curves()).toHaveLength(2);
    expect(m!.edges.filter((e) => e.attrs.level === 25).curves()).toHaveLength(1);
    // A scalar level is the same material as a one-element array.
    let single: Material | null = null;
    run((t) => { single = t.isolines(bowl, 25, { step: 1 }); });
    expect(single!.pts).toEqual(m!.edges.filter((e) => e.attrs.level === 25).extract().pts);
  });

  it('subdivision copies the level; an empty result is an empty material', () => {
    let split: Material | null = null;
    let none: Material | null = null;
    run((t) => {
      const m = t.isolines(bowl, 25, { step: 2 });
      split = m.steps(1, (cur, next) => next.splitEdges(() => true));
      none = t.isolines(bowl, 500, { step: 2 });
    });
    expect(split!.edgeCount).toBeGreaterThan(0);
    expect(Array.from(split!.edgeAttrs.level).every((v) => v === 25)).toBe(true);
    expect(none!.n).toBe(0);
    expect(none!.edgeCount).toBe(0);
    expect(none!.curves()).toEqual([]);
    expect(none!.edgeAttrNames).toEqual(['level']);
  });

  it('streamlines: open chains in the kernel\'s order, positions intact, editable', () => {
    const swirl = (x: number, y: number): [number, number] => [-(y - 50), x - 50];
    let m: Material | null = null;
    let moved: Material | null = null;
    run((t) => {
      m = t.streamlines(swirl, { spacing: 6 });
      moved = m.attribute('h', (p) => p.x).steps(2, (cur, next) => next.move(() => [1, 0]));
    });
    const raw = streamlinesOf(env, swirl, { spacing: 6 });
    const cs = m!.curves();
    expect(cs).toHaveLength(raw.length);
    expect(cs.every((c) => !c.closed)).toBe(true);
    expect(cs.map((c) => c.pts)).toEqual(raw.map((c) => c.pts));
    expect(m!.edgeAttrNames).toEqual([]);
    expect(moved!.x[0]).toBeCloseTo(m!.x[0] + 2, 9);
    expect(moved!.attrs.h[0]).toBe(m!.x[0]);
  });

  it('the ink of strokes(material) equals the ink of the old per-contour stamping', () => {
    const viaMaterial = sketch({ seed: 2 }, (t) => strokes(t.isolines(bowl, [10, 25], { step: 1 })));
    const viaContours = sketch({ seed: 2 }, () => isolinesOf(env, bowl, [10, 25], { step: 1 }).flat().map((c) => stroke(c)));
    expect(ink(viaMaterial)).toBe(ink(viaContours));
  });
});

describe('one boundary contract', () => {
  const sq = (x0: number, y0: number, s: number): [number, number][] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

  it('loops, a single loop, contour records and a chain material resolve to the same loops', () => {
    const loop = sq(10, 10, 20);
    const asLoops = boundaryLoops([loop], 'test');
    expect(boundaryLoops(loop, 'test')).toEqual(asLoops);
    expect(boundaryLoops({ pts: loop, closed: true }, 'test')).toEqual(asLoops);
    expect(boundaryLoops([{ pts: loop, closed: true }], 'test')).toEqual(asLoops);
    expect(boundaryLoops(curve(loop), 'test')).toEqual(asLoops);
    expect(boundaryLoops(loop.map(([x, y]) => ({ x, y })), 'test')).toEqual(asLoops);
    expect(boundaryLoops([], 'test')).toEqual([]);
    // Equivalent distance fields and polygons.
    const d1 = distanceTo([loop]);
    const d2 = distanceTo(curve(loop));
    const d3 = distanceTo({ pts: loop, closed: true });
    for (const [x, y] of [[20, 20], [12, 20], [5, 20], [0, 0]]) {
      expect(d2(x, y)).toBe(d1(x, y));
      expect(d3(x, y)).toBe(d1(x, y));
    }
    const p1 = polygon([loop]);
    const p2 = polygon(curve(loop));
    expect(JSON.stringify(p2.geom)).toBe(JSON.stringify(p1.geom));
  });

  it('detects points against loops by the first entry, never by shape guesses', () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const objects = square.map(([x, y]) => ({ x, y }));
    // A leading empty loop is a loop, not a point.
    expect(boundaryLoops([[], square], 'test')).toEqual([[], square]);
    expect(distanceTo([[], square])(5, 5)).toBe(5);
    // Loops of { x, y } points, nested, are loops.
    expect(boundaryLoops([objects], 'test')).toEqual([square]);
    expect(boundaryLoops([objects, objects.slice(0, 2)], 'test')).toHaveLength(2);
    expect(distanceTo([objects])(5, 5)).toBe(5);
    expect(distanceTo(objects)(5, 5)).toBe(5);
    expect(force.boundary([[], square], { radius: 4 })([1, 5])[0]).toBeGreaterThan(0);
    expect(force.boundary([objects], { radius: 4 })([1, 5])[0]).toBeGreaterThan(0);
    // Extra entries on a point are ignored; a bad entry is named.
    expect(boundaryLoops([[[0, 0, 9], [10, 0, 9]]], 'test')).toEqual([[[0, 0], [10, 0]]]);
    expect(() => boundaryLoops([[[0, 0], 'no']] as never, 'test')).toThrow(/loop entry 1 is not a point/);
    expect(() => boundaryLoops([['a', 'b']] as never, 'test')).toThrow(/expected loops of points/);
  });

  it('holes, chord closure, isolated points, empties and branching', () => {
    // A ring with a hole from two components of one material.
    const withHole = connect.ring(material(sq(0, 0, 30)));
    const hole = connect.ring(material(sq(10, 10, 10)));
    const both = boundaryLoops(append(withHole, hole), 'test');
    expect(both).toHaveLength(2);
    const d = distanceTo(both);
    expect(d(15, 15)).toBeCloseTo(-5, 9);
    // An open chain closes with a chord, exactly as the loop did.
    const open = connect.chain(material([[0, 0], [10, 0], [10, 10]]));
    expect(distanceTo(open)(3, 1)).toBe(distanceTo([[[0, 0], [10, 0], [10, 10]]])(3, 1));
    // Isolated points contribute nothing; an empty material is an empty boundary.
    expect(boundaryLoops(material([[4, 4], [5, 5]]), 'test')).toEqual([]);
    expect(distanceTo(material([]))(1, 2)).toBe(-Infinity);
    // Branching is refused with the way out named.
    const y = material([[0, 0], [10, 0], [20, 10], [20, -10]], { edges: [[0, 1], [1, 2], [1, 3]] });
    expect(() => distanceTo(y)).toThrow(/branches.*edges\.filter.*faces/);
    expect(() => polygon(y)).toThrow(/polygon: this material branches/);
    expect(() => force.boundary(y, { radius: 2 })).toThrow(/force.boundary: this material branches/);
    // Drawing a branching material still works.
    expect(strokes(y)).toHaveLength(3);
  });

  it('a generated material serves the boundary consumers and the step rule alike', () => {
    let out: { inside: number; keep: [number, number]; n: number } | null = null;
    run((t) => {
      const box = t.material(rect(20, 20, 60, 60));
      const d = distanceTo(box);
      const keep = force.boundary(box, { radius: 10, strength: 1 });
      const contours = t.isolines((x, y) => d(x, y), [5, 15], { step: 1 });
      const grown = contours.steps(3, (cur, next) => {
        const push = force.tension(cur, { rest: 0.5 });
        next.move((p) => push(p));
      });
      out = { inside: d(50, 50), keep: keep([22, 50]), n: grown.n };
    });
    expect(out!.inside).toBeCloseTo(30, 9);
    expect(out!.keep[0]).toBeGreaterThan(0);        // pushed inward, away from the left wall
    expect(Math.abs(out!.keep[1])).toBeLessThan(1e-9);
    expect(out!.n).toBeGreaterThanOrEqual(8);        // two squares of corners after the colinear merge
        expect(getState().shapes.length).toBe(1);        // nothing drawn by the conversions themselves
  });
});

describe('closure is per contour, and the two winding defaults stay put', () => {
  const mixed = () => path()
    .moveTo(10, 10).lineTo(40, 10).lineTo(40, 40).close()
    .moveTo(60, 10).lineTo(90, 40)
    .build();

  it('keeps a closed and an open subpath in one path apart, through both conversions', () => {
    let kept: Array<{ closed: boolean; n: number }> = [];
    let sampled: Array<{ closed: boolean; n: number }> = [];
    run((t) => {
      const p = mixed();
      kept = t.material(p).curves().map((c) => ({ closed: c.closed, n: c.pts.length }));
      sampled = t.sample(p, { count: 8 }).curves().map((c) => ({ closed: c.closed, n: c.pts.length }));
    });
    expect(kept.map((c) => c.closed)).toEqual([true, false]);
    expect(kept.map((c) => c.n)).toEqual([3, 2]);      // corners kept: the ring's 3 + the L's 2
    expect(sampled.map((c) => c.closed)).toEqual([true, false]);
    expect(sampled.every((c) => c.n === 8)).toBe(true); // redistributed
  });

  it('reads areas even-odd and paths non-zero — a documented pair, not an accident', () => {
    // Two nested squares traced the SAME way (both counter-clockwise). Even
    // odd nests, so the inner one is a hole; non-zero is decided by
    // orientation, so it stays filled. The two constructors' defaults land
    // on those different readings on purpose — `polygon` asks for areas
    // (marching-squares contours promise no orientation), `path` follows the
    // geometry the way SVG does. Pinned here so a silent unification shows up
    // as an ink change.
    const outer: [number, number][] = [[20, 20], [80, 20], [80, 80], [20, 80]];
    const inner: [number, number][] = [[35, 35], [65, 35], [65, 65], [35, 65]];
    const traced = path({ winding: 'nonzero' });
    for (const loop of [outer, inner]) {
      traced.moveTo(loop[0][0], loop[0][1]);
      for (let k = 1; k < loop.length; k++) traced.lineTo(loop[k][0], loop[k][1]);
      traced.close();
    }
    const asPath = traced.build({ stroke: false, opaque: true });
    const rows = [0, 1, 2, 3, 4, 5].map((k) => line(0, 12 + k * 15, 100, 12 + k * 15));
    const evenodd = ink(sketch({}, () => [...rows, polygon([outer, inner], { stroke: false, opaque: true })]));
    const nonzero = ink(sketch({}, () => [...rows, asPath]));
    expect(nonzero).not.toBe(evenodd);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  append, circle, clip, compileSketch, initOcclude, material, path, polygon, rect, render,
  setPaperHint, sketch, within,
  type Face, type Faces, type Material, type PointSelection, type SketchDef, type ShapeValue, type Toolkit, type XY,
} from '../src/index.js';
import type { Loop } from '../src/boundary.js';
import { scatterPoints } from '../src/points.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
  setPaperHint(200, 200);
});

/** Run a sketch body for its side effects, on a 100×100 drawable. */
function run(body: (t: Toolkit) => void): void {
  compileSketch(sketch({ seed: 1 }, (t) => { body(t); return []; }));
}

/** A straight two-vertex edge between two points. */
const chord = (x0: number, y0: number, x1: number, y1: number): Material =>
  material([[x0, y0], [x1, y1]], { edges: [[0, 1]] });

const pointsOf = (m: Material): string =>
  Array.from({ length: m.n }, (_, i) => `${m.pts[i][0]},${m.pts[i][1]}`).sort().join(' ');

const ring: Loop = [[10, 10], [90, 10], [90, 90], [10, 90]];
const hole: Loop = [[40, 40], [60, 40], [60, 60], [40, 60]];

describe('within: a material inside an area', () => {
  it('cuts a chord at the boundary, and the ends land ON it', () => {
    let out: Material | null = null;
    run((t) => { out = t.within(chord(-100, 50, 200, 50), rect(20, 20, 60, 60)); });
    expect(out!.n).toBe(2);
    expect(out!.edgeCount).toBe(1);
    expect(pointsOf(out!)).toBe('20,50 80,50');
  });

  it('drops an edge that is entirely outside, and keeps one entirely inside', () => {
    let out: Material | null = null;
    let kept: Material | null = null;
    run((t) => {
      out = t.within(chord(-100, 50, -10, 50), rect(20, 20, 60, 60));
      kept = t.within(chord(30, 30, 70, 70), rect(20, 20, 60, 60));
    });
    expect(out!.n).toBe(0);
    expect(out!.edgeCount).toBe(0);
    expect(pointsOf(kept!)).toBe('30,30 70,70');
  });

  it('keeps both pieces of a chord through a ring with a hole (even-odd)', () => {
    let out: Material | null = null;
    run((t) => { out = t.within(chord(-50, 50, 150, 50), [ring, hole]); });
    expect(out!.edgeCount).toBe(2);
    expect(pointsOf(out!)).toBe('10,50 40,50 60,50 90,50');
  });

  it('interpolates a cut vertex by the column policy, and keeps iteration', () => {
    let out: Material | null = null;
    run((t) => {
      const m = material([[0, 50], [100, 50]], { edges: [[0, 1]] })
        .attribute('v', (p) => p.x / 100)
        .attribute('cat', (p) => (p.x < 50 ? 1 : 9), { transfer: 'nearest' })
        .steps(2, () => { /* nothing moves: two iterations, for the count */ });
      out = t.within(m, rect(20, 20, 60, 60));
    });
    expect(out!.iteration).toBe(2);          // an area edit is not a step
    expect(out!.history.length).toBe(0);
    // Cut at x = 20 and x = 80: v interpolates to 0.2 and 0.8; cat is copied.
    const rows = Array.from({ length: out!.n }, (_, i) => [out!.pts[i][0], out!.attrs.v[i], out!.attrs.cat[i]]);
    expect(rows).toEqual([[20, 0.2, 1], [80, 0.8, 9]]);
  });

  it('takes a shape and its loops as the same area', () => {
    let byShape: Material | null = null;
    let byLoops: Material | null = null;
    run((t) => {
      const m = chord(-50, 50, 150, 50);
      byShape = t.within(m, rect(20, 20, 60, 60));
      byLoops = t.within(m, [[20, 20], [80, 20], [80, 80], [20, 80]] as XY[]);
    });
    expect(pointsOf(byShape!)).toBe(pointsOf(byLoops!));
    expect(pointsOf(byShape!)).toBe('20,50 80,50');
  });

  it('keeps a point that is inside and drops one that is not', () => {
    let out: Material | null = null;
    run((t) => { out = t.within(material([[30, 30], [90, 90]]), rect(20, 20, 60, 60)); });
    expect(pointsOf(out!)).toBe('30,30');
  });
});

describe('within: points and faces', () => {
  it('returns a selection of the inside points, chainable like any selection', () => {
    let length = 0;
    let more = 0;
    let indices: readonly number[] = [];
    run((t) => {
      const m = material([[10, 10], [50, 50], [70, 70], [95, 95]]).attribute('k', (p) => p.x);
      const sel: PointSelection = t.within(m.points, rect(20, 20, 60, 60));
      length = sel.length;
      more = sel.filter((p) => p.k > 60).length;
      indices = sel.indices;
    });
    expect(length).toBe(2);
    expect(more).toBe(1);
    expect(indices).toEqual([1, 2]);
  });

  it('keeps the faces lying entirely inside, and no straddling one', () => {
    let all = 0;
    let kept: Face[] = [];
    run((t) => {
      const square = material([[20, 20], [80, 20], [80, 80], [20, 80]], { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] });
      const grid = append(append(square, chord(20, 50, 80, 50)), chord(50, 20, 50, 80)).planarize();
      all = grid.faces().length;
      kept = [...t.within(grid.faces(), rect(10, 10, 50, 50))];
    });
    // Four 30×30 cells; the frame reaches to 60, so only the one at 20…50
    // is inside it whole.
    expect(all).toBe(4);
    expect(kept.length).toBe(1);
    expect([kept[0].bounds.x, kept[0].bounds.y]).toEqual([20, 20]);
  });

  it("'contained' and 'centroid' answer the frame's edge differently", () => {
    let contained = 0;
    let def = 0;
    let centroid = 0;
    let bounds: number[][] = [];
    run((t) => {
      const square = material([[20, 20], [80, 20], [80, 80], [20, 80]], { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] });
      const grid = append(append(square, chord(20, 50, 80, 50)), chord(50, 20, 50, 80)).planarize().faces();
      // A frame whose right and bottom edges cut the far half of the grid,
      // past the centre of the cells they cut.
      const frame = rect(10, 10, 60, 60);
      contained = t.within(grid, frame, { faces: 'contained' }).length;
      def = t.within(grid, frame).length;
      const byCentre = t.within(grid, frame, { faces: 'centroid' });
      centroid = byCentre.length;
      bounds = byCentre.map((f) => [f.bounds.x, f.bounds.y]);
    });
    // Cut through, so not contained — but their centres are inside (65, 35
    // and so on), so they are kept whole and their ink reaches past the
    // frame.
    expect(contained).toBe(1);
    expect(def).toBe(contained); // the default is 'contained'
    expect(centroid).toBe(4);
    expect(bounds).toEqual([[20, 20], [50, 20], [50, 50], [20, 50]]);
  });

  it('refuses an option from the wrong domain, and an unknown rule', () => {
    const errors: string[] = [];
    const catchIt = (fn: () => unknown): void => {
      try { fn(); } catch (e) { errors.push((e as Error).message); }
    };
    run((t) => {
      const cells = material([[20, 20], [80, 20], [80, 80], [20, 80]], { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] })
        .planarize().faces();
      // Each of these is deliberately the wrong option for its domain (or an
      // unknown rule): `as never` states that the call is meant to throw.
      catchIt(() => t.within(cells, rect(10, 10, 60, 60), { faces: 'nope' } as never));
      catchIt(() => t.within(cells, rect(10, 10, 60, 60), { transfer: 'nearest' } as never));
      catchIt(() => t.within(chord(-50, 50, 150, 50), rect(10, 10, 60, 60), { faces: 'centroid' } as never));
    });
    expect(errors[0]).toMatch(/faces must be 'contained' or 'centroid'/);
    expect(errors[1]).toMatch(/'transfer' is for a material/);
    expect(errors[2]).toMatch(/'faces' is for a face collection/);
  });

  it('still bounds a field', () => {
    let outside = 0;
    let inside = 0;
    run((t) => {
      const f = t.within((x: number, y: number) => x, rect(20, 20, 60, 60));
      outside = f(5, 50);
      inside = f(40, 50);
    });
    expect(inside).toBe(40);
    expect(Number.isFinite(outside)).toBe(false); // absent outside the bound
  });
});

describe('within: the point operations', () => {
  const box = { x: 20, y: 20, w: 60, h: 60 };
  const coords = (m: Material): string =>
    Array.from({ length: m.n }, (_, i) => `${m.pts[i][0]},${m.pts[i][1]}`).join(' ');

  it('relaxes inside a rectangle exactly as bounds does, and keeps a circle', () => {
    let byBounds: Material | null = null;
    let byWithin: Material | null = null;
    let byCircle: Material | null = null;
    run((t) => {
      const dots = t.scatter(() => 1, { spacing: 6 });
      byBounds = t.relax(dots, { iterations: 3, bounds: box });
      byWithin = t.relax(dots, { iterations: 3, within: rect(20, 20, 60, 60) });
      byCircle = t.relax(dots, { iterations: 3, within: circle(50, 50, 30) });
    });
    // A rectangle IS its own box, so the two spellings are the same run.
    expect(coords(byWithin!)).toBe(coords(byBounds!));
    // A circle is not: the box drives the relaxation, then the outside goes.
    expect(byCircle!.n).toBeLessThan(byBounds!.n);
    expect(byCircle!.n).toBeGreaterThan(0);
    for (let i = 0; i < byCircle!.n; i++) {
      const [x, y] = byCircle!.pts[i];
      expect(Math.hypot(x - 50, y - 50)).toBeLessThan(30.000001);
    }
  });

  it('settles inside a rectangle exactly as bounds does', () => {
    let byBounds: Material | null = null;
    let byWithin: Material | null = null;
    run((t) => {
      const dots = t.scatter(() => 1, { spacing: 8 });
      const o = { density: () => 1, spacing: 8, iterations: 4 };
      byBounds = t.settle(dots, { ...o, bounds: box });
      byWithin = t.settle(dots, { ...o, within: rect(20, 20, 60, 60) });
    });
    expect(coords(byWithin!)).toBe(coords(byBounds!));
  });

  it('scatters only inside the area it is given', () => {
    let out: Material | null = null;
    run((t) => { out = t.scatter(() => 1, { spacing: 6, within: circle(50, 50, 25) }); });
    expect(out!.n).toBeGreaterThan(0);
    for (let i = 0; i < out!.n; i++) {
      const [x, y] = out!.pts[i];
      expect(Math.hypot(x - 50, y - 50)).toBeLessThan(25.000001);
    }
  });

  it('clips voronoi to a rectangle, and names the trim for anything else', () => {
    const sites = [[30, 30], [70, 40], [50, 75]] as XY[];
    let byBounds: Material | null = null;
    let byWithin: Material | null = null;
    let message = '';
    run((t) => {
      const m = material(sites);
      byBounds = t.voronoi(m, { bounds: box });
      byWithin = t.voronoi(m, { within: rect(20, 20, 60, 60) });
      try {
        t.voronoi(m, { within: circle(50, 50, 30) });
      } catch (e) {
        message = (e as Error).message;
      }
    });
    expect(coords(byWithin!)).toBe(coords(byBounds!));
    expect(message).toMatch(/needs a rectangle .*within\(t\.voronoi\(sites\), area\)/);
  });

  it('refuses bounds and within together, and refuses a shape in the kernel', () => {
    let message = '';
    run((t) => {
      try {
        t.relax(material([[30, 30]]), { bounds: box, within: rect(20, 20, 60, 60) });
      } catch (e) {
        message = (e as Error).message;
      }
    });
    expect(message).toMatch(/give bounds or within, not both/);
    // A shape never reaches the pure kernel: the toolkit lowers it first.
    const env = { rnd: () => 0.5, bounds: { x: 0, y: 0, w: 100, h: 100 }, len: () => 5 };
    expect(() => scatterPoints(env, undefined, { spacing: 5, within: circle(50, 50, 20) }))
      .toThrow(/lowered by the toolkit/);
  });
});

describe('within: the filled region, not the contours', () => {
  /** The task's area: a square with a concentric inner square, both wound the
   * same way (`nonzero` says solid, `evenodd` says ring). */
  const nested = (opts: { inner?: 'same' | 'reversed'; winding?: 'nonzero' | 'evenodd' } = {}): ShapeValue => {
    const { inner = 'same', winding = 'nonzero' } = opts;
    const b = path({ winding })
      .moveTo(10, 10).lineTo(90, 10).lineTo(90, 90).lineTo(10, 90).close();
    return (inner === 'same'
      ? b.moveTo(40, 40).lineTo(60, 40).lineTo(60, 60).lineTo(40, 60)
      : b.moveTo(40, 40).lineTo(40, 60).lineTo(60, 60).lineTo(60, 40))
      .close().build();
  };

  const rectFace = (x0: number, y0: number, x1: number, y1: number): Faces =>
    material([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] })
      .planarize().faces();

  it('counts a point on an interior contour as inside, for a material and a selection', () => {
    let vertices = -1;
    let selected = -1;
    run((t) => {
      const area = nested();
      // [50, 40] lies ON the inner contour. Under nonzero the space on both
      // sides of that contour is filled, so it is not a boundary at all.
      vertices = t.within(material([[50, 40], [20, 20]]), area).n;
      selected = t.within(material([[50, 40], [20, 20]]).points, area).length;
    });
    expect(vertices).toBe(2);
    expect(selected).toBe(2);
  });

  it('keeps an edge lying along an interior contour, whole', () => {
    let pts = '';
    let edges = 0;
    run((t) => {
      const kept = t.within(chord(45, 40, 55, 40), nested());
      pts = pointsOf(kept);
      edges = kept.edgeCount;
    });
    expect(edges).toBe(1);
    expect(pts).toBe('45,40 55,40'); // not clipped, not dropped
  });

  it('keeps faces that enclose or cross an interior contour', () => {
    let enclosing = 0;
    let crossing = 0;
    run((t) => {
      enclosing = t.within(rectFace(20, 20, 80, 80), nested()).length;
      crossing = t.within(rectFace(30, 45, 50, 55), nested()).length;
    });
    expect(enclosing).toBe(1);
    expect(crossing).toBe(1);
  });

  it('still treats the inner region as a real hole when the rule says so', () => {
    let evenoddFaces = 0;
    let reversedFaces = 0;
    let evenoddSpan = 0;
    let reversedSpan = 0;
    run((t) => {
      const ring = nested({ winding: 'evenodd' });
      const reversed = nested({ inner: 'reversed' });
      evenoddFaces = t.within(rectFace(20, 20, 80, 80), ring).length;
      reversedFaces = t.within(rectFace(20, 20, 80, 80), reversed).length;
      for (const [area, which] of [[ring, 'e'], [reversed, 'r']] as const) {
        const kept = t.within(chord(-50, 50, 150, 50), area);
        let mm = 0;
        for (let e = 0; e < kept.edgeCount; e++) {
          const [a, b] = [kept.edgeList[2 * e], kept.edgeList[2 * e + 1]];
          mm += Math.abs(kept.pts[b][0] - kept.pts[a][0]);
        }
        if (which === 'e') evenoddSpan = mm; else reversedSpan = mm;
      }
    });
    expect(evenoddFaces).toBe(0); // the face covers the hole
    expect(reversedFaces).toBe(0);
    expect(evenoddSpan).toBeCloseTo(60, 6); // 10…40 and 60…90
    expect(reversedSpan).toBeCloseTo(60, 6);
  });

  it('keeps an annular face that shares the genuine hole boundary', () => {
    let kept = 0;
    let contours = 0;
    run((t) => {
      const area = nested({ winding: 'evenodd' });
      const outer = [[10, 10], [90, 10], [90, 90], [10, 90]] as XY[];
      const holePts = [[40, 40], [60, 40], [60, 60], [40, 60]] as XY[];
      const ring = append(
        material(outer, { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] }),
        material(holePts, { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] }),
      ).planarize().faces();
      const faces = [...t.within(ring, area, { faces: 'contained' })];
      kept = faces.length;
      contours = faces[0]?.contours.length ?? 0;
    });
    expect(kept).toBe(1); // its wall runs along the hole, not across it
    expect(contours).toBe(2); // outer + hole
  });
});

describe('within: holes and winding', () => {
  it('uses the union boundary of intersecting nonzero contours for every consumer', () => {
    run((t) => {
      const a: Loop = [[10, 10], [70, 10], [70, 70], [10, 70]];
      const b: Loop = [[40, 40], [90, 40], [90, 90], [40, 90]];
      const area = polygon([a, b], { winding: 'nonzero' });
      expect(pointsOf(t.within(chord(0, 20, 100, 20), area))).toBe('10,20 70,20');
      expect(pointsOf(t.within(chord(0, 50, 100, 50), area))).toBe('10,50 90,50');
      const points = material([[70, 20], [70, 50], [95, 50]]);
      expect(pointsOf(t.within(points, area))).toBe('70,50');
      expect(t.within(points.points, area).indices).toEqual([1]);
      const face = t.material(rect(60, 45, 20, 20)).planarize().faces();
      expect(t.within(face, area).length).toBe(1); // crosses the redundant edge at x=70
    });
  });

  it('reinforces or cancels coincident contours according to winding', () => {
    run((t) => {
      const loop: Loop = [[10, 10], [70, 10], [70, 70], [10, 70]];
      const solid = polygon([loop, loop], { winding: 'nonzero' });
      const cancelled = polygon([loop, [...loop].reverse()], { winding: 'nonzero' });
      const parity = polygon([loop, loop]);
      const face = t.material(rect(10, 10, 60, 60)).planarize().faces();
      expect(t.within(face, solid).length).toBe(1);
      expect(pointsOf(t.within(chord(0, 20, 100, 20), solid))).toBe('10,20 70,20');
      for (const empty of [cancelled, parity]) {
        expect(t.within(face, empty).length).toBe(0);
        const points = material([[40, 10], [40, 40]]);
        expect(t.within(points, empty).n).toBe(0);
        expect(t.within(points.points, empty).length).toBe(0);
        expect(t.within(chord(0, 20, 100, 20), empty).edgeCount).toBe(0);
      }
    });
  });

  it('refuses a face whose interior covers a container hole', () => {
    let spanning = 0;
    let withoutHole = 0;
    let away = 0;
    run((t) => {
      const spanningFaces = material([[20, 20], [80, 20], [80, 80], [20, 80]], { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] })
        .planarize().faces();
      const awayFaces = material([[15, 15], [30, 15], [30, 30], [15, 30]], { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] })
        .planarize().faces();
      spanning = t.within(spanningFaces, [ring, hole], { faces: 'contained' }).length;
      withoutHole = t.within(spanningFaces, [ring], { faces: 'contained' }).length;
      away = t.within(awayFaces, [ring, hole], { faces: 'contained' }).length;
    });
    // Every vertex is inside and no edge crosses — but the face's interior
    // covers the hole, which is excluded space, so it is not contained.
    expect(spanning).toBe(0);
    expect(withoutHole).toBe(1); // the hole is the only thing that rejects it
    expect(away).toBe(1); // and a face clear of the hole is kept
  });

  it("reads a shape area's own winding rule, agreeing with the field bound", () => {
    let byField = 0;
    let covered = 0;
    let pointsKept = 0;
    run((t) => {
      // Two nested loops in the SAME direction: even-odd calls the inner one a
      // hole, a path's `nonzero` default counts it as solid.
      const nested = path()
        .moveTo(10, 10).lineTo(90, 10).lineTo(90, 90).lineTo(10, 90).close()
        .moveTo(40, 40).lineTo(60, 40).lineTo(60, 60).lineTo(40, 60).close()
        .build();
      const bounded = within(() => 1, nested);
      byField = Number.isFinite(bounded(50, 50)) ? 1 : 0;
      // The redundant inner contour does not cut the run. The whole 10…90
      // span survives. Under
      // an even-odd reading the middle was a hole and only 10…40 and 60…90 did.
      const kept = t.within(chord(-50, 50, 150, 50), nested);
      let mm = 0;
      for (let e = 0; e < kept.edgeCount; e++) {
        const [a, b] = [kept.edgeList[2 * e], kept.edgeList[2 * e + 1]];
        mm += Math.abs(kept.pts[b][0] - kept.pts[a][0]);
      }
      covered = mm;
      pointsKept = t.within(material([[50, 50], [15, 15]]).points, nested).length;
    });
    expect(byField).toBe(1); // the field bound reads the winding
    expect(covered).toBeCloseTo(80, 6); // 10…90, middle included
    expect(pointsKept).toBe(2); // the centre is inside, not a hole
  });

  it("polygon() reads a path's own winding unless the options override it", () => {
    const nestedPath = (): ShapeValue => path()
      .moveTo(10, 10).lineTo(90, 10).lineTo(90, 90).lineTo(10, 90).close()
      .moveTo(40, 40).lineTo(60, 40).lineTo(60, 60).lineTo(40, 60).close()
      .build();
    const frags = (def: SketchDef): number => render(def, { paper: 'Square20' }).frags.length;
    const nonzero = frags(sketch({ seed: 1 }, () => clip(polygon(nestedPath()), circle(50, 50, 5))));
    const evenodd = frags(sketch({ seed: 1 }, () => clip(polygon(nestedPath(), { winding: 'evenodd' }), circle(50, 50, 5))));
    expect(nonzero).toBeGreaterThan(0); // inside the solid middle
    expect(evenodd).toBe(0); // inside a hole: nothing survives
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  append, circle, compileSketch, initOcclude, material, rect, setPaperHint, sketch,
  type Face, type Loop, type Material, type PointSelection, type Toolkit, type XY,
} from '../src/index.js';
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

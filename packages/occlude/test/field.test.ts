import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, compileSketch, fill, group, initOcclude, mm, path, rect, render, rotate, scale,
  setPaperHint, sketch, trace, translate, vectorField, within,
} from '../src/index.js';
import { isolinesOf, type IsoEnv } from '../src/isolines.js';
import type { RenderOptions, SketchDef } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

const sq = (def: SketchDef, opts: RenderOptions = {}) =>
  render(def, { paper: 'Square20', ...opts });

const env: IsoEnv = {
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  len: (l) => (typeof l === 'number' ? l : l.value),
};

describe('field transforms', () => {
  it('rotate turns a scalar landscape about the origin', () => {
    const f = (x: number, _y: number): number => x; // gradient along +x
    const g = rotate(f, 90);
    // After rotating the field 90°, the gradient runs along +y.
    expect(g(0, 5)).toBeCloseTo(5, 9);
    expect(g(5, 0)).toBeCloseTo(0, 9);
  });

  it('translate moves the pattern', () => {
    const f = (x: number, y: number): number => (x === 0 && y === 0 ? 1 : 0);
    const g = translate(f, 10, 20);
    expect(g(10, 20)).toBe(1);
    expect(g(0, 0)).toBe(0);
  });

  it('scale stretches sampling without touching values', () => {
    const f = (x: number, _y: number): number => x;
    const g = scale(f, 2);
    expect(g(10, 0)).toBeCloseTo(5, 9); // samples at x/2
  });

  it('vector fields: rotation rotates the arrows (iron-filings rule)', () => {
    const wind = vectorField(() => [1, 0]); // east everywhere
    const g = rotate(wind, 90) as (x: number, y: number) => [number, number];
    const [dx, dy] = g(0, 0);
    expect(dx).toBeCloseTo(0, 9);
    expect(dy).toBeCloseTo(1, 9); // now north(+y)
  });

  it('vector fields: scale never scales magnitudes', () => {
    const wind = vectorField(() => [3, 4]); // magnitude 5
    const g = scale(wind, [2, 1]) as (x: number, y: number) => [number, number];
    const [dx, dy] = g(0, 0);
    expect(Math.hypot(dx, dy)).toBeCloseTo(5, 9); // direction tilts, |v| kept
    expect(Math.abs(dx)).toBeGreaterThan(3); // tilted toward the stretch
  });

  it('a transformed field is still a callable lambda-composes', () => {
    const f = rotate((x: number) => x, 90);
    const combined = (x: number, y: number): number => f(x, y) * 2;
    expect(combined(0, 5)).toBeCloseTo(10, 9);
  });
});

describe('within: domain bounds and absence', () => {
  it('absent outside the bound, exact values inside', () => {
    const f = within(() => 7, circle(50, 50, 10));
    expect(f(50, 50)).toBe(7);
    expect(Number.isNaN(f(70, 50))).toBe(true);
  });

  it('nested bounds are a conjunction', () => {
    const f = within(within(() => 1, circle(50, 50, 20)), circle(60, 50, 20));
    expect(f(55, 50)).toBe(1); // inside both
    expect(Number.isNaN(f(35, 50))).toBe(true); // only in the first
    expect(Number.isNaN(f(75, 50))).toBe(true); // only in the second
  });

  it('honors the bound shape\'s transform opts', () => {
    const f = within(() => 1, circle(0, 0, 5, { translate: [50, 50] }));
    expect(f(50, 50)).toBe(1);
    expect(Number.isNaN(f(0, 0))).toBe(true);
  });

  it('isolines truncate OPEN at the domain edge — no staircase wall', () => {
    // Constant field bounded to a circle: every level-set boundary would be
    // the domain edge itself. Correct output: NO contours at all (nothing
    // crosses the level inside the domain) — the old sentinel behavior drew
    // a staircase ring hugging the circle.
    const f = within(() => 5, circle(50, 50, 20));
    const cs = isolinesOf(env, f, 1, { step: 1 });
    expect(cs).toHaveLength(0);
  });

  it('isolines inside the domain still close normally', () => {
    // A cone inside a generous bound: its level set never touches the
    // domain edge, so the contour closes as always.
    const f = within(
      (x: number, y: number) => 15 - Math.hypot(x - 50, y - 50),
      circle(50, 50, 30),
    );
    const cs = isolinesOf(env, f, 5, { step: 0.5 });
    expect(cs).toHaveLength(1);
    expect(cs[0].closed).toBe(true);
  });

  it('a contour crossing the domain edge comes back open', () => {
    // The cone's level set pokes past the bound on one side.
    const f = within(
      (x: number, y: number) => 25 - Math.hypot(x - 50, y - 50),
      circle(40, 50, 20),
    );
    const cs = isolinesOf(env, f, 5, { step: 0.5 });
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => !c.closed)).toBe(true);
  });
});

describe('within: one geometry language (the lowerer)', () => {
  it('honors the sketch rectMode, like the shape itself', () => {
    let centered = false;
    let cornered = true;
    const def = sketch({ rectMode: 'center' }, () => {
      const f = within(() => 1, rect(50, 50, 20, 20));
      centered = f(50, 50) === 1; // centre of a centred rect
      cornered = f(65, 65) === 1; // inside only if the rect were corner-anchored
      return circle(50, 50, 10);
    });
    compileSketch(def);
    expect(centered).toBe(true);
    expect(cornered).toBe(false);
  });

  it('refuses an open path as a bound', () => {
    expect(() => within(() => 1, path().moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).build()))
      .toThrow(/closed/);
  });

  it('samples arc commands as real arcs, not chords', () => {
    // A half-disc: chord 40 with r = 20 is exactly a semicircle to one side,
    // closed along the chord. A point just under the crown on that side is
    // inside; the chord approximation would call both sides outside.
    const half = path().moveTo(30, 50).arcTo(70, 50, 20).close().build();
    const f = within(() => 1, half);
    const above = f(50, 31) === 1;
    const below = f(50, 69) === 1;
    expect(above !== below).toBe(true);
  });

  it('translate() resolves tagged lengths against the paper the sketch renders on', () => {
    // Built at module scope, before any sketch state: mm(10) must still be
    // 10 mm of THIS paper at sample time, not of the default A4.
    const f = translate((x: number) => x, mm(10), 0);
    let seen = NaN;
    setPaperHint(200, 200);
    try {
      compileSketch(sketch({ aspect: 'paper', margin: 0 }, () => { seen = f(0, 0); return circle(0, 0, 1); }));
    } finally {
      setPaperHint(210, 297);
    }
    // 200 mm short side → 100 units; 10 mm = 5 units → f(0,0) = -5.
    expect(seen).toBeCloseTo(-5, 6);
  });
});

describe('align: shape-anchored fills follow the motif', () => {
  const rowAngles = (def: SketchDef): number[] => {
    const out = sq(def);
    return out.frags
      .filter((f) => !f.dot && f.geom.t === 'line')
      .map((f) => {
        const g = f.geom as { x0: number; y0: number; x1: number; y1: number };
        const a = (Math.atan2(g.y1 - g.y0, g.x1 - g.x0) * 180) / Math.PI;
        return ((a % 180) + 180) % 180; // undirected line angle
      });
  };

  it('coordinate-placed shapes keep identical marks (halftone preserved)', () => {
    const def = sketch({ seed: 1 }, () => [
      circle(30, 50, 8, { fill: fill('hatch', { angle: 0, align: 'shape' }), stroke: false }),
    ]);
    const angles = rowAngles(def);
    expect(angles.length).toBeGreaterThan(3);
    for (const a of angles) expect(Math.min(a, 180 - a)).toBeLessThan(1e-6);
  });

  it('a shape in a rotated group carries its texture rotation', () => {
    const def = sketch({ seed: 1 }, () => [
      group(
        { translate: [50, 50], rotate: 30 },
        circle(0, 0, 8, { fill: fill('hatch', { angle: 0, align: 'shape' }), stroke: false }),
      ),
    ]);
    const angles = rowAngles(def);
    expect(angles.length).toBeGreaterThan(3);
    for (const a of angles) expect(Math.abs(a - 30)).toBeLessThan(1e-6);
  });

  it("paper-aligned fills ignore the group (the pinned default)", () => {
    const def = sketch({ seed: 1 }, () => [
      group(
        { translate: [50, 50], rotate: 30 },
        circle(0, 0, 8, { fill: fill('hatch', { angle: 0 }), stroke: false }),
      ),
    ]);
    const angles = rowAngles(def);
    for (const a of angles) expect(Math.min(a, 180 - a)).toBeLessThan(1e-6);
  });
});

describe('trace: contour stamping without the seam foot-gun', () => {
  it('closed contours keep their seam; fine open chains survive whole', () => {
    const def = sketch({ seed: 6 }, (t) => {
      const f = within(
        (x: number, y: number) => t.noise(x / 5, y / 22),
        circle(50, 50, 40),
      );
      return t.isolines(f, 0.2, { step: 0.2 }).map((c) => trace(c));
    });
    const out = sq(def);
    const drawn = out.frags.filter((fr) => !fr.dot);
    const dots = out.frags.filter((fr) => fr.dot);
    // The chain-whole nib rule: fine-stepped traced contours are ink, not
    // a field of swallowed tap candidates.
    expect(drawn.length).toBeGreaterThan(500);
    expect(dots.length).toBeLessThan(drawn.length / 20);
  });

  it('bare point arrays trace open', () => {
    const def = sketch({ seed: 1 }, () => [
      trace([[10, 10], [50, 30], [90, 10]]),
    ]);
    const out = sq(def);
    expect(out.frags.filter((f) => !f.dot).length).toBe(2); // two segments, no closing chord
  });
});

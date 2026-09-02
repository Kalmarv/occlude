import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, compileSketch, deform, encodeScene, fill, group, initOcclude, mm, path, rect, render,
  rotate, scale, setPaperHint, sketch, trace, translate, vectorField, within,
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

const deformOf = (field: ReturnType<typeof vectorField>, align: 'paper' | 'shape') =>
  deform({ field, detail: mm(1), align });

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

describe('engine field uses: exact domains, shape anchoring, shared grids', () => {
  const mid = (f: { geom: { t: string } }): [number, number] => {
    const g = f.geom as { t: string; x0: number; y0: number; x1: number; y1: number };
    return [(g.x0 + g.x1) / 2, (g.y0 + g.y1) / 2];
  };

  it('within() bounds a modifier field EXACTLY — straight outside, displaced inside, no fade band', () => {
    // Horizontal hatch rows wobbled only inside a circle. Wobble samples
    // its amplitude per vertex, so the domain edge is visible directly: a
    // raster fade band (~1.5 mm at this paper) would displace vertices well
    // OUTSIDE the circle; the exact domain leaves every outside vertex on
    // its row. The 0.3 mm amplitude keeps displaced inside vertices within
    // 0.3 mm of the circle, so the two populations cannot be confused.
    const def = sketch({ seed: 3 }, () =>
      rect(10, 10, 80, 80, {
        stroke: false,
        fill: fill('hatch', { angle: 0, spacing: mm(1) }),
        wobble: { amount: within(() => mm(0.3), circle(50, 50, 20)), wavelength: mm(3) },
      }),
    );
    const out = sq(def);
    const unit = Math.min(out.frame.inner.innerW, out.frame.inner.innerH) / 100;
    const [cx, cy] = [out.frame.offsetX + 50 * unit, out.frame.offsetY + 50 * unit];
    const r = 20 * unit;
    let outsideBent = 0;
    let outsideStraight = 0;
    let insideBent = 0;
    for (const f of out.frags) {
      if (f.dot || f.geom.t !== 'line') continue;
      const g = f.geom;
      const d0 = Math.hypot(g.x0 - cx, g.y0 - cy);
      const d1 = Math.hypot(g.x1 - cx, g.y1 - cy);
      const bent = Math.abs(g.y1 - g.y0) > 1e-6;
      if (Math.min(d0, d1) > r + 0.35) {
        if (bent) outsideBent++;
        else outsideStraight++;
      } else if (Math.max(d0, d1) < r - 0.5 && bent) {
        insideBent++;
      }
    }
    expect(outsideStraight).toBeGreaterThan(50);
    expect(insideBent).toBeGreaterThan(50);
    expect(outsideBent).toBe(0);
  });

  it("align: 'shape' anchors the field to the shape and turns it with the group", () => {
    // Field: erase where local x < 0. Rect A sits alone: its LEFT half is
    // erased. Rect B is the same rect under a 90° group: local -x now points
    // to paper -y, so its TOP half is erased (paper y grows downward).
    const half = (x: number) => (x < 0 ? 1 : 0);
    const spec = { fill: fill('hatch', { angle: 90, spacing: mm(0.8) }), decimate: { fill: half, align: 'shape' as const } };
    const a = sq(sketch({ seed: 1 }, () => rect(20, 20, 30, 30, spec)));
    const b = sq(sketch({ seed: 1 }, () => group({ rotate: 90 }, rect(20, -60, 30, 30, spec))));
    const centre = (o: typeof a): [number, number] => {
      const xs = o.frags.filter((f) => f.origin < 4).flatMap((f) => [mid(f)[0]]);
      const ys = o.frags.filter((f) => f.origin < 4).flatMap((f) => [mid(f)[1]]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    };
    const [acx] = centre(a);
    const [, bcy] = centre(b);
    const aFill = a.frags.filter((f) => f.origin >= 4 && !f.dot);
    const bFill = b.frags.filter((f) => f.origin >= 4 && !f.dot);
    expect(aFill.length).toBeGreaterThan(5);
    expect(bFill.length).toBeGreaterThan(5);
    expect(aFill.every((f) => mid(f)[0] > acx - 0.01)).toBe(true);
    expect(bFill.every((f) => mid(f)[1] > bcy - 0.01)).toBe(true);
  });

  it('a mirrored group mirrors a shape-aligned ruling (45° → 135°)', () => {
    const angles = (o: ReturnType<typeof sq>): number[] =>
      o.frags
        .filter((f) => !f.dot && f.geom.t === 'line' && f.origin >= 2)
        .map((f) => {
          const g = f.geom as { x0: number; y0: number; x1: number; y1: number };
          return ((((Math.atan2(g.y1 - g.y0, g.x1 - g.x0) * 180) / Math.PI) % 180) + 180) % 180;
        });
    const spec = { fill: fill('hatch', { angle: 45, spacing: mm(2), align: 'shape' as const }) };
    const plain = angles(sq(sketch({ seed: 1 }, () => circle(50, 50, 15, spec))));
    const mirrored = angles(sq(sketch({ seed: 1 }, () => group({ scale: [-1, 1] }, circle(-50, 50, 15, spec)))));
    expect(plain.length).toBeGreaterThan(3);
    for (const a of plain) expect(Math.abs(a - 45)).toBeLessThan(0.5);
    for (const a of mirrored) expect(Math.abs(a - 135)).toBeLessThan(0.5);
  });

  it('a thousand shape-aligned uses share ONE grid (the transform lives outside it)', () => {
    const f = (x: number, y: number) => Math.hypot(x, y) < 5 ? 1 : 0;
    compileSketch(sketch({ seed: 1 }, (t) =>
      t.times(40, (k) => circle(5 + (k % 8) * 12, 5 + Math.floor(k / 8) * 12, 4, {
        fill: fill('solid'), decimate: { fill: f, align: 'shape' },
      }))));
    const scene = encodeScene({ paper: 'Square20' });
    let grids = 0;
    for (let i = 0; i < scene.fieldData.length; ) {
      grids++;
      i += 6 + scene.fieldData[i] * scene.fieldData[i + 1];
    }
    expect(grids).toBe(1);
    expect(scene.fieldUses.length / 14).toBe(40);
  });

  it("deform with align: 'shape' turns the arrows with the motif", () => {
    // A constant push along local +x. Alone: the rect shifts along paper
    // +x. Under a 90° group: along paper +y — the iron-filings rule.
    const push = vectorField(() => [4, 0] as [number, number]);
    const centreOf = (o: ReturnType<typeof sq>): [number, number] => {
      const pts = o.frags.filter((f) => !f.dot).flatMap((f) => [mid(f)]);
      return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    };
    const base = centreOf(sq(sketch({ seed: 1 }, () => rect(30, 30, 20, 20))));
    const shifted = centreOf(sq(sketch({ seed: 1 }, () =>
      rect(30, 30, 20, 20, { modifiers: [deformOf(push, 'shape')] }))));
    const turned = centreOf(sq(sketch({ seed: 1 }, () =>
      group({ rotate: 90 }, rect(30, -50, 20, 20, { modifiers: [deformOf(push, 'shape')] })))));
    const frame = sq(sketch({ seed: 1 }, () => rect(30, 30, 20, 20))).frame;
    const unit = Math.min(frame.inner.innerW, frame.inner.innerH) / 100;
    expect(shifted[0] - base[0]).toBeCloseTo(4 * unit, 0);
    expect(Math.abs(shifted[1] - base[1])).toBeLessThan(0.5);
    // The rotated rect's undeformed centre is the same paper point as base.
    expect(turned[1] - base[1]).toBeCloseTo(4 * unit, 0);
    expect(Math.abs(turned[0] - base[0])).toBeLessThan(0.5);
  });
});

describe('loops: any shape as plain point loops', () => {
  it('is the lowerer in sketch coordinates — a circle at its radius, a rect on its mode', () => {
    let circ: [number, number][][] = [];
    let rc: [number, number][][] = [];
    let open: [number, number][][] = [];
    compileSketch(sketch({ rectMode: 'center' }, (t) => {
      circ = t.loops(circle(50, 25, 15));
      rc = t.loops(rect(50, 50, 20, 10, { rotate: 0 }));
      open = t.loops(trace({ pts: [[0, 0], [10, 0], [10, 10]], closed: false }));
      return circle(0, 0, 1);
    }));
    expect(circ).toHaveLength(1);
    expect(circ[0].length).toBeGreaterThan(50);
    for (const [x, y] of circ[0]) expect(Math.hypot(x - 50, y - 25)).toBeCloseTo(15, 1);
    const xs = rc[0].map((p) => p[0]);
    const ys = rc[0].map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(40, 6);
    expect(Math.max(...xs)).toBeCloseTo(60, 6);
    expect(Math.min(...ys)).toBeCloseTo(45, 6);
    expect(Math.max(...ys)).toBeCloseTo(55, 6);
    expect(open[0][0]).toEqual([0, 0]);
    expect(open[0][open[0].length - 1]).toEqual([10, 10]);
  });

  it('composes: distanceTo(t.loops(circle)) is the circle\'s signed distance', () => {
    let seen = NaN;
    compileSketch(sketch({}, (t) => {
      const d = t.distanceTo(t.loops(circle(50, 50, 25)));
      seen = d(50, 50);
      return circle(0, 0, 1);
    }));
    expect(seen).toBeCloseTo(25, 1);
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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initOcclude, render, sketch, strokes } from '../src/index.js';
import { isolinesOf, levelContours, type IsoContour, type IsoEnv, type LevelContour } from '../src/isolines.js';
import type { FieldFn, Material, RenderOptions, SketchDef } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

const sq = (def: SketchDef, opts: RenderOptions = {}) =>
  render(def, { paper: 'Square20', ...opts });

/** Bare-units env: 100×100 drawable, lengths taken at face value. */
const env: IsoEnv = {
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  len: (l) => (typeof l === 'number' ? l : l.value),
};

const fragLenOf = (f: import('../src/index.js').Fragment): number => {
  const g = f.geom as { t: string; [k: string]: number | string };
  if (g.t === 'arc') return (g.r as number) * Math.abs(g.sweep as number);
  return Math.hypot((g.x1 as number) - (g.x0 as number), (g.y1 as number) - (g.y0 as number));
};

const perimeter = (c: IsoContour): number => {
  let sum = 0;
  const n = c.pts.length;
  const m = c.closed ? n : n - 1;
  for (let k = 0; k < m; k++) {
    const [ax, ay] = c.pts[k];
    const [bx, by] = c.pts[(k + 1) % n];
    sum += Math.hypot(bx - ax, by - ay);
  }
  return sum;
};

const shoelace = (c: IsoContour): number => {
  let a = 0;
  const n = c.pts.length;
  for (let k = 0; k < n; k++) {
    const [ax, ay] = c.pts[k];
    const [bx, by] = c.pts[(k + 1) % n];
    a += ax * by - bx * ay;
  }
  return Math.abs(a) / 2;
};

describe('isolines: marching squares core', () => {
  it('recovers a circle from a radial field (analytic oracle)', () => {
    const field = (x: number, y: number): number => 30 - Math.hypot(x - 50, y - 50);
    const out = isolinesOf(env, field, 0, { step: 0.5 });
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.closed).toBe(true);
    for (const [x, y] of c.pts) {
      expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(30, 1);
    }
    // Edge-interpolated crossings: perimeter within 1% of 2πr.
    expect(perimeter(c)).toBeGreaterThan(2 * Math.PI * 30 * 0.99);
    expect(perimeter(c)).toBeLessThan(2 * Math.PI * 30 * 1.01);
  });

  it('a region the drawable cuts closes along it, and its closing edges are marked cut', () => {
    const field = (x: number): number => x - 50;
    const closed = isolinesOf(env, field, 0, { step: 1 });
    expect(closed).toHaveLength(1);
    expect(closed[0].closed).toBe(true);
    // The right half-plane clipped to the drawable: a 50×100 rectangle.
    expect(shoelace(closed[0])).toBeCloseTo(5000, 0);
    expect(closed[0].pts.length).toBeLessThan(8); // border runs collapse to corners
    // The level line is the one edge on x = 50; the other three are the border.
    const c = closed[0];
    const level = c.pts.flatMap((p, k) => (c.cut[k] === 0 ? [[p, c.pts[(k + 1) % c.pts.length]]] : []));
    expect(level).toHaveLength(1);
    expect(level[0].every(([x]) => Math.abs(x - 50) < 1e-6)).toBe(true);
    expect(c.cut.filter((v) => v === 1)).toHaveLength(3);
  });

  it('an annulus band yields two nested closed contours', () => {
    const field = (x: number, y: number): number =>
      20 - Math.abs(Math.hypot(x - 50, y - 50) - 25);
    const out = isolinesOf(env, field, 10, { step: 0.5 });
    expect(out).toHaveLength(2);
    const radii = out
      .map((c) => Math.hypot(c.pts[0][0] - 50, c.pts[0][1] - 50))
      .sort((a, b) => a - b);
    expect(radii[0]).toBeCloseTo(15, 1);
    expect(radii[1]).toBeCloseTo(35, 1);
    expect(out.every((c) => c.closed)).toBe(true);
  });

  it('multi-level overload matches per-level calls over one sampling', () => {
    const field = (x: number, y: number): number => 40 - Math.hypot(x - 50, y - 50);
    const multi = isolinesOf(env, field, [0, 15, 25], { step: 1 });
    expect(multi).toHaveLength(3);
    for (const [k, lvl] of [0, 15, 25].entries()) {
      const single = isolinesOf(env, field, lvl, { step: 1 });
      expect(multi[k]).toEqual(single);
    }
  });

  it('guards: a zero step and an absent level draw nothing, the cap fails loudly', () => {
    const field = (): number => 1;
    expect(isolinesOf(env, field, 0, { step: 0 })).toEqual([]);
    expect(() => isolinesOf(env, field, 0, { step: 0.01 })).toThrow(/cap/);
    expect(isolinesOf(env, field, Number.NaN)).toEqual([]);
    // One absent level is skipped; the levels beside it still march.
    const some = isolinesOf(env, (x: number) => x, [Number.NaN, 50]);
    expect(some[0]).toEqual([]);
    expect(some[1].length).toBeGreaterThan(0);
  });

  it('non-finite field samples count as outside', () => {
    const field = (x: number): number => (x > 60 ? Number.NaN : 50 - x);
    const out = isolinesOf(env, field, 0, { step: 1 });
    expect(out).toHaveLength(1);
    // The left half, closed along the drawable; its level line is x = 50.
    expect(shoelace(out[0])).toBeCloseTo(5000, 0);
    const c = out[0];
    const level = c.pts.flatMap((p, k) => (c.cut[k] === 0 ? [p, c.pts[(k + 1) % c.pts.length]] : []));
    expect(level.length).toBeGreaterThan(0);
    expect(level.every(([x]) => Math.abs(x - 50) < 1e-6)).toBe(true);
  });
});

describe('isolines: levels', () => {
  /** A plane that runs 0..100 across the drawable: its sampled range is the
   * drawable's own span, so a count or a spacing has an arithmetic answer. */
  const ramp = (x: number): number => x;
  const levelsOf = (at: Parameters<typeof levelContours>[2], field: FieldFn = ramp, opts = { step: 1 }) =>
    levelContours(env, field, at, opts).map((g) => g.level);

  it('{ count } spreads levels evenly inside the sampled range', () => {
    expect(levelsOf({ count: 3 })).toEqual([25, 50, 75]);
    expect(levelsOf({ count: 1 })).toEqual([50]);
    // min/max pin the range the count divides.
    expect(levelsOf({ count: 3, min: 0, max: 40 })).toEqual([10, 20, 30]);
    expect(levelsOf({ count: 1, max: 0 })).toEqual([]); // an empty range
  });

  it('{ spacing } takes every multiple inside the range, offset and all', () => {
    expect(levelsOf({ spacing: 20 })).toEqual([0, 20, 40, 60, 80, 100]);
    expect(levelsOf({ spacing: 20, offset: 5 })).toEqual([5, 25, 45, 65, 85]);
    expect(levelsOf({ spacing: 150 })).toEqual([0]);
  });

  it('the range is the range the field actually has, absence aside', () => {
    // Only the left third is sampled at all; the rest is a NaN hole.
    const third = (x: number): number => (x > 33 ? Number.NaN : x);
    const found = levelsOf({ count: 2 }, third);
    expect(found).toHaveLength(2);
    expect(found[0]).toBeGreaterThan(0);
    expect(found[1]).toBeLessThan(34);
    // A flat field has no range to divide and no multiples to find.
    expect(levelsOf({ count: 4 }, () => 7)).toEqual([]);
    expect(levelsOf({ spacing: 1 }, () => Number.NaN)).toEqual([]);
  });

  it('degenerate specs draw nothing; a fractional count is a mistake', () => {
    expect(levelsOf({ spacing: 0 })).toEqual([]);
    expect(levelsOf({ spacing: -5 })).toEqual([]);
    expect(levelsOf({ spacing: Number.NaN })).toEqual([]);
    expect(levelsOf({ count: 0 })).toEqual([]);
    expect(() => levelsOf({ count: 2.5 })).toThrow(/positive integer/);
    // The step guard still wins over the field, and a spec has no levels
    // without one: a list keeps its places, a spec has none to keep.
    expect(levelContours(env, ramp, { count: 3 }, { step: 0 })).toEqual([]);
    expect(levelContours(env, ramp, [1, 2], { step: 0 })).toEqual([
      { level: 1, contours: [], lines: [], walls: [] },
      { level: 2, contours: [], lines: [], walls: [] },
    ]);
  });

  it('a resolved spec marches exactly as the same list would', () => {
    const field = (x: number, y: number): number => 40 - Math.hypot(x - 50, y - 50);
    const spec = levelContours(env, field, { count: 3 }, { step: 1 });
    const list = levelContours(env, field, spec.map((g) => g.level), { step: 1 });
    expect(JSON.stringify(spec)).toBe(JSON.stringify(list));
    // And the nameless door returns the same contours, one array per level.
    expect(isolinesOf(env, field, { count: 3 }, { step: 1 })).toEqual(
      spec.map((g) => g.contours),
    );
  });

  it('the toolkit carries the resolved level on every edge', () => {
    let keys: number[] = [];
    let index: number[] = [];
    let listed: number[] = [];
    sq(
      sketch({ seed: 4 }, (t) => {
        const ground = (x: number, y: number): number => t.noise(x / 28, y / 28);
        const m = t.isolines(ground, { spacing: 0.1 });
        keys = m.edges.groupBy((e) => e.attrs.level as number).map((sel) => sel.key as number);
        index = t
          .isolines(ground, { spacing: 0.5 })
          .edges.groupBy((e) => e.attrs.level as number)
          .map((sel) => sel.key as number);
        listed = t
          .isolines(ground, [-0.2, 0, 0.2])
          .edges.groupBy((e) => e.attrs.level as number)
          .map((sel) => sel.key as number);
        return [strokes(m)];
      }),
    );
    // A list still names its own levels, in the order it gave them.
    expect(listed).toEqual([-0.2, 0, 0.2]);
    expect(keys.length).toBeGreaterThan(3);
    for (const k of keys) expect(Math.abs(k / 0.1 - Math.round(k / 0.1))).toBeLessThan(1e-9);
    // The index lines are a subset of the lines they index.
    expect(index.length).toBeGreaterThan(0);
    for (const k of index) {
      expect(keys.some((v) => Math.abs(v - k) < 1e-9)).toBe(true);
    }
  });
});

describe('isolines: grid sizing', () => {
  it('fine steps past the old 100k combinator cap sample fine', () => {
    // 100×100 at step 0.25 → 401² ≈ 161k cells: legal now.
    const cs = isolinesOf(env, (x, y) => Math.hypot(x - 50, y - 50) - 20, 0, {
      step: 0.25,
    });
    // The area outside the circle: the drawable's edge, and the circle as its hole.
    expect(cs.length).toBe(2);
  });

  it('absurd grids still fail fast (memory ceiling); a zero step draws nothing', () => {
    expect(() =>
      isolinesOf(env, () => 0, 0, { step: 0.02 }),
    ).toThrow(/grid cells/);
    expect(isolinesOf(env, () => 0, 0, { step: 0 })).toEqual([]);
  });
});

describe('isolines: toolkit + engine integration', () => {
  it('is deterministic through the toolkit', () => {
    const capture: Material[] = [];
    const def = sketch({ seed: 7 }, (t) => {
      capture.push(
        t.isolines((x, y) => t.noise(x / 20, y / 20), 0.1),
      );
      return capture[capture.length - 1].curves().map((c) => t.polygon(c));
    });
    sq(def);
    sq(def);
    expect(capture).toHaveLength(2);
    expect(JSON.stringify(capture[0].curves())).toBe(JSON.stringify(capture[1].curves()));
    expect(capture[0].curves().length).toBeGreaterThan(0);
  });

  it('polygon() lifts annulus loops into one evenodd shape whose hole stays empty', () => {
    const def = sketch({ seed: 1 }, (t) => {
      const band = t.isolines(
        (x, y) => 20 - Math.abs(Math.hypot(x - 50, y - 50) - 25),
        10,
      );
      return [t.polygon(band, { fill: t.fill('hatch', { angle: 0, spacing: t.mm(1.5) }) })];
    });
    const out = sq(def);
    // Paper 200×200mm, user units ×2: band radii 30–70mm around (100,100).
    const mids = out.frags
      .filter((f) => !f.dot && f.geom.t === 'line')
      .map((f) => {
        const g = f.geom as { x0: number; y0: number; x1: number; y1: number };
        return Math.hypot((g.x0 + g.x1) / 2 - 100, (g.y0 + g.y1) / 2 - 100);
      });
    expect(mids.length).toBeGreaterThan(20);
    expect(mids.filter((d) => d < 28)).toHaveLength(0); // the hole
    expect(mids.filter((d) => d > 32 && d < 68).length).toBeGreaterThan(10); // the band inked
  });

  it('a filled polygon() from zero contours is a no-op, not an error', () => {
    // A cutoff above the field's range yields no contours — the empty
    // region is trivially closed: it fills nothing, occludes nothing.
    const def = sketch({ seed: 1 }, (t) => [
      t.polygon(
        t.isolines((x, y) => t.noise(x / 20, y / 20), 2),
        { fill: t.fill('stipple') },
      ),
      t.circle(50, 50, 10),
    ]);
    const out = sq(def);
    const circleInk = out.frags.filter((f) => !f.dot).reduce((s, f) => s + fragLenOf(f), 0);
    // Full circumference survives: nothing occluded it, nothing stippled.
    expect(Math.abs(circleInk - 2 * Math.PI * 20)).toBeLessThan(1);
    expect(out.frags.filter((f) => f.dot)).toHaveLength(0);
  });

  it('clip(invert(polygon)) keeps ink outside; the two polarities tile the ink', () => {
    const mk = (kind: 'in' | 'out' | 'all'): SketchDef =>
      sketch({ seed: 3 }, (t) => {
        const album = t.grid({ cols: 12, rows: 12 }).map((c) => t.circle(c.cx, c.cy, 2));
        if (kind === 'all') return album;
        const r = t.polygon(t.isolines((x, y) => t.noise(x / 20, y / 20), 0.1));
        return [kind === 'in' ? t.clip(r, album) : t.clip(t.invert(r), album)];
      });
    const ink = (def: SketchDef): number =>
      sq(def).frags.filter((f) => !f.dot).reduce((s, f) => s + fragLenOf(f), 0);
    const inside = ink(mk('in'));
    const outside = ink(mk('out'));
    const all = ink(mk('all'));
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
    // Complementarity (sub-nib boundary slivers allowed).
    expect(Math.abs(inside + outside - all)).toBeLessThan(all * 0.01);
  });

  it('invert() in the tree fails loudly', () => {
    const def = sketch({ seed: 1 }, (t) => [t.invert(t.circle(50, 50, 10)) as never]);
    expect(() => sq(def)).toThrow(/invert\(\) is an area, not a drawable/);
  });

  it('an evenodd polygon used as clip respects holes', () => {
    // Annulus region clipping a line: only the band crossings survive —
    // the hole is OUTSIDE the clip (winding now crosses the protocol).
    const def = sketch({ seed: 1 }, (t) => {
      const band = t.isolines(
        (x, y) => 20 - Math.abs(Math.hypot(x - 50, y - 50) - 25),
        10,
      );
      return [t.clip(t.polygon(band), t.line(0, 50, 100, 50))];
    });
    const out = sq(def);
    const lens = out.frags.filter((f) => !f.dot).map(fragLenOf).sort((a, b) => a - b);
    // Two band crossings, each ≈ (35−15)·2mm = 40mm; nothing in the hole.
    expect(lens.length).toBe(2);
    for (const l of lens) expect(Math.abs(l - 40)).toBeLessThan(1.5);
  });
});

describe('isolines: every crossing sits where its own grid edge says', () => {
  /** Independent oracle for the whole case table: a contour point must lie on
   * a sample edge, and the level must fall at exactly that fraction between
   * the edge's two samples. It knows nothing about which case emits which
   * crossing — the part the case table decides. */
  const audit = (field: (x: number, y: number) => number, at: number, step: number) => {
    const cs = isolinesOf(env, field, at, { step });
    const b = env.bounds;
    const gw = Math.max(2, Math.ceil(b.w / step) + 1);
    const gh = Math.max(2, Math.ceil(b.h / step) + 1);
    const sx = b.w / (gw - 1);
    const sy = b.h / (gh - 1);
    const onLine = (v: number, origin: number, s: number) => {
      const k = Math.round((v - origin) / s);
      return Math.abs(origin + k * s - v) < 1e-9 ? k : null;
    };
    let audited = 0;
    for (const c of cs) {
      for (const [x, y] of c.pts) {
        const i = onLine(x, b.x, sx);
        const j = onLine(y, b.y, sy);
        // The closing ring clamps border points onto the drawable, and the colinear
        // merge drops interior points; a merged corner sits on both lines.
        if (i === null && j === null) throw new Error(`point ${x},${y} is on no grid line`);
        if (i !== null && j !== null) continue; // a grid corner: nothing to interpolate
        if (i === null) {
          // on a horizontal sample edge at row j: interpolate in x
          const jj = j as number;
          const ii = Math.floor((x - b.x) / sx);
          if (ii < 0 || ii + 1 > gw - 1 || jj < 0 || jj > gh - 1) continue; // the closing ring
          const va = field(b.x + ii * sx, b.y + jj * sy);
          const vb = field(b.x + (ii + 1) * sx, b.y + jj * sy);
          if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
          const t = (x - (b.x + ii * sx)) / sx;
          expect(va + (vb - va) * t).toBeCloseTo(at, 9);
          audited++;
        } else {
          const ii = i as number;
          const jj = Math.floor((y - b.y) / sy);
          if (jj < 0 || jj + 1 > gh - 1 || ii < 0 || ii > gw - 1) continue;
          const va = field(b.x + ii * sx, b.y + jj * sy);
          const vd = field(b.x + ii * sx, b.y + (jj + 1) * sy);
          if (!Number.isFinite(va) || !Number.isFinite(vd)) continue;
          const t = (y - (b.y + jj * sy)) / sy;
          expect(va + (vd - va) * t).toBeCloseTo(at, 9);
          audited++;
        }
      }
    }
    return audited;
  };

  it('audits crossings across fields that exercise the whole case table', () => {
    let total = 0;
    const fields: [string, (x: number, y: number) => number][] = [
      ['wavy', (x, y) => Math.sin(x * 0.1) * Math.cos(y * 0.1) + Math.sin((x + y) * 0.05) * 0.6],
      ['bowl', (x, y) => 30 - Math.hypot(x - 50, y - 50)],
      ['plane +x', (x) => x / 100 - 0.5],
      ['plane +y', (_x, y) => y / 100 - 0.5],
      ['plane diag', (x, y) => (x + y) / 200 - 0.5],
      ['plane anti-diag', (x, y) => (x - y) / 200],
      ['saddle', (x, y) => (x - 50) * (y - 50) / 2500],
      ['holed', (x, y) => (Math.hypot(x - 50, y - 50) < 15 ? NaN : Math.sin(x * 0.1) * Math.cos(y * 0.1))],
    ];
    for (const [, f] of fields) {
      for (const step of [1, 3.7]) {
        total += audit(f, 0, step);
      }
    }
    expect(total).toBeGreaterThan(1000);
  });

  it('a saddle takes the diagonal the cell-centre average asks for', () => {
    // one cell, corners high on one diagonal and low on the other
    const cell = (tl: number, tr: number, br: number, bl: number) => (x: number, y: number) =>
      (x < 50 ? (y < 50 ? tl : bl) : (y < 50 ? tr : br));
    const one: IsoEnv = { bounds: { x: 0, y: 0, w: 100, h: 100 }, len: (l) => (typeof l === 'number' ? l : l.value) };
    // centre average above the level: the two crossings pair across the high diagonal
    const high = isolinesOf(one, cell(1, -0.5, 1, -0.5), 0, { step: 100 });
    // centre average below it: the other pairing
    const low = isolinesOf(one, cell(0.5, -1, 0.5, -1), 0, { step: 100 });
    // The level edges alone: the closing edges along the drawable differ with
    // the pairing anyway, and are not what the saddle decides.
    const ends = (cs: LevelContour[]) => cs.flatMap((c) => c.pts.flatMap((p, k) => {
      if (c.cut[k] !== 0) return [];
      const q = c.pts[(k + 1) % c.pts.length];
      return [`${p[0].toFixed(2)},${p[1].toFixed(2)} → ${q[0].toFixed(2)},${q[1].toFixed(2)}`];
    })).sort();
    expect(ends(high)).toHaveLength(2);
    expect(ends(low)).toHaveLength(2);
    expect(ends(high)).not.toEqual(ends(low));
  });
});

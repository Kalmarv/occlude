import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { SQ, toolkit } from './helpers/run.js';
import { across, axisField, circle, grad, initOcclude, rotate, scale, translate, vectorField } from '../src/index.js';
import type { VectorFieldFn } from '../src/shapes.js';
import { fieldMeta, isAxisField } from '../src/field.js';
import type { IsoEnv } from '../src/isolines.js';
import { streamlinesOf } from '../src/streamlines.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

/** Bare-units env: 100×100 drawable, lengths taken at face value. */
const env: IsoEnv = {
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  len: (l) => (typeof l === 'number' ? l : l.value),
};

/** East everywhere, but written so the formula changes sign halfway across:
 * the same LINE, the opposite arrow. An axis field crosses it; a vector
 * field meets itself head-on there. */
const flipped = (x: number): [number, number] => [x < 50 ? 1 : -1, 0];
/** Circles about the centre, still at the centre itself. */
const swirl = (x: number, y: number): [number, number] => [-(y - 50), x - 50];

const lines = (field: VectorFieldFn, opts = {}): [number, number][][] =>
  streamlinesOf(env, field, { spacing: 5, ...opts }).map((c) => c.pts);

/** Unit tangent of a line at point i, from its neighbours. */
function tangent(pts: [number, number][], i: number): [number, number] {
  const a = pts[Math.max(0, i - 1)];
  const b = pts[Math.min(pts.length - 1, i + 1)];
  const m = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return m > 0 ? [(b[0] - a[0]) / m, (b[1] - a[1]) / m] : [0, 0];
}

const unit = ([x, y]: [number, number]): [number, number] => {
  const m = Math.hypot(x, y);
  return m > 0 ? [x / m, y / m] : [0, 0];
};

describe('axis fields', () => {
  it('an axis field traces exactly like the oriented field it agrees with', () => {
    const asAxis = streamlinesOf(env, axisField(() => [1, 0]), { spacing: 5 });
    const asVector = streamlinesOf(env, vectorField(() => [1, 0]), { spacing: 5 });
    expect(asAxis.length).toBeGreaterThan(14);
    expect(JSON.stringify(asAxis)).toBe(JSON.stringify(asVector));
  });

  it('a line crosses where the formula changes sign; an arrow field stops there', () => {
    const axes = lines(axisField((x) => flipped(x)));
    const arrows = lines(vectorField((x) => flipped(x)));
    // The axis field: lines run the full width, unbroken.
    const spans = axes.filter((l) => Math.min(...l.map((p) => p[0])) < 5 && Math.max(...l.map((p) => p[0])) > 95);
    expect(spans.length).toBeGreaterThan(14);
    // And they never turn back: x is monotone along each one.
    for (const l of spans) {
      for (let i = 1; i < l.length; i++) expect(l[i][0]).toBeGreaterThan(l[i - 1][0] - 1e-9);
    }
    // The oriented field: every line stays on one side of x = 50.
    expect(arrows.length).toBeGreaterThan(0);
    for (const l of arrows) {
      const lo = Math.min(...l.map((p) => p[0]));
      const hi = Math.max(...l.map((p) => p[0]));
      expect(lo > 45 || hi < 55).toBe(true);
    }
  });

  it('across() of an axis field traces the perpendicular family', () => {
    const axes = axisField(swirl);
    const perp = across(axes);
    expect(isAxisField(perp)).toBe(true);
    const spokes = lines(perp, { spacing: 6 });
    expect(spokes.length).toBeGreaterThan(5);
    let checked = 0;
    for (const l of spokes) {
      for (let i = 1; i < l.length - 1; i += 7) {
        const [x, y] = l[i];
        if (Math.hypot(x - 50, y - 50) < 6) continue; // the still centre
        const v = axes(x, y); const u = unit([v[0], v[1]]);
        const t = tangent(l, i);
        expect(Math.abs(u[0] * t[0] + u[1] * t[1])).toBeLessThan(0.08);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('across() of a vector field is a +90° turn, and stays oriented', () => {
    const vf = vectorField((x, y) => [x, y]);
    const turned = across(vf);
    expect(isAxisField(turned)).toBe(false);
    for (const [x, y] of [[3, 4], [-7, 2], [0, 5]] as const) {
      expect(turned(x, y)).toEqual([-y, x]);
    }
    // Twice across is the reverse, as a turn should be.
    expect(across(turned)(3, 4)).toEqual([-3, -4]);
  });

  it('across() refuses a scalar field by name, and absence stays absent', () => {
    expect(() => across(((x: number) => x) as unknown as VectorFieldFn)(1, 2))
      .toThrow(/scalar field has no direction/);
    const absent = across(axisField(() => [NaN, NaN]))(1, 2);
    expect(absent.every((n) => Number.isNaN(n))).toBe(true);
  });

  it('the verbs keep the axis mark, and the rotated field still traces', () => {
    const axes = axisField((x) => flipped(x));
    expect(isAxisField(rotate(axes, 30))).toBe(true);
    expect(isAxisField(translate(axes, 10, 5))).toBe(true);
    expect(isAxisField(scale(axes, 2))).toBe(true);
    expect(isAxisField(across(rotate(axes, 30)))).toBe(true);
    expect(isAxisField(rotate(vectorField(() => [1, 0]), 30))).toBe(false);
    // Rotated 30°, the lines still cross the sign change unbroken: each one
    // runs a long way, rather than stopping where the formula turns.
    const turned = lines(rotate(axes, 30));
    expect(turned.length).toBeGreaterThan(10);
    const longest = Math.max(...turned.map((l) => l.length));
    expect(longest).toBeGreaterThan(80); // a whole diagonal at step = spacing/4
    // And it really is turned: the lines run 30° up from east.
    const l = turned.find((c) => c.length > 80)!;
    const t = tangent(l, Math.floor(l.length / 2));
    expect(Math.abs(Math.abs(t[0] * Math.cos(Math.PI / 6) + t[1] * Math.sin(Math.PI / 6)) - 1)).toBeLessThan(0.02);
  });

  it('a bound keeps the mark, and a marked gradient keeps its bound', () => {
    const tk = toolkit({}, SQ);
    const bounded = tk.within(axisField((x) => flipped(x)), circle(50, 50, 30));
    expect(isAxisField(bounded)).toBe(true);
    expect(fieldMeta(bounded).bounds.length).toBe(1);
    expect(Number.isNaN(bounded(95, 50)[0])).toBe(true);
    for (const l of lines(bounded)) {
      for (const [x, y] of l) expect(Math.hypot(x - 50, y - 50)).toBeLessThan(31.5);
    }
    // Marking a derived field adds the mark and loses nothing it knew.
    const slope = tk.within((x: number, y: number) => x + y, circle(50, 50, 30));
    const axes = axisField(grad(slope));
    expect(isAxisField(axes)).toBe(true);
    expect(fieldMeta(axes).bounds.length).toBe(1);
  });

  it('is deterministic', () => {
    const a = streamlinesOf(env, axisField(swirl), { spacing: 4 });
    const b = streamlinesOf(env, axisField(swirl), { spacing: 4 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a still centre draws nothing there and never throws', () => {
    // The centre itself has no direction: a seed there makes no line.
    expect(lines(axisField(swirl), { seeds: [[50, 50]] })).toEqual([]);
    expect(lines(across(axisField(swirl)), { seeds: [[50, 50]] })).toEqual([]);
    // The rest of the paper still fills, with no stray non-finite point.
    const all = lines(axisField(swirl), { spacing: 4 });
    expect(all.length).toBeGreaterThan(5);
    for (const l of all) {
      for (const [x, y] of l) expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
  });
});

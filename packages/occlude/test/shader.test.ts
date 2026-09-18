import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, fill, initOcclude, mm, path, polygon, primLength, rect, render, shader, sketch,
  type PlanChain, type SketchDef, type StrokeInk, type StrokeProgram,
} from '../src/index.js';
import { decodePlanBuffer, encodePlanBuffer, type PlanOptions } from '../src/plan.js';
import { planBuffer } from '../src/render.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

/** A drawing with several strokes and an occluder, planned with a program. */
const scene: SketchDef = sketch({}, () => [
  polygon(circle(50, 50, 30)),
  polygon(circle(50, 50, 18)),
  polygon(rect(0, 46, 100, 8), { opaque: true }),
]);

const planned = (program?: StrokeProgram): { buffer: Float64Array; chains: PlanChain[] } => {
  const result = render(scene, { paper: { w: 100, h: 100 } });
  const { buffer } = planBuffer(result, program ? { shader: shader(program) } : {});
  return { buffer, chains: decodePlanBuffer(buffer) };
};

const inkLength = (chains: readonly PlanChain[]): number =>
  chains.reduce((sum, c) => sum + c.prims.reduce((s, p) => s + primLength(p), 0), 0);

describe('a stroke shader', () => {
  it('changes nothing when the program returns nothing', () => {
    const plain = planned();
    const shaded = planned(() => ({}));
    expect(shaded.buffer.length).toBe(plain.buffer.length);
    expect(Array.from(shaded.buffer)).toEqual(Array.from(plain.buffer));
  });

  it('draws no ink at all when nothing is kept', () => {
    expect(planned().chains.length).toBeGreaterThan(0);
    expect(planned(() => ({ keep: false })).chains).toEqual([]);
  });

  it('repeats a stroke once per pass, with the same path each time', () => {
    const plain = planned();
    const twice = planned(() => ({ passes: 2 }));
    expect(twice.chains.length).toBe(plain.chains.length * 2);
    expect(inkLength(twice.chains)).toBeCloseTo(inkLength(plain.chains) * 2, 6);
    // Retrace, not an offset: pass two is pass one's path exactly.
    expect(encodePlanBuffer([{ ...twice.chains[0], index: 0 }])).toEqual(encodePlanBuffer([{ ...twice.chains[1], index: 0 }]));
  });

  it('refuses a pen slot the drawing does not have, instead of losing the ink', () => {
    // The exporters find no pen for an unknown slot and drop the chain, so
    // this must be an error and not a silent disappearance.
    expect(() => planned(() => ({ pen: 42 }))).toThrow(/no pen 42 in this drawing/);
    expect(() => planned(() => ({ pen: NaN }))).toThrow(/no pen NaN in this drawing/);
  });

  it('refuses passes that cannot terminate, and caps the rest', () => {
    expect(() => planned(() => ({ passes: Infinity }))).toThrow(/passes must be a finite number/);
    const capped = planned(() => ({ passes: 5000 }));
    const plain = planned();
    expect(capped.chains.length).toBe(plain.chains.length * 16);
  });

  it('draws a dash finer than the nib as a solid line', () => {
    // A period below the nib is not a dash on paper. It is a hundred
    // thousand pen lifts in the plan, from a typo.
    expect(planned(() => ({ dash: [mm(0.0005), mm(0.0005)] })).buffer).toEqual(planned().buffer);
  });

  it('switches pen where the program says so, and nowhere else', () => {
    const twoPen: SketchDef = sketch({}, () => [
      polygon(circle(50, 50, 30)),
      polygon(circle(50, 50, 12), { pen: 'pigma-05-black' }),
    ]);
    const result = render(twoPen, { paper: { w: 100, h: 100 } });
    const shaded = { chains: decodePlanBuffer(planBuffer(result, { shader: shader((_s, p) => ({ pen: p[0] < 50 ? 0 : 1 })) }).buffer) };
    const pens = new Set(shaded.chains.map((c) => c.pen));
    expect(pens).toEqual(new Set([0, 1]));
    // Every chain sits on the side its pen says, give or take the nib the
    // split lands on — a span boundary is decided once per nib step.
    let wrong = 0;
    for (const c of shaded.chains) {
      const p = c.prims[0];
      const x = p.t === 'line' ? (p.x0 + p.x1) / 2 : p.t === 'arc' ? p.cx + p.r * Math.cos(p.start + p.sweep / 2) : (p.x0 + p.x1) / 2;
      if (Math.abs(x - 50) > 1 && c.pen !== (x < 50 ? 0 : 1)) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it('dashes a stroke into marks and gaps, keeping the total mark length', () => {
    const plain = planned();
    const dashed = planned(() => ({ dash: [mm(2), mm(2)] }));
    expect(dashed.chains.length).toBeGreaterThan(plain.chains.length);
    // Equal mark and gap: about half the ink survives.
    const ratio = inkLength(dashed.chains) / inkLength(plain.chains);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });

  it('gives the program arc length in mm and the stroke it is walking', () => {
    const seen: { s: number; at: number; length: number; index: number }[] = [];
    planned((s, _p, ctx) => {
      seen.push({ s, at: ctx.at, length: ctx.length, index: ctx.index });
      return {};
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const row of seen) {
      expect(row.s).toBeGreaterThanOrEqual(0);
      expect(row.s).toBeLessThanOrEqual(row.length);
      expect(row.at).toBeCloseTo(row.length > 0 ? row.s / row.length : 0, 9);
      expect(Number.isInteger(row.index)).toBe(true);
    }
    // The program is asked at the middle of each nib step, so the first
    // sample lies inside the first step rather than exactly at zero.
    expect(seen[0].s).toBeGreaterThan(0);
    expect(seen[0].s).toBeLessThan(seen[0].length);
  });

  it('names its pen, and says which pens the drawing has when the name is wrong', () => {
    const named: SketchDef = sketch({}, () => [
      polygon(circle(50, 50, 30)),
      polygon(circle(50, 50, 12), { pen: 'pigma-05-black' }),
    ]);
    const shade = (program: StrokeProgram) => {
      const result = render(named, { paper: { w: 100, h: 100 } });
      return decodePlanBuffer(planBuffer(result, { shader: shader(program) }).buffer);
    };
    const chains = shade((_s, p) => ({ pen: p[0] < 50 ? 'pigma-005-black' : 'pigma-05-black' }));
    expect(new Set(chains.map((c) => c.pen))).toEqual(new Set([0, 1]));
    expect(() => shade(() => ({ pen: 'stabilo-88-green' }))).toThrow(/does not use the pen 'stabilo-88-green'/);
  });

  it('measures arc length along a curve, not the curve\'s own parameter', () => {
    // A cubic's parameter is not uniform in arc length. Dividing one by the
    // other made marks from 1.0mm to 5.0mm when all were asked to be 2mm.
    const curve: SketchDef = sketch({}, () => path().moveTo(6, 50).bezierTo(90, 6, 10, 94, 94, 50).build());
    const out = render(curve, { paper: { w: 100, h: 100 } });
    const kinds = new Set(decodePlanBuffer(planBuffer(out, {}).buffer).flatMap((c) => c.prims.map((p) => p.t)));
    expect(kinds).toEqual(new Set(['cubic']));
    const marks = decodePlanBuffer(planBuffer(out, { shader: shader(() => ({ dash: [2, 2] })) }).buffer)
      .map((c) => c.prims.reduce((sum, p) => sum + primLength(p), 0));
    expect(marks.length).toBeGreaterThan(10);
    for (const len of marks) expect(len).toBeCloseTo(2, 1);
  });

  it('keeps a dash in phase across a span the artist cannot see', () => {
    // Two spans with the SAME dash and different passes: the boundary is
    // invisible in the marks, so the pattern must not restart at it.
    const marks = (program: StrokeProgram) => {
      const result = render(scene, { paper: { w: 100, h: 100 } });
      return decodePlanBuffer(planBuffer(result, { shader: shader(program) }).buffer)
        .map((c) => c.prims.reduce((sum, p) => sum + primLength(p), 0));
    };
    const even = marks(() => ({ dash: [mm(2), mm(2)] }));
    const split = marks((_s, _p, ctx) => ({ dash: [mm(2), mm(2)], passes: ctx.at < 0.5 ? 1 : 2 }));
    // Every mark is a full mark in both, give or take the ends of a stroke.
    const full = (lens: number[]) => lens.filter((l) => l > 1.9 && l < 2.1).length;
    expect(full(even)).toBeGreaterThan(10);
    // The second half is drawn twice, so its full marks are counted twice.
    expect(full(split)).toBeGreaterThan(full(even));
    // A restart at the boundary would leave a short mark there; allow one
    // short piece per stroke end, not one per span.
    const short = (lens: number[]) => lens.filter((l) => l < 1.5).length;
    expect(short(split)).toBeLessThanOrEqual(short(even) * 2 + 2);
  });

  it('shades a stipple tap as one thing, not along a length', () => {
    // A tap is a zero-length chain. It reaches the plan through a stipple
    // fill, and the program is asked for it once.
    const stipple: SketchDef = sketch({}, () => polygon(circle(50, 50, 30), { fill: fill('stipple', { density: 0.4 }) }));
    const taps = (opts: PlanOptions) => {
      const result = render(stipple, { paper: { w: 100, h: 100 } });
      // Plan ONCE: planning twice runs the program twice.
      const { buffer } = planBuffer(result, opts);
      const chains = decodePlanBuffer(buffer);
      return { all: chains.length, dots: chains.filter((c) => c.dot).length, buffer };
    };
    const plain = taps({});
    expect(plain.dots).toBeGreaterThan(100);

    // A tap is asked once, at zero, and its stroke has no length.
    const seen: { s: number; length: number; dot: boolean }[] = [];
    taps({ shader: shader((s, _p, ctx) => { if (ctx.dot) seen.push({ s, length: ctx.length, dot: ctx.dot }); return {}; }) });
    expect(seen.length).toBe(plain.dots);
    for (const row of seen.slice(0, 20)) {
      expect(row.s).toBe(0);
      expect(row.length).toBe(0);
    }

    // The usual promises hold for taps too.
    expect(Array.from(taps({ shader: shader(() => ({})) }).buffer)).toEqual(Array.from(plain.buffer));
    expect(taps({ shader: shader(() => ({ keep: false })) }).all).toBe(0);
    expect(taps({ shader: shader(() => ({ passes: 2 })) }).dots).toBe(plain.dots * 2);
  });

  it('refuses anything that is not a program', () => {
    expect(() => shader(undefined as unknown as StrokeProgram)).toThrow(/expected a function/);
  });

  it('reads a value out of range as no ink, not as an error', () => {
    const odd: StrokeInk = { passes: 0 };
    expect(planned(() => odd).chains).toEqual([]);
    // A dash with no gap is a solid line, and the drawing keeps rendering.
    expect(planned(() => ({ dash: [mm(1), 0] })).buffer).toEqual(planned().buffer);
  });
});

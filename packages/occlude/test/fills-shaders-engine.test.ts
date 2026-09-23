/**
 * Spec 60 (audit P7, P9, N4 and the wasm 4 GB death): a fill says what it
 * runs, a shader speaks the sketch frame, the engine refuses what it cannot
 * hold. Each block names the audit entries it closes; the sketches under
 * working/audit/sketches keep the failing lines as `// FRICTION` comments.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SQ } from './helpers/run.js';
import {
  circle, compileSketch, decodePlanBuffer, encodeScene, fill, fillAsset, initOcclude, line, mm, pen, planBuffer, polygon, rect,
  render, renderEncoded, rulings, sdf, shader, sketch, w, type FillCtx, type SketchDef, type L, type LengthField, type WasmModule,
} from '../src/index.js';
import { checkFillOpaque } from '../src/fills.js';
import { checkPlanOptions } from '../src/plan.js';
import { checkInputFits } from '../src/wasmRender.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** The plan's chains of a sketch, as the exporters see them. */
const chainsOf = (def: SketchDef) => {
  const result = render(def, SQ);
  return { result, chains: decodePlanBuffer(planBuffer(result).buffer) };
};

describe('P9 · a fill says what it runs', () => {
  it('G1-9: a misspelt built-in parameter is a type error and a refusal by name', () => {
    // @ts-expect-error: 'angel' is not a hatch parameter
    const typo = fill('hatch', { angel: 45, spcing: mm(1) });
    expect(() => render(sketch({ aspect: [1, 1] }, () => circle(50, 50, 20, { fill: typo })), SQ))
      .toThrow("fill 'hatch': unknown parameter 'angel' — 'hatch' takes angle, spacing, offset, align, step");
    // @ts-expect-error: stipple takes density and minDist
    expect(() => render(sketch({ aspect: [1, 1] }, () => circle(50, 50, 20, { fill: fill('stipple', { spacing: 2 }) })), SQ))
      .toThrow(/fill 'stipple': unknown parameter 'spacing'/);
    // A fill asset is judged by the parameters it declares.
    const combs = fillAsset({ params: { spacing: 2 }, generate: (region, p) => rulings(region, { spacing: p.spacing }) });
    // @ts-expect-error: the asset declares spacing only
    expect(() => render(sketch({ aspect: [1, 1] }, () => circle(50, 50, 20, { fill: fill(combs, { angle: 3 }) })), SQ))
      .toThrow("fill asset: unknown parameter 'angle' — asset takes spacing");
  });

  it('G1-7 · G6-34: a field where a length goes is read per line, and the shape draws its hatch', () => {
    // Fine lines in the top half, coarse in the bottom: the field is a length.
    const lanes = (params: { angle: number; spacing: L | LengthField }) => {
      const r = render(sketch({ aspect: [1, 1] }, () => rect(10, 10, 80, 80, { stroke: false, fill: fill('hatch', params) })), SQ);
      return r.frags.filter((f) => f.geom.t === 'line').map((f) => (f.geom as { y0: number }).y0);
    };
    const ys = lanes({ angle: 0, spacing: (x: number, y: number) => (y < 50 ? mm(1) : mm(3)) });
    const frame = render(sketch({ aspect: [1, 1] }, () => []), SQ).frame;
    const unit = Math.min(frame.inner.innerW, frame.inner.innerH) / 100;
    const cut = frame.offsetY + 50 * unit;
    const top = ys.filter((y) => y < cut).length;
    const bottom = ys.filter((y) => y >= cut).length;
    // Each half is 40 units tall: lines 1 mm apart above, 3 mm below.
    expect(Math.abs(top - (40 * unit) / 1)).toBeLessThanOrEqual(2);
    expect(Math.abs(bottom - (40 * unit) / 3)).toBeLessThanOrEqual(2);
    // A number spacing is the paper-phased hatch it always was.
    expect(Math.abs(lanes({ angle: 0, spacing: mm(2) }).length - (80 * unit) / 2)).toBeLessThanOrEqual(1);
  });

  it('G1-8: a stipple density field is read per disc and ends; a non-finite density refuses by name', { timeout: 20_000 }, () => {
    const t0 = performance.now();
    const r = render(sketch({ aspect: [2, 1], seed: 3 }, () => [
      circle(100, 50, 30, { stroke: false, fill: fill('stipple', { density: (x: number, y: number) => (x - 70) / 60 }) }),
    ]), SQ);
    expect(performance.now() - t0).toBeLessThan(15_000);
    const dots = r.frags.filter((f) => f.dot).map((f) => (f.geom as { x0: number }).x0);
    expect(dots.length).toBeGreaterThan(20);
    // Denser where the density is higher (the right of the disc).
    const midX = r.frame.offsetX + r.frame.inner.innerW / 2;
    expect(dots.filter((x) => x > midX).length).toBeGreaterThan(2 * dots.filter((x) => x < midX).length);
    expect(() => render(sketch({ aspect: [1, 1] }, () => circle(50, 50, 20, { fill: fill('stipple', { density: NaN }) })), SQ))
      .toThrow(/stipple: density must be a finite number from 0 to 1 or a field/);
  });

  it('G1-3 · G3-16: a fill beside opaque: false refuses by name', () => {
    expect(() => checkFillOpaque({ fill: fill('hatch'), opaque: false }))
      .toThrow('polygon: a fill that does not hide is not built yet — draw the fill and the outline separately');
    expect(() => checkFillOpaque({ fill: fill('hatch') })).not.toThrow();
    expect(() => checkFillOpaque({ opaque: false })).not.toThrow();
  });

  it('G1-20: a field parameter declared by a literal default takes any field at the call', () => {
    const toned = fillAsset({
      params: { angle: 30, tone: (x: number, y: number) => 0.5 },
      generate(region, p, ctx) {
        const { x, y, w, h } = region.bbox;
        return rulings(region, { spacing: ctx.penWidth * (1.5 + 6 * p.tone(x + w / 2, y + h / 2)), angle: p.angle });
      },
    });
    const r = render(sketch({ aspect: [1, 1] }, () =>
      circle(50, 50, 30, { fill: fill(toned, { angle: 10, tone: (x: number, y: number) => x / 100 }) })), SQ);
    expect(r.frags.length).toBeGreaterThan(10);
  });
});

describe('P7 · a shader speaks the sketch frame', () => {
  it('G3-15 · G5-12: p is in drawable units — `p[1] > 50` dashes the 5 rules below the middle of 11', () => {
    let maxY = -Infinity;
    const { chains } = chainsOf(sketch({ aspect: [1, 1] }, (t) => {
      t.plan({ shader: shader((s, p) => { maxY = Math.max(maxY, p[1]); return p[1] > 50 ? { dash: [mm(2), mm(2)] } : {}; }) });
      return t.times(11, (k, u) => line(5, 5 + u * 90, 95, 5 + u * 90));
    }));
    expect(maxY).toBeCloseTo(95, 6);
    const perRule = new Map<number, number>();
    for (const c of chains) {
      const y = Math.round((c.prims[0] as { y0: number }).y0 * 1000);
      perRule.set(y, (perRule.get(y) ?? 0) + 1);
    }
    expect(perRule.size).toBe(11);
    expect([...perRule.values()].filter((n) => n > 1).length).toBe(5);
  });

  it('s and ctx.length are drawable units, ctx.mm keeps paper mm', () => {
    const seen: { s: number; len: number; mmLen: number; mmS: number }[] = [];
    const { result } = chainsOf(sketch({ aspect: [1, 1] }, (t) => {
      t.plan({ shader: shader((s, p, ctx) => { seen.push({ s, len: ctx.length, mmLen: ctx.mm.length, mmS: ctx.mm.s }); return {}; }) });
      return line(10, 50, 60, 50);
    }));
    const unit = Math.min(result.frame.inner.innerW, result.frame.inner.innerH) / 100;
    expect(seen[0].len).toBeCloseTo(50, 6);
    expect(seen[0].mmLen).toBeCloseTo(50 * unit, 6);
    for (const v of seen) expect(v.s * unit).toBeCloseTo(v.mmS, 9);
  });

  it('G3-12 · G5-4: ctx.pen is the pen name, ctx.slot its number', () => {
    const cfg = {
      aspect: [1, 1] as [number, number],
      pens: { fine: pen({ width: mm(0.15), color: '#16181d' }), heavy: pen({ width: mm(0.32), color: '#16181d' }) },
    };
    const names = new Set<string>();
    const { result, chains } = chainsOf(sketch(cfg, (t) => {
      t.plan({ shader: shader((s, p, ctx) => {
        names.add(`${ctx.pen}:${ctx.slot}`);
        // Spare 'heavy' by name, whatever slot first use gave it.
        return ctx.pen === 'heavy' ? {} : { keep: false };
      }) });
      return [line(10, 20, 90, 20, { pen: 'heavy' }), line(10, 60, 90, 60, { pen: 'fine' })];
    }));
    expect([...names].sort()).toEqual(['fine:1', 'heavy:0']);
    expect(chains.length).toBe(1);
    expect(result.pens[chains[0].pen].name).toBe('heavy');
  });

  it('G3-13: a shader may answer any pen the sketch declares; any other name refuses and says so', () => {
    const cfg = {
      aspect: [2, 1] as [number, number],
      pens: { ink: pen({ width: mm(0.3), color: '#16181d' }), blue: pen({ width: mm(0.3), color: '#2457d6' }) },
    };
    const { result, chains } = chainsOf(sketch(cfg, (t) => {
      t.plan({ shader: shader((s, p) => (p[0] > 100 ? { pen: 'blue' } : {})) });
      return line(10, 50, 190, 50);
    }));
    // 'blue' draws nothing itself, yet the shader reaches it.
    expect(result.pens.map((p) => p.name)).toEqual(['ink', 'blue']);
    expect(new Set(chains.map((c) => result.pens[c.pen].name))).toEqual(new Set(['ink', 'blue']));
    // A drawing with no shader keeps the table it drew with.
    expect(render(sketch(cfg, () => line(10, 50, 190, 50)), SQ).pens.map((p) => p.name)).toEqual(['ink']);
    expect(() => chainsOf(sketch(cfg, (t) => {
      t.plan({ shader: shader(() => ({ pen: 'stabilo-88-blue' })) });
      return line(10, 50, 190, 50);
    }))).toThrow(/shader: this drawing has no pen 'stabilo-88-blue' \(it has 'ink', 'blue'\)\. .*declares in its `pens`/);
  });

  it('G6-35: a fill reads the sketch frame through ctx.toUnits and ctx.toPaper', () => {
    let seen: { centre: [number, number]; back: [number, number]; anchor: [number, number] } | undefined;
    render(sketch({ aspect: [1, 1] }, () => circle(30, 70, 10, {
      fill: (region, ctx: FillCtx) => {
        const centre = ctx.toUnits([ctx.anchor.e, ctx.anchor.f]);
        seen = { centre, back: ctx.toPaper(centre), anchor: [ctx.anchor.e, ctx.anchor.f] };
        return [];
      },
    })), SQ);
    expect(seen!.centre[0]).toBeCloseTo(30, 9);
    expect(seen!.centre[1]).toBeCloseTo(70, 9);
    expect(seen!.back[0]).toBeCloseTo(seen!.anchor[0], 9);
    expect(seen!.back[1]).toBeCloseTo(seen!.anchor[1], 9);
  });

  it('the frame follows the origin convention: under yUp the shader reads y up', () => {
    const ys: number[] = [];
    chainsOf(sketch({ aspect: [1, 1], yUp: true }, (t) => {
      t.plan({ shader: shader((s, p) => { ys.push(p[1]); return {}; }) });
      return line(10, 80, 90, 80);
    }));
    for (const y of ys) expect(y).toBeCloseTo(80, 6);
  });
});

describe('N4 · lengths take L', () => {
  it('G1-16: the plan bridge takes a length; a bare number stays mm', () => {
    const def = sketch({ aspect: [1, 1] }, () => line(10, 50, 90, 50));
    const result = render(def, SQ);
    expect(planBuffer(result, { bridge: mm(1) }).settings.bridgeGapMm).toEqual([1]);
    expect(planBuffer(result, { bridge: 1 }).settings.bridgeGapMm).toEqual([1]);
    expect(planBuffer(result, { bridge: w(2) }).settings.bridgeGapMm[0]).toBeCloseTo((2 / 100) * result.frame.inner.innerW, 9);
    expect(checkPlanOptions({ bridge: mm(1) }).bridge).toEqual(mm(1));
    expect(() => checkPlanOptions({ bridge: mm(-1) })).toThrow('plan: bridge must be a boolean or a non-negative length (a bare number is mm)');
  });

  it('G5-7: an sdf word refuses a tagged length by name and names the door', () => {
    expect(() => sdf.circle(50, 50, mm(4) as never)).toThrow('sdf.circle: a length like mm(4) needs the paper, and a field has none — its arguments are drawable units; give t.len(mm(4))');
    expect(() => sdf.blend([sdf.circle(0, 0, 1)], mm(3) as never)).toThrow(/^sdf\.blend: a length like mm\(3\)/);
  });
});

describe('the engine says when it cannot hold a scene', () => {
  it('names the engine\'s own death with the counts, instead of a blank page', () => {
    const exec = compileSketch(sketch({ aspect: [1, 1] }, () => line(10, 10, 90, 90)), SQ);
    const scene = encodeScene(exec);
    const dying = { wasm_prepare: () => { throw new (globalThis as any).WebAssembly.RuntimeError('unreachable'); } } as unknown as WasmModule;
    expect(() => renderEncoded(dying, scene)).toThrow(/^render: the engine ran out of memory at 1 points in 1 shapes \(preparing the outlines; its space is 4 GiB\); draw fewer/);
    const other = { wasm_prepare: () => { throw new Error('modifier tape truncated'); } } as unknown as WasmModule;
    expect(() => renderEncoded(other, scene)).toThrow('modifier tape truncated');
  });

  it('refuses only a scene whose input alone cannot fit the address space, before the call', () => {
    const exec = compileSketch(sketch({ aspect: [1, 1] }, () => line(10, 10, 90, 90)), SQ);
    const scene = encodeScene(exec);
    expect(() => checkInputFits(scene, 1, 1)).not.toThrow();
    const n = 600_000_000;
    const huge = { ...scene, prims: { length: n * 9 } as unknown as Float64Array };
    let called = false;
    const mod = { wasm_prepare: () => { called = true; throw new Error('must not run'); } } as unknown as WasmModule;
    expect(() => renderEncoded(mod, huge)).toThrow(/^render: 600,000,000 points in 1 shapes is [0-9,]+ MiB of input, more than the engine's 4 GiB address space/);
    expect(called).toBe(false);
    // Six million points of polylines — a real plot — are not refused.
    expect(() => checkInputFits({ ...scene, prims: { length: 6_700_000 * 9 } as unknown as Float64Array }, 6_700_000, 457_000)).not.toThrow();
  });
});

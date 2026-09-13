/**
 * The acceptance criterion of the execution context (working/
 * execution-context.md): running a sketch depends only on its explicit
 * inputs. Two runs with different papers, pens and seeds, interleaved
 * phase by phase, produce byte for byte what each produces alone; a run
 * that throws — in the sketch body, in a fill job, in the wasm finish —
 * or one abandoned half way leaves nothing the next run can observe.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PENS, Execution, assetTable, circle, compileSketch, encodeScene, exportSvg, fill, fillAsset, fillTable, initOcclude, line, mm, plan, render,
  renderEncoded, rulings, sketch, type ExecutionInputs, type SketchDef, type WasmModule,
} from '../src/index.js';
import { requireWasm } from '../src/wasmRender.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

const A: SketchDef = sketch({ aspect: 'paper', margin: 8 }, (t) => [
  t.times(6, (_, u) => line(0, 5 + u * 90, t.width, 5 + u * 90)),
  ...t.times(5, () => circle(t.rnd(20, 80), t.rnd(20, 80), t.rnd(5, 14), { fill: fill('hatch', { spacing: mm(1.5) }), stroke: 'fat' })),
  circle(50, 50, 10, { fill: fill('contour', { spacing: mm(1) }) }),
]);
const B: SketchDef = sketch({ aspect: 'square', margin: 3, seed: 'url' }, (t) => [
  t.times(4, () => circle(t.rnd(10, 90), t.rnd(10, 90), t.rnd(8, 20), { opaque: true, stroke: 'thin' })),
  ...t.times(30, (_, u) => line(0, u * 100, 100, 100 - u * 100)),
]);
const pensA = [{ ...DEFAULT_PENS[0], name: 'fat', width: 0.8 }, { ...DEFAULT_PENS[1], name: 'thin', width: 0.25 }];
const pensB = [{ ...DEFAULT_PENS[0], name: 'thin', width: 0.3, color: '#0000ff' }, { ...DEFAULT_PENS[1], name: 'fat', width: 1.2 }];
const inA: ExecutionInputs = { paper: { w: 210, h: 297 }, library: pensA, seed: 11 };
const inB: ExecutionInputs = { paper: { w: 150, h: 150 }, library: pensB, seed: 'bee' };

interface Trace { svg: string; planHash: string; frags: number; prims: Float64Array; seedUsed: string | number; log: number }

/** The whole pipeline, phase by phase, so two of them can be interleaved. */
function phases(def: SketchDef, inputs: ExecutionInputs) {
  const exec = new Execution(inputs);
  return {
    compile: () => compileSketch(def, exec),
    encode: () => encodeScene(exec),
    render: (scene: ReturnType<typeof encodeScene>) => renderEncoded(requireWasm(), scene),
    finish: async (): Promise<Trace> => {
      const result = render(exec);
      const p = await plan(result, {}, 'test');
      return { svg: exportSvg(exec), planHash: p.planHash, frags: result.frags.length, prims: result.raw.prims, seedUsed: exec.seedUsed, log: exec.getDrawLog().length };
    },
  };
}

async function alone(def: SketchDef, inputs: ExecutionInputs): Promise<Trace> {
  const p = phases(def, inputs);
  p.compile();
  p.render(p.encode());
  return p.finish();
}

describe('execution isolation', () => {
  it('two interleaved runs equal the same runs alone, byte for byte', async () => {
    const soloA = await alone(A, inA);
    const soloB = await alone(B, inB);
    expect(soloA.svg).not.toBe(soloB.svg);
    const pa = phases(A, inA);
    const pb = phases(B, inB);
    pa.compile();
    pb.compile();
    const sa = pa.encode();
    const sb = pb.encode();
    const ra = pa.render(sa);
    const rb = pb.render(sb);
    expect(Array.from(ra.prims)).toEqual(Array.from(soloA.prims));
    expect(Array.from(rb.prims)).toEqual(Array.from(soloB.prims));
    const ta = await pa.finish();
    const tb = await pb.finish();
    expect(ta).toEqual(soloA);
    expect(tb).toEqual(soloB);
    // and the other order
    const qb = phases(B, inB);
    const qa = phases(A, inA);
    qb.compile(); qa.compile();
    expect(await qa.finish()).toEqual(soloA);
    expect(await qb.finish()).toEqual(soloB);
  });

  it('the same sketch on different papers, pens and seeds is different, and each is reproducible', async () => {
    const x = await alone(A, inA);
    const y = await alone(A, { ...inA, seed: 12 });
    const z = await alone(A, { ...inA, paper: { w: 100, h: 100 } });
    const w = await alone(A, { ...inA, library: pensB });
    expect(y.svg).not.toBe(x.svg);
    expect(z.svg).not.toBe(x.svg);
    expect(w.svg).not.toBe(x.svg); // pen widths change the ink (hatch spacing defaults, nib judging)
    expect(await alone(A, inA)).toEqual(x);
  });

  it('a run that throws leaves nothing behind: the next run equals a first run', async () => {
    const solo = await alone(A, inA);
    // the sketch body throws
    const bad = sketch({ seed: 1 }, (t) => { t.rnd(); throw new Error('sketch boom'); });
    expect(() => compileSketch(bad, inB)).toThrow('sketch boom');
    expect(await alone(A, inA)).toEqual(solo);
    // a fill job throws between the passes
    const badFill = sketch({ seed: 1 }, () => circle(50, 50, 20, { fill: () => { throw new Error('fill boom'); } }));
    expect(() => render(badFill, { paper: 'Square20' })).toThrow('fill boom');
    expect(await alone(A, inA)).toEqual(solo);
    // the wasm finish throws (a fake module)
    const exec = compileSketch(sketch({ seed: 1 }, () => circle(50, 50, 20, { fill: fill('hatch') })), inB);
    const scene = encodeScene(exec);
    const real = requireWasm();
    const fake = { ...real, wasm_prepare: real.wasm_prepare.bind(real), wasm_finish: () => { throw new Error('finish boom'); } } as unknown as WasmModule;
    expect(() => renderEncoded(fake, scene)).toThrow('finish boom');
    expect(await alone(A, inA)).toEqual(solo);
    // an unknown pen name fails at compile, loudly, and leaves nothing
    expect(() => compileSketch(sketch({ pens: { first: 'nope' } }, () => circle(1, 1, 1)), inA)).toThrow(/unknown pen 'nope'/);
    expect(() => compileSketch(sketch({ pen: 'nope' } as never, () => circle(1, 1, 1)), inA)).toThrow(/`pen` is gone/);
    expect(await alone(A, inA)).toEqual(solo);
  });

  it('a run abandoned half way leaves nothing behind', async () => {
    const solo = await alone(B, inB);
    const half = phases(A, inA);
    half.compile(); // compiled, never encoded
    const other = phases(A, inA);
    other.compile();
    other.encode(); // encoded, never rendered
    expect(await alone(B, inB)).toEqual(solo);
    // and the abandoned runs still finish as they would have
    expect((await half.finish()).svg).toBe((await alone(A, inA)).svg);
  });

  it('an execution runs one sketch once', () => {
    const exec = compileSketch(A, inA);
    expect(() => compileSketch(B, exec)).toThrow(/already compiled/);
  });
});

describe('asset and fill inputs are snapshots', () => {
  it('editing the host\'s asset table after the run cannot reach it: text, pixels, and the table itself', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    const entries: [string, { text: string } | { pixels: { width: number; height: number; data: Uint8ClampedArray } }][] = [
      ['note.svg', { text: '<svg>one</svg>' }],
      ['pic.png', { pixels: { width: 2, height: 1, data } }],
    ];
    const table = assetTable(entries);
    const a = new Execution({ paper: { w: 100, h: 100 }, assets: table });
    const b = new Execution({ paper: { w: 100, h: 100 }, assets: table });
    const mutable = table as Map<string, { text?: string; pixels?: { data: Uint8ClampedArray } }>;
    // the host mutates what it handed over
    mutable.get('note.svg')!.text = '<svg>two</svg>';
    data[0] = 200;
    mutable.set('note.svg', { text: '<svg>three</svg>' });
    mutable.delete('pic.png');
    for (const exec of [a, b]) {
      const def = sketch({}, (t) => { expect(t.asset('note.svg')).toBe('<svg>one</svg>'); expect(t.image('pic.png').lum(0.5, 0.5)).toBe(0); return circle(1, 1, 1); });
      compileSketch(def, exec);
    }
    expect(a.inputs.assets).not.toBe(b.inputs.assets);
  });

  it('editing a fill definition after the run cannot reach it', () => {
    const def = fillAsset({ params: { spacing: 2, angle: 0 }, generate(region, p) { return rulings(region, { spacing: p.spacing as number, angle: p.angle as number }); } });
    const table = fillTable([['bars', def]]) as Map<string, typeof def>;
    const sk = sketch({ seed: 1 }, () => circle(50, 50, 20, { fill: fill('bars') }));
    const exec = compileSketch(sk, { paper: { w: 200, h: 200 }, fills: table });
    const before = render(exec).stats.fillPrims;
    (def.params as { spacing: number }).spacing = 20; // sparser
    table.delete('bars');
    const again = compileSketch(sk, { paper: { w: 200, h: 200 }, fills: exec.inputs.fills });
    expect(render(again).stats.fillPrims).toBe(before);
    expect(exec.inputs.fills!.get('bars')!.params.spacing).toBe(2);
  });
});

describe('fill snapshots copy nested params and keep functions', () => {
  it('a nested value changed on the original stays as captured; a function param is the same function', () => {
    const density = (x: number) => x;
    const def = fillAsset({
      params: { look: { spacing: 2, weights: [1, 2], tones: new Float64Array([0.5]) }, density },
      generate() { return []; },
    });
    const exec = new Execution({ paper: { w: 100, h: 100 }, fills: fillTable([['deep', def]]) });
    const nested = def.params.look as { spacing: number; weights: number[]; tones: Float64Array };
    nested.spacing = 20;
    nested.weights.push(3);
    nested.tones[0] = 9;
    const kept = exec.inputs.fills!.get('deep')!.params.look as typeof nested;
    expect(kept.spacing).toBe(2);
    expect(kept.weights).toEqual([1, 2]);
    expect(kept.tones[0]).toBe(0.5);
    expect(exec.inputs.fills!.get('deep')!.params.density).toBe(density);
  });
});

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
  DEFAULT_PENS, Execution, circle, compileSketch, encodeScene, exportSvg, fill, initOcclude, line, mm, plan, render,
  renderEncoded, sketch, type ExecutionInputs, type SketchDef, type WasmModule,
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
    expect(() => compileSketch(sketch({ pen: 'nope' }, () => circle(1, 1, 1)), inA)).toThrow(/unknown pen 'nope'/);
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

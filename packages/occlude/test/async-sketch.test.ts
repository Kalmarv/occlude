import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Execution, compileSketch, compileSketchAsync, encodeScene, initOcclude, line, render, renderAsync, sketch, sketchAsync, type Toolkit, type SketchDef } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});
const body = (t: Toolkit) => line(t.rnd(0, 30), 10, t.width, 70);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('explicit async sketches', () => {
  it('renders the same seeded ink through both entry points', async () => {
    const config = { seed: 42 };
    const sync = sketch(config, body);
    const asyncDef = sketchAsync(config, async t => { await Promise.resolve(); return body(t); });
    expect((await renderAsync(asyncDef)).raw.prims).toEqual(render(sync).raw.prims);
    expect((await renderAsync(sync)).raw.prims).toEqual(render(sync).raw.prims);
    expect(() => compileSketch(asyncDef as unknown as SketchDef)).toThrow('async rendering required');
    expect(() => render(asyncDef as unknown as SketchDef)).toThrow('async rendering required');
  });
  it('keeps interleaved runs independent and rejects competing use of one execution', async () => {
    const pause = gate();
    const run = new Execution({ paper: { w: 210, h: 297 } });
    const def = sketchAsync({ seed: 42 }, async t => { await pause.promise; return body(t); });
    const pending = compileSketchAsync(def, run);
    await expect(compileSketchAsync(def, run)).rejects.toThrow('already has');
    expect(() => compileSketch(sketch({}, body), run)).toThrow('already has');
    const other = await compileSketchAsync(sketch({ seed: 19 }, body));
    pause.release();
    await pending;
    expect(encodeScene(run)).toEqual(encodeScene(compileSketch(sketch({ seed: 42 }, body))));
    expect(encodeScene(other)).toEqual(encodeScene(compileSketch(sketch({ seed: 19 }, body))));
  });
  it('does not emit a cancelled result and preserves single-use executions', async () => {
    const pause = gate(), controller = new AbortController();
    const run = new Execution({ paper: { w: 210, h: 297 } });
    const pending = compileSketchAsync(sketchAsync({}, async () => { await pause.promise; return line(0, 0, 100, 100); }), run, { signal: controller.signal });
    controller.abort(); pause.release();
    await expect(pending).rejects.toThrow();
    expect(encodeScene(run)).toEqual(encodeScene(compileSketch(sketch({}, () => null))));
    await expect(compileSketchAsync(sketch({}, body), run)).rejects.toThrow('already compiled');
    await expect(compileSketchAsync(sketchAsync({}, async () => { throw new Error('model failed'); }))).rejects.toThrow('model failed');
    expect(await compileSketchAsync(sketch({}, body))).toBeInstanceOf(Execution);
  });
});

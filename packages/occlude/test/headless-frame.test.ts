import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { exportGcode, exportPng, exportSvg, initOcclude, line, render, setPaperHint, sketch, type RenderOptions, type SketchDef } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

it.each([render, exportGcode, exportPng, exportSvg])('headless entry point establishes paper before compiling (%#)', (run) => {
  let dimensions: number[] = [];
  const def = sketch({ aspect: 'paper', margin: 10, seed: 1 }, t => {
    dimensions = [t.width, t.height];
    return line(0, 0, t.width, t.height);
  });
  for (const [paper, expected] of [
    ['Square20', [100, 100]],
    [{ paper: { w: 100, h: 200 }, landscape: true }, [225, 100]],
    ['Square20', [100, 100]],
  ] as [RenderOptions['paper'], number[]][]) {
    setPaperHint(210, 297);
    (run as (def: SketchDef, opts: RenderOptions) => unknown)(def, { paper });
    expect(dimensions).toEqual(expected);
  }
});

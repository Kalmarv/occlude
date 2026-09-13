/**
 * Test-side inputs: the explicit run a test compiles against. `SQ` is the
 * old "Square20" hint (a 200 × 200 mm sheet: a 100 × 100 drawable), `A4`
 * the package default. `toolkit()` binds a toolkit to a fresh execution
 * for tests that exercise sketch-time verbs (`within`, `translate`,
 * `isolines` …) outside a sketch function.
 */

import {
  Execution, bindToolkit, paperSize, type CompileConfig, type ExecutionInputs, type PaperChoice, type Toolkit,
} from '../../src/index.js';

export const SQ: ExecutionInputs = { paper: { w: 200, h: 200 } };
export const A4: ExecutionInputs = { paper: { w: 210, h: 297 } };

/** Inputs on a named paper, with anything else spread over them. */
export function inputs(paper: PaperChoice | string = 'Square20', extra: Partial<ExecutionInputs> = {}): ExecutionInputs {
  const { w, h } = paperSize(typeof paper === 'string' ? { paper } : paper);
  return { paper: { w, h }, ...extra };
}

/** A toolkit bound to a fresh execution begun with `cfg`, for sketch-time
 * calls made outside a sketch function. */
export function toolkit(cfg: CompileConfig = {}, run: ExecutionInputs = SQ): Toolkit & { exec: Execution } {
  const exec = new Execution(run);
  exec.begin(cfg);
  return Object.assign(bindToolkit(exec), { exec });
}

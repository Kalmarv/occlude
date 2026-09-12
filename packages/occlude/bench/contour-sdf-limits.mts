/** Real-WASM regression for spacing that exceeds a 32-bit level count.
 * BENCH_BINDINGS=/tmp/pkg/occlude_core.js pnpm --filter occlude exec tsx bench/contour-sdf-limits.mts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sketch, rect, fill, mm, render } from '../src/index.js';
import { setWasm } from '../src/render.js';

if (!process.env.BENCH_BINDINGS) throw new Error('BENCH_BINDINGS must name the candidate WASM bindings');
const url = pathToFileURL(resolve(process.env.BENCH_BINDINGS));
const core = await import(url.href);
await core.default({ module_or_path: readFileSync(new URL('occlude_core_bg.wasm', url)) });
setWasm(core as never);
const scene = sketch({ aspect: 'square', seed: 42 }, () =>
  rect(10, 10, 30, 20, { stroke: false, fill: fill('contour', { spacing: mm(1e-9) }) }),
);
assert.throws(
  () => render(scene, { paper: { paper: { w: 304.8, h: 304.8 } } }),
  /more than 100000 contour levels/,
);
console.log('ok: excessive WASM level count is rejected before conversion, without empty success');

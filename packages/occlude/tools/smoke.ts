#!/usr/bin/env tsx
/**
 * The library smoke test of the reference build: one deterministic sketch
 * through the compiled wasm — a curved primitive (arc), a cubic, a filled
 * shape that hides ink under it and a mask — must produce non-empty
 * geometry and an SVG that parses. It proves the wasm the build emitted
 * loads and the real pipeline (encode → prepare → fills → finish → plan →
 * svg) runs; the ink oracles (`docs:hashes`, all-features) judge the bytes.
 *
 *   pnpm --filter occlude smoke [--svg out.svg]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  circle, exportSvg, fill, initOcclude, line, mask, mm, path, rect, render, sketch,
} from '../src/index.js';

const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
const wasmBytes = readFileSync(wasmPath);
if (wasmBytes.subarray(0, 4).toString('latin1') !== '\0asm') throw new Error(`${wasmPath} is not a wasm module`);
await initOcclude(wasmBytes);

const def = sketch({ aspect: 'square', margin: 8, seed: 7 }, (t) => [
  t.times(12, (_, u) => line(0, 5 + u * 90, 100, 5 + u * 90)),
  circle(35, 45, 22, { fill: fill('contour', { spacing: mm(1.2) }) }),
  rect(55, 20, 35, 30, { fill: fill('hatch', { spacing: mm(1) }) }),
  path().moveTo(10, 85).bezierTo(30, 55, 60, 100, 95, 70).build(),
  mask(circle(70, 75, 9)),
]);

const result = render(def, { paper: 'A4' });
const svg = exportSvg(def, { paper: 'A4' });
const paths = (svg.match(/<path\b/g) ?? []).length;
const outArg = process.argv.indexOf('--svg');
if (outArg >= 0 && process.argv[outArg + 1]) writeFileSync(process.argv[outArg + 1], svg);

const fail = (why: string): never => {
  console.error(`smoke FAIL: ${why}`);
  process.exit(1);
};
if (result.frags.length === 0) fail('render produced no fragments');
if (!result.frags.some((f) => f.geom.t === 'arc')) fail('no arc reached the output');
if (!result.frags.some((f) => f.geom.t === 'cubic')) fail('no cubic reached the output');
if (!svg.startsWith('<svg') && !svg.startsWith('<?xml')) fail('export is not an SVG document');
if (!/viewBox="[^"]+"/.test(svg)) fail('SVG has no viewBox');
if (paths === 0) fail('SVG has no paths');
if (!svg.trimEnd().endsWith('</svg>')) fail('SVG is truncated');
console.log(`smoke ok: ${result.frags.length} fragments, ${paths} svg paths, ${result.pens.length} pens, wasm ${wasmBytes.length} bytes`);

#!/usr/bin/env node
/**
 * The definition of done in one command: `pnpm check`.
 *
 * Runs every gate CLAUDE.md asks for and prints one line each, with the
 * failing gate's output rather than a wall of everything. A gate that is
 * skipped because an earlier one failed is reported as such, so a red run
 * always says what to look at first.
 *
 *   rust       cargo test -p occlude-core
 *   ts         pnpm -r test            (occlude + studio)
 *   types      tsc over src, tools and test
 *   studio     tsc over the studio (vite strips types without checking)
 *   docs       every `ts live` fence renders
 *   ink        every fence renders the same bytes as the committed baseline
 *   build      library tsc + studio bundle
 *   wasm       the bundled wasm is the crate's build, byte for byte
 *   smoke      a sketch through the compiled wasm to a parseable SVG, and
 *              the production server resolving every module and the wasm
 *
 * The same command runs inside the Docker reference build (Dockerfile,
 * stage `verified`), where the wasm was built from source first; that is
 * the CI. The gate map lives in docs/architecture.md.
 *
 * `ink` is what makes a refactor provable: re-run with `--save` in the
 * occlude package after a DELIBERATE ink change (see tools/docs-hashes.ts).
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('.', import.meta.url).pathname;
const gates = [
  ['rust', ['cargo', ['test', '-p', 'occlude-core']]],
  ['ts', ['pnpm', ['-r', 'test']]],
  ['types', ['pnpm', ['--filter', 'occlude', 'typecheck']]],
  ['studio', ['pnpm', ['--filter', 'occlude-studio', 'typecheck']]],
  ['docs', ['pnpm', ['--filter', 'occlude', 'docs:check']]],
  ['ink', ['pnpm', ['--filter', 'occlude', 'docs:hashes', '--', '--check']]],
  ['build', ['pnpm', ['build']]],
];

let failed = null;
for (const [name, [cmd, args]] of gates) {
  if (failed) {
    console.log(`skip ${name.padEnd(6)} (${failed} failed)`);
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    failed = name;
    console.log(`FAIL ${name.padEnd(6)} ${secs}s`);
    console.log([r.stdout, r.stderr].filter(Boolean).join('').trimEnd());
    continue;
  }
  console.log(`ok   ${name.padEnd(6)} ${secs}s`);
}

// The bundled wasm is the crate's build: hashed in process, so the check
// cannot pass by comparing a file with itself through a shell glob.
if (!failed) {
  const digest = (p) => createHash('md5').update(readFileSync(p)).digest('hex');
  const built = digest(`${root}crates/occlude-core/pkg/occlude_core_bg.wasm`);
  const bundled = readdirSync(`${root}packages/occlude-studio/dist/assets`).filter((f) => /^occlude_core_bg-.*\.wasm$/.test(f));
  if (bundled.length !== 1) {
    failed = 'wasm';
    console.log(`FAIL wasm   expected one bundled occlude_core_bg-*.wasm, found ${bundled.length}`);
  } else {
    const shipped = digest(`${root}packages/occlude-studio/dist/assets/${bundled[0]}`);
    if (shipped !== built) {
      failed = 'wasm';
      console.log(`FAIL wasm   pkg ${built} != dist ${shipped}`);
    } else {
      console.log(`ok   wasm   ${built}`);
    }
  }
}

// The smoke tests need the build and the wasm match, so they run last.
if (!failed) {
  const t0 = Date.now();
  const r = spawnSync('pnpm', ['smoke'], { cwd: root, encoding: 'utf8' });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    failed = 'smoke';
    console.log(`FAIL smoke  ${secs}s`);
    console.log([r.stdout, r.stderr].filter(Boolean).join('').trimEnd());
  } else {
    console.log(`ok   smoke  ${secs}s`);
  }
}

console.log(failed ? `\n${failed} failed — nothing after it was run` : '\nall gates pass');
process.exit(failed ? 1 : 0);

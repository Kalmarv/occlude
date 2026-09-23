#!/usr/bin/env node
/**
 * The loop a change runs while it is being made: `pnpm loop`.
 *
 *   types   the incremental typecheck (tsconfig.check.json)
 *   tests   the test files the diff can reach (`test:affected`)
 *   ink     the docs fences the diff can reach (`docs:affected`)
 *
 * One line per stage with its result and seconds, in the order above; the
 * first failure stops the loop with that stage's tail and a non-zero exit.
 * Nothing here re-saves a baseline. It is not the gate: `pnpm check` is, and
 * runs every test and every fence. The two affected stages read maps built
 * per commit (`pnpm maps`); with none for HEAD each says so and runs its
 * full set.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
/** Each stage: its script, and the line of its output that says what it did. */
const stages = [
  ['types', 'typecheck', () => 'clean'],
  ['tests', 'test:affected', (out) => [
    /^(affected \d+ of \d+ test files|no test map[^:]*|full fast set: .*)/m.exec(out)?.[1],
    /^\s+Tests\s+(.*)$/m.exec(out)?.[1],
  ].filter(Boolean).join(' · ')],
  ['ink', 'docs:affected', (out) => [
    /^(affected \d+ of \d+|no coverage map[^:]*|full check: .*)/m.exec(out)?.[1],
    /^(\d+\/\d+ examples ink-identical)/m.exec(out)?.[1],
  ].filter(Boolean).join(' · ')],
];

const t0 = Date.now();
for (const [name, script, result] of stages) {
  const t = Date.now();
  const r = spawnSync('pnpm', ['--silent', 'run', script], { cwd: pkg, encoding: 'utf8', maxBuffer: 1 << 28 });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  const out = [r.stdout, r.stderr].filter(Boolean).join('');
  if (r.status !== 0) {
    console.log(`FAIL ${name.padEnd(6)} ${secs}s`);
    console.log(out.trimEnd().split('\n').slice(-40).join('\n'));
    console.log(`\n${name} failed after ${((Date.now() - t0) / 1000).toFixed(1)}s — nothing after it was run`);
    process.exit(1);
  }
  console.log(`ok   ${name.padEnd(6)} ${secs.padStart(5)}s  ${result(out)}`);
}
console.log(`\nloop ${((Date.now() - t0) / 1000).toFixed(1)}s`);

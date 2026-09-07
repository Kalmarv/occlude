// Every harness, in one run, with a header before each.
//
//   pnpm --filter occlude bench          all of them
//   pnpm --filter occlude bench --quick  skip the slow ones
//
// This is the regression check: the optimisation log records what each row
// cost when it was last measured, so a row that has drifted upward is the
// signal. It is NOT a comparison across machines or across days — the numbers
// in the log were taken on one box under one load, and so are these. To judge
// a change, run the harness either side of it, interleaved.
//
// Two of them are Rust and are not run from here:
//   cd crates/occlude-core
//   cargo run --release --example export_bench --no-default-features --features profile
//   cargo run --release --example stack_bench  --no-default-features --features profile -- 400
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const quick = process.argv.includes('--quick');
const here = fileURLToPath(new URL('.', import.meta.url));
const sketches = '../occlude-studio/sketches';

/** [script, extra args, one line on what it covers, slow?] */
const suite: [string, string[], string, boolean][] = [
  ['qbench.mts', [], 'edge queries: nearest and firstHit over a 35 k-edge net', false],
  ['codex.mts', [], 'connections: connect.nearest, resample, nearest queries', false],
  ['rsbench.mts', [], 'resampling, both edge-transfer policies', false],
  ['sepbench.mts', [], 'force.separation against a bare typed-array kernel', false],
  ['gbench.mts', [], 'growth: scatter/relax/settle machinery and long runs', true],
  ['pbench.mts', [], 'the points vocabulary: Poisson disk and the Lloyd loop', true],
  ['fbench.mts', [], 'planarization and faces, up to a million vertices', true],
  ['ibench.mts', [], 'isolines and streamlines — CONFIRM ON dist, see README', false],
  ['imbench.mts', [], 'image sampling: summed-area tables and the samplers', false],
  ['obench.mts', [], 'heavy occlusion, as scaling series', true],
  ['prof.mts', [], 'per-phase costs incl. the wasm plan pipeline', true],
  ['planbench.mts', [`${sketches}/flow-user.ts`, `${sketches}/church.ts`, `${sketches}/contours.ts`],
    'the plan and decodeRender — what a studio render pays beyond renderhash', false],
];

let ran = 0;
for (const [script, args, what, slow] of suite) {
  if (quick && slow) {
    console.log(`\n\x1b[2m── ${script} — skipped (--quick)\x1b[0m`);
    continue;
  }
  console.log(`\n\x1b[1m── ${script}\x1b[0m  ${what}`);
  const r = spawnSync('node', ['--import', 'tsx', here + script, ...args], { stdio: 'inherit' });
  if (r.status !== 0) console.log(`\x1b[31m   ${script} exited ${r.status}\x1b[0m`);
  ran++;
}
console.log(`\n${ran} harness${ran === 1 ? '' : 'es'} run.`);

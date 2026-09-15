#!/usr/bin/env node
/**
 * One command from a commit to a served, verified build.
 *
 *   pnpm ship            production studio (docker-compose.yml, service `studio`, port OCCLUDE_PORT or 4173)
 *   pnpm ship dev        the isolated dev studio (docker-compose.yml + compose.3d.yml, service `dev`, port 5273);
 *                        run it from the checkout that owns that compose project
 *   pnpm ship --push     also push HEAD to origin (and to `dev` when on master) once the served stamp is verified
 *
 * The Docker build IS the verification: the image only exists once the nine
 * gates in check.mjs pass inside it. This script adds what was done by hand
 * before: a traceable build stamp, the restart, and proof that the served
 * bundle carries that stamp. A dirty tree still ships (the stamp gets a `+`),
 * so a fix can be tried before it is committed; --push refuses a dirty tree.
 */
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) ?? 'prod';
const push = args.includes('--push');
if (!['prod', 'dev'].includes(target)) { console.error(`usage: ship [prod|dev] [--push]`); process.exit(2); }

const sh = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.status !== 0) { console.error(`\nship: ${cmd} ${argv.join(' ')} failed (${r.status})`); process.exit(r.status ?? 1); }
};
const out = (cmd, argv) => spawnSync(cmd, argv, { encoding: 'utf8' }).stdout.trim();

const head = out('git', ['rev-parse', '--short', 'HEAD']);
const dirty = out('git', ['status', '--porcelain', '--untracked-files=no']) !== '';
const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (push && dirty) { console.error('ship: --push needs a clean tree (commit first)'); process.exit(2); }
const stamp = `${head}${dirty ? '+' : ''}${target === 'dev' ? '-dev' : ''}`;

const compose = target === 'dev'
  ? ['compose', '-p', 'occlude-3d', '-f', 'docker-compose.yml', '-f', 'compose.3d.yml', '--profile', 'dev']
  : ['compose'];
const service = target === 'dev' ? 'dev' : 'studio';
const port = target === 'dev' ? 5273 : Number(process.env.OCCLUDE_PORT ?? 4173);
const env = { ...process.env, OCCLUDE_BUILD_STAMP: stamp };

console.log(`ship: ${target} ${stamp} (${branch}${dirty ? ', dirty' : ''})`);
const t0 = Date.now();
sh('docker', [...compose, 'build', service], { env });
sh('docker', [...compose, 'up', '-d', service], { env });

// The bundle names the stamp; the page names the bundle. Wait for both.
const base = `http://127.0.0.1:${port}`;
let served = '';
for (let i = 0; i < 40 && !served; i++) {
  await sleep(1500);
  try {
    const html = await (await fetch(base, { signal: AbortSignal.timeout(3000) })).text();
    const bundle = html.match(/\/assets\/main[^"]*\.js/)?.[0];
    if (!bundle) continue;
    const js = await (await fetch(base + bundle, { signal: AbortSignal.timeout(5000) })).text();
    const m = js.match(new RegExp(`${stamp.replace(/[+.]/g, '\\$&')} \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}`));
    if (m) served = m[0];
  } catch { /* not up yet */ }
}
if (!served) { console.error(`ship: ${base} did not serve stamp ${stamp} within 60 s`); process.exit(1); }
console.log(`ship: ${base} serves ${served} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

if (push) {
  sh('git', ['push', 'origin', 'HEAD']);
  if (branch === 'master') sh('git', ['push', 'origin', 'HEAD:dev']);
  console.log(`ship: pushed ${head}`);
}

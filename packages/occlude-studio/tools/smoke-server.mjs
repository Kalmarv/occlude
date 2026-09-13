#!/usr/bin/env node
/**
 * The studio smoke test of the reference build: start the production
 * server on a free port against the built dist and prove the page can
 * load and reach a render — every page, every module the pages import
 * (script + modulepreload), the worker bundles, and the wasm asset they
 * resolve — all answer 200 with the right content type, and the wasm the
 * server hands out is the crate's build (magic bytes + md5 against pkg).
 *
 * No browser: the render path itself is the library smoke (`smoke.ts`)
 * through the same wasm. What this catches is the build/serve seam —
 * a bundle that references an asset the server does not have.
 *
 *   pnpm --filter occlude-studio smoke
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const pkgWasm = resolve(root, '../../crates/occlude-core/pkg/occlude_core_bg.wasm');

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

const port = await freePort();
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const base = `http://127.0.0.1:${port}`;

const failures = [];
const fetched = new Set();
async function expect(path, type) {
  if (fetched.has(path)) return null;
  fetched.add(path);
  let r;
  try {
    r = await fetch(base + path);
  } catch (e) {
    failures.push(`${path}: ${e.message}`);
    return null;
  }
  const ct = r.headers.get('content-type') ?? '';
  if (r.status !== 200) failures.push(`${path}: HTTP ${r.status}`);
  else if (type && !ct.startsWith(type)) failures.push(`${path}: content-type ${ct}, wanted ${type}`);
  return r;
}

try {
  // wait for the server to listen
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await fetch(base + '/api/version'); break; } catch {
      if (Date.now() > deadline) throw new Error(`server did not start on ${port}:\n${serverLog}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const version = await (await expect('/api/version', 'application/json')).json();
  if (typeof version.build !== 'string') failures.push('/api/version: no build id');

  const pages = readdirSync(dist).filter((f) => f.endsWith('.html'));
  if (pages.length === 0) failures.push('dist has no pages');
  let modules = 0;
  for (const page of pages) {
    const r = await expect('/' + page, 'text/html');
    if (!r || r.status !== 200) continue;
    const html = await r.text();
    const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => u.startsWith('/'));
    // self-contained pages (public/*.html) reference nothing; the app pages must
    if (refs.length === 0 && (page === 'index.html' || page === 'docs.html')) failures.push(`${page}: references no assets`);
    for (const ref of refs) {
      const type = ref.endsWith('.css') ? 'text/css' : ref.endsWith('.js') ? 'text/javascript' : undefined;
      if (await expect(ref, type)) modules++;
    }
  }
  // Workers and the wasm are reached from JS, not HTML: read every bundle
  // the server would serve and follow the asset names it embeds.
  const assets = readdirSync(join(dist, 'assets'));
  const wasmNames = new Set();
  let workers = 0;
  for (const a of assets.filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(dist, 'assets', a), 'utf8');
    for (const m of src.matchAll(/occlude_core_bg-[\w-]+\.wasm/g)) wasmNames.add(m[0]);
    for (const m of src.matchAll(/new Worker\(new URL\("([^"]+)"/g)) {
      const w = m[1].startsWith('/') ? m[1] : '/assets/' + m[1].replace(/^\.\//, '');
      if (await expect(w, 'text/javascript')) workers++;
    }
  }
  if (wasmNames.size !== 1) failures.push(`expected one wasm asset referenced by the bundles, found ${[...wasmNames].join(', ') || 'none'}`);
  for (const name of wasmNames) {
    const r = await expect('/assets/' + name, 'application/wasm');
    if (!r || r.status !== 200) continue;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.subarray(0, 4).toString('latin1') !== '\0asm') failures.push(`${name}: not a wasm module`);
    const served = createHash('md5').update(bytes).digest('hex');
    const built = createHash('md5').update(readFileSync(pkgWasm)).digest('hex');
    if (served !== built) failures.push(`${name}: served md5 ${served} != crate build ${built}`);
  }
  if (workers === 0) failures.push('no worker bundle found in the built JS');
  // the store APIs answer (an empty library is fine)
  await expect('/api/sketches', 'application/json');
  await expect('/api/fills', 'application/json');
  await expect('/api/assets', 'application/json');
  await expect('/api/results', 'application/json');
  await expect('/docs', 'text/html');
  console.log(failures.length
    ? `studio smoke FAIL\n  ${failures.join('\n  ')}`
    : `studio smoke ok: ${pages.length} pages, ${modules} modules, ${workers} workers, wasm ${[...wasmNames][0]}, build ${version.build}`);
} finally {
  server.kill();
}
process.exit(failures.length ? 1 : 0);

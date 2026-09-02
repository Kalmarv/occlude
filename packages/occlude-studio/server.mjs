#!/usr/bin/env node
/**
 * Production server for occlude studio: serves the vite build from ./dist
 * plus the sketch-store API. No dependencies — plain Node.
 *
 *   node server.mjs             # port 4173, all interfaces
 *   PORT=8080 node server.mjs
 *
 * Intended to sit behind a reverse proxy / Cloudflare tunnel. The sketch API
 * has NO auth of its own — lock access at the tunnel (Cloudflare Access).
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSketchHandler } from './sketch-store.mjs';
import { createAssetHandler } from './asset-store.mjs';
import { createFillHandler } from './fill-store.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const dist = join(root, 'dist');
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '0.0.0.0';

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html not found — run `pnpm build` first.');
  process.exit(1);
}

const sketchApi = createSketchHandler(join(root, 'sketches'));
const assetApi = createAssetHandler(join(root, 'assets'));
const fillApi = createFillHandler(join(root, 'fills'), join(root, 'sketches'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

const buildId = String(statSync(join(dist, 'index.html')).mtimeMs);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/version') {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ build: buildId }));
    return;
  }
  if (url.pathname.startsWith('/api/assets')) {
    void assetApi(req, res);
    return;
  }
  if (url.pathname.startsWith('/api/fills')) {
    void fillApi(req, res);
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    void sketchApi(req, res);
    return;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/docs' || pathname === '/docs/') pathname = '/docs.html';
  // Path-traversal guard: resolve inside dist only.
  const file = normalize(join(dist, pathname));
  if (!file.startsWith(dist)) {
    res.statusCode = 403;
    return res.end('forbidden');
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    res.statusCode = 404;
    return res.end('not found');
  }
  if (!stat.isFile()) {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
  res.setHeader('content-length', stat.size);
  // Hashed assets are immutable; HTML and the API must revalidate.
  if (pathname.startsWith('/assets/')) {
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('cache-control', 'no-cache');
  }
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`occlude studio serving on http://${host}:${port} (dist + sketch API)`);
});

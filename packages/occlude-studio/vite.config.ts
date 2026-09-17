import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** The commit this build came from — shown in the status bar so "which
 * build is this tab on" is a glance, never a guess. */
function buildStamp(): string {
  // The reference build has no .git in its context (see .dockerignore); the
  // compose file passes the commit in instead.
  if (process.env.OCCLUDE_BUILD_STAMP) return process.env.OCCLUDE_BUILD_STAMP;
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no -- ../../packages ../../crates', { cwd: __dirname }).toString().trim() ? '+' : '';
    return `${sha}${dirty}`;
  } catch {
    return 'dev';
  }
}
// @ts-expect-error plain-JS module shared with the production server
import { createSketchHandler } from './sketch-store.mjs';
// @ts-expect-error same
import { createAssetHandler } from './asset-store.mjs';
// @ts-expect-error same
import { createFillHandler } from './fill-store.mjs';
// @ts-expect-error same
import { createResultHandler } from './result-store.mjs';

/** Sketch-store API in dev/preview; server.mjs hosts the same handler in prod. */
function sketchStore(): Plugin {
  const handler = createSketchHandler(resolve(__dirname, 'sketches'));
  const assets = createAssetHandler(resolve(__dirname, 'assets'));
  const fills = createFillHandler(resolve(__dirname, 'fills'), resolve(__dirname, 'sketches'));
  const results = createResultHandler(resolve(__dirname, 'results'));
  return {
    name: 'occlude-sketch-store',
    configureServer(server) {
      server.middlewares.use(assets);
      server.middlewares.use(fills);
      server.middlewares.use(results);
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(assets);
      server.middlewares.use(fills);
      server.middlewares.use(results);
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify(`${buildStamp()} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`),
  },
  plugins: [sketchStore()],
  // occlude is consumed as TS source from the workspace; vite transpiles it.
  optimizeDeps: {
    exclude: ['occlude', 'occlude-core'],
  },
  server: {
    allowedHosts: (process.env.OCCLUDE_DEV_HOSTS ?? '').split(',').map(host => host.trim()).filter(Boolean),
    fs: { allow: ['../..'] },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        three: resolve(__dirname, 'three.html'),
        docs: resolve(__dirname, 'docs.html'),
        assets: resolve(__dirname, 'assets.html'),
        fills: resolve(__dirname, 'fills.html'),
        sketches: resolve(__dirname, 'sketches.html'),
        machine: resolve(__dirname, 'machine.html'),
        results: resolve(__dirname, 'results.html'),
        evolve: resolve(__dirname, 'evolve.html'),
        // The docs site's live-example script: a stable name, since the
        // (separately built) docs pages load it by URL.
        live: resolve(__dirname, 'src/live-embed.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'live' ? 'live-embed.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});

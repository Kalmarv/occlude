import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
// @ts-expect-error plain-JS module shared with the production server
import { createSketchHandler } from './sketch-store.mjs';
// @ts-expect-error same
import { createAssetHandler } from './asset-store.mjs';
// @ts-expect-error same
import { createFillHandler } from './fill-store.mjs';

/** Sketch-store API in dev/preview; server.mjs hosts the same handler in prod. */
function sketchStore(): Plugin {
  const handler = createSketchHandler(resolve(__dirname, 'sketches'));
  const assets = createAssetHandler(resolve(__dirname, 'assets'));
  const fills = createFillHandler(resolve(__dirname, 'fills'), resolve(__dirname, 'sketches'));
  return {
    name: 'occlude-sketch-store',
    configureServer(server) {
      server.middlewares.use(assets);
      server.middlewares.use(fills);
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(assets);
      server.middlewares.use(fills);
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [sketchStore()],
  // occlude is consumed as TS source from the workspace; vite transpiles it.
  optimizeDeps: {
    exclude: ['occlude', 'occlude-core'],
  },
  server: {
    fs: { allow: ['../..'] },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        docs: resolve(__dirname, 'docs.html'),
        assets: resolve(__dirname, 'assets.html'),
        fills: resolve(__dirname, 'fills.html'),
        sketches: resolve(__dirname, 'sketches.html'),
      },
    },
  },
});

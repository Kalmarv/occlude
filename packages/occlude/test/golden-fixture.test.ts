/**
 * The golden-fixture sentinel: the Rust golden test renders a committed
 * scene + fills sidecar (crates/occlude-core/tests/fixtures/golden) that
 * the PRODUCT fills generated. Cargo stays node-free; this test, where
 * node already lives, guards the fixture's freshness — when a fill module
 * changes its ink on purpose, this fails first, and
 *   UPDATE_GOLDEN=1 pnpm --filter occlude test -- golden-fixture
 * rewrites the fixture (then UPDATE_GOLDEN=1 cargo test golden the SVG).
 */

import { transformSync } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { DEFAULT_PENS, clearFills, initOcclude } from '../src/index.js';
import { dumpSceneFiles } from '../tools/scene-dump.js';

const fixtureDir = fileURLToPath(new URL('../../../crates/occlude-core/tests/fixtures/golden/', import.meta.url));

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

it('the committed golden fixture is what the product fills produce today', () => {
  const src = readFileSync(fileURLToPath(new URL('./fixtures/golden-scene.ts', import.meta.url)), 'utf8');
  const js = transformSync(src, { loader: 'ts', format: 'cjs' }).code;
  clearFills();
  const files = dumpSceneFiles(js, { paper: { paper: 'A6' }, pens: structuredClone(DEFAULT_PENS) });
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(fixtureDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(fixtureDir + name, content);
    return;
  }
  for (const [name, content] of Object.entries(files)) {
    expect(existsSync(fixtureDir + name), `${name} missing — UPDATE_GOLDEN=1 to create`).toBe(true);
    const committed = readFileSync(fixtureDir + name);
    const fresh = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    expect(
      Buffer.compare(committed, fresh),
      `${name} drifted from the committed golden fixture — a fill changed its ink; ` +
        'UPDATE_GOLDEN=1 pnpm --filter occlude test -- golden-fixture, then UPDATE_GOLDEN=1 cargo test golden',
    ).toBe(0);
  }
});

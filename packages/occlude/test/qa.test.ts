import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initOcclude } from '../src/index.js';
import { scenarios } from '../tools/qa-scenarios.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

// A fast slice of the sweep (pnpm qa runs the full version): every scenario
// at a few arbitrary seeds, expecting zero violations.
describe('qa invariants', () => {
  for (const [name, fn] of Object.entries(scenarios)) {
    it(`${name} holds across seeds`, () => {
      for (const seed of [11, 271, 5081]) {
        expect(fn(seed), `${name} seed ${seed}`).toEqual([]);
      }
    });
  }
});

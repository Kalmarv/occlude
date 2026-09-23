/**
 * Two sets of tests, one config. A test file that takes over five seconds
 * on its own (measured, not guessed) is named `*.slow.test.ts` and runs only
 * in the slow set; everything else is fast. `OCCLUDE_TESTS` picks the set:
 *
 *   pnpm test         fast (the default)
 *   pnpm test:slow    OCCLUDE_TESTS=slow
 *   pnpm test:all     OCCLUDE_TESTS=all — what `pnpm check` runs
 *
 * `pnpm test:affected` runs an explicit file list under `all`, so a slow
 * test a change reaches still runs. `OCCLUDE_TEST_MAP=1` wires the coverage
 * recorder that `pnpm test:map` builds its map with (test/setup/coverage.ts).
 * Every setting not named here is vitest's default.
 */

import { configDefaults, defineConfig } from 'vitest/config';

const SLOW = '**/*.slow.test.ts';
/** Local spike files, kept out of git by .git/info/exclude: never in a set. */
const SPIKES = ['test/events-spike.test.ts', 'test/globe-certs.test.ts'];
const set = process.env.OCCLUDE_TESTS ?? 'fast';
const mapping = process.env.OCCLUDE_TEST_MAP === '1';
if (!['fast', 'slow', 'all'].includes(set)) throw new Error(`OCCLUDE_TESTS=${set}: expected fast, slow or all`);

export default defineConfig({
  test: {
    include: set === 'slow' ? [SLOW] : configDefaults.include,
    exclude: [...configDefaults.exclude, ...SPIKES, ...(set === 'fast' ? [SLOW] : [])],
    setupFiles: mapping ? ['test/setup/coverage.ts'] : [],
    // Block coverage slows the code it counts; a test cut short by the
    // default 5 s would leave a record missing what it never reached.
    ...(mapping ? { testTimeout: 60_000 } : {}),
  },
});

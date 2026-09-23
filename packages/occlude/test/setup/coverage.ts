/**
 * The test map's recorder, wired by vitest.config.ts only when
 * OCCLUDE_TEST_MAP=1 (`pnpm test:map` sets it). A setup file runs in the
 * test file's own worker before the test file imports anything, so the
 * coverage session starts before the code it records is compiled; the
 * file's last `afterAll` takes what it ran and writes its record to
 * OCCLUDE_TEST_MAP_OUT (tools/test-coverage.ts says what a record holds).
 */

import { join } from 'node:path';
import { afterAll } from 'vitest';
import { TestFileRecorder, testCacheDir } from '../../tools/test-coverage.js';

const out = process.env.OCCLUDE_TEST_MAP_OUT ?? join(testCacheDir, 'partial');
const recorder = await TestFileRecorder.start();

// Registered first, so under vitest's stacked hooks it runs after the test
// file's own. Turning offsets into lines takes a while on a big file.
afterAll(async (file) => {
  await recorder.finish((file as { filepath: string }).filepath, out);
}, 600_000);

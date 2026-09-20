/**
 * `maxLength` as a field: the length is read AT THE SEED, so one seed grows
 * one line of that length. Long where the field is long, dots where it is
 * short, nothing where it is shorter than a nib.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { initOcclude, mm, vectorField } from '../src/index.js';
import type { IsoEnv } from '../src/isolines.js';
import { streamlinesOf } from '../src/streamlines.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** Bare-units env: 100×100 drawable, lengths taken at face value. */
const env: IsoEnv = {
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  len: (l) => (typeof l === 'number' ? l : l.value),
};
const east = vectorField(() => [1, 0]);
const length = (pts: [number, number][]): number =>
  pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

describe('streamlines maxLength', () => {
  it('a number still caps every line, as it always did', () => {
    const lines = streamlinesOf(env, east, { spacing: 8, maxLength: 10 });
    expect(lines.length).toBeGreaterThan(0);
    // Each half of a line is capped, so the whole line is at most twice it.
    for (const c of lines) expect(length(c.pts)).toBeLessThanOrEqual(20 + 1e-6);
    // Without the cap the same field draws right across the page.
    const full = streamlinesOf(env, east, { spacing: 8 });
    expect(Math.max(...full.map((c) => length(c.pts)))).toBeGreaterThan(90);
  });

  it('a field makes the lines long on one side of the page and short on the other', () => {
    // East everywhere, so a line and the seeds it queues stay at the x they
    // started at: the left flood reads 4 at every seed, the right one 30.
    const taper = (x: number) => (x < 50 ? 4 : 30);
    const left = streamlinesOf(env, east, { spacing: 6, seeds: [[25, 50]], maxLength: taper });
    const right = streamlinesOf(env, east, { spacing: 6, seeds: [[75, 50]], maxLength: taper });
    expect(left.length).toBeGreaterThan(1);
    expect(right.length).toBeGreaterThan(1);
    // A short mark on the left; a long run on the right. The cap is met to
    // the nearest whole integration step, each way from the seed.
    for (const c of left) expect(length(c.pts)).toBeLessThanOrEqual(2 * (4 + 1.5) + 1e-6);
    expect(Math.max(...right.map((c) => length(c.pts)))).toBeGreaterThan(20);
  });

  it('a length that is zero, absent or below a nib draws nothing for that seed', () => {
    const seeds: [number, number][] = [[20, 50], [80, 50]];
    // Nothing anywhere.
    expect(streamlinesOf(env, east, { spacing: 5, seeds, maxLength: 0 })).toEqual([]);
    expect(streamlinesOf(env, east, { spacing: 5, seeds, maxLength: mm(0.1) })).toEqual([]);
    expect(streamlinesOf(env, east, { spacing: 5, seeds, maxLength: () => NaN })).toEqual([]);
    // The rule is per seed, not per drawing: the same field draws nothing
    // from the seed on the left and a whole flood from the one on the
    // right, which is the only difference between these two calls.
    const short = (x: number) => (x < 50 ? 0 : 20);
    expect(streamlinesOf(env, east, { spacing: 5, seeds: [[20, 50]], maxLength: short })).toEqual([]);
    expect(streamlinesOf(env, east, { spacing: 5, seeds: [[80, 50]], maxLength: short }).length).toBeGreaterThan(1);
  });

  it('is read once per line, so the same field gives the same ink', () => {
    const opts = { spacing: 7, maxLength: (x: number, y: number) => 3 + (x + y) / 10 };
    const a = streamlinesOf(env, east, opts);
    const b = streamlinesOf(env, east, opts);
    expect(a.map((c) => c.pts)).toEqual(b.map((c) => c.pts));
  });
});

/**
 * The kitchen-sink ink oracle: renders `test/fixtures/all-features.ts` and
 * pins the visible fragment count, the SHA-256 of the exported SVG, the
 * plan identity, and the plan's estimate on the one time model. A public
 * name the sketch uses that is removed or renamed stops the fixture
 * compiling; an engine change that moves ink anywhere in the extracted
 * surface fails here, loudly and in `pnpm test`.
 *
 * The pin is deliberate: after an intended ink change,
 *   UPDATE_ALLFEATURES=1 pnpm --filter occlude exec vitest run all-features
 * rewrites `fixtures/all-features.json` — read that diff as the change.
 *
 * Like the docs oracle, this renders on `Square20`, so `mm()` has a fixed
 * meaning. The fixture sets its own seed (7) in its config.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import {
  DEFAULT_PENS, estimatePlanMs, exportSvg, hashPlan, initOcclude, plan, planToolpath, render,
  selectAll, type EstimateOpts,
} from '../src/index.js';
import { preloadAssetsFromDisk } from '../tools/asset-preload.js';
import allFeatures from './fixtures/all-features.js';

const PAPER = 'Square20';

/** The same estimator `plotstats` and the export panel read. */
const TIMING: EstimateOpts = {
  travelFeed: 6000,
  acceleration: 800,
  travelAcceleration: 1500,
  junctionDeviation: 0.05,
  minimumCruiseRatio: 0.5,
};

interface FeaturePin {
  fragments: number;
  svgHash: string;
  planHash: string;
  estimateMs: number;
}

const pinPath = fileURLToPath(new URL('./fixtures/all-features.json', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/all-features.ts', import.meta.url));

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

it('pins the ink of the whole-surface sketch', async () => {
  preloadAssetsFromDisk(readFileSync(fixturePath, 'utf8'));
  const result = render(allFeatures, { paper: PAPER });
  const drawing = await plan(result);

  // hashPlan is the exported door to the plan identity: it must agree with
  // the value `plan()` stamped, or the identity has two spellings.
  const recomputedHash = await hashPlan(drawing.buffer, drawing.settings);
  if (recomputedHash !== drawing.planHash) {
    throw new Error(`hashPlan disagrees with plan(): ${recomputedHash} !== ${drawing.planHash}`);
  }

  const penOf = (i: number) => {
    const p = DEFAULT_PENS[i];
    return p ? { feed: p.feed, penDelay: p.penDelay } : undefined;
  };
  const flat = planToolpath(drawing, selectAll(drawing), 0.05);
  const actual: FeaturePin = {
    fragments: result.frags.length,
    svgHash: sha256(exportSvg(allFeatures, { paper: PAPER })),
    planHash: drawing.planHash,
    estimateMs: Math.round(estimatePlanMs(flat, penOf, TIMING).totalMs),
  };

  console.log(`all-features pin: ${JSON.stringify(actual)}`);
  if (process.env.UPDATE_ALLFEATURES) {
    writeFileSync(pinPath, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }

  const expected = JSON.parse(readFileSync(pinPath, 'utf8')) as FeaturePin;
  expect(
    actual,
    'all-features ink drifted. Expected vs actual:\n' +
      `  expected ${JSON.stringify(expected)}\n` +
      `  actual   ${JSON.stringify(actual)}\n` +
      'An intended change: UPDATE_ALLFEATURES=1 pnpm --filter occlude exec vitest run all-features',
  ).toEqual(expected);
});

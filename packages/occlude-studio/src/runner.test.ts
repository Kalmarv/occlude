/**
 * The studio runner: one Execution per run, the `@user/pens` and
 * `@user/papers` modules served from the captured libraries, the draw and
 * inspect hooks bound to that run, and nothing shared between runs.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PENS, assetTable, fillTable, tagDraws } from 'occlude';
import { currentDraws, currentSeed, moduleName, runSketch, runSketchAsync, type RunConfig } from './runner.js';

const cfg: RunConfig = {
  pens: [{ ...DEFAULT_PENS[0], name: 'fineliner' }, { ...DEFAULT_PENS[1], name: 'micron-03' }],
  papers: [{ name: 'a4', w: 210, h: 297, color: '#ffffff' }, { name: 'letter', w: 215.9, h: 279.4 }],
  paper: 'Square20',
  landscape: false,
  defaultMarginPct: 5,
  coarsen: 1,
};

/** A sketch module as the editor emits it (CommonJS). */
const emitted = (body: string): string => `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const occlude_1 = require("occlude");
const pens_1 = require("@user/pens");
const papers_1 = require("@user/papers");
${body}`;

describe('studio runner', () => {
  it('serves @user/pens and @user/papers from the captured libraries, as instance factories', () => {
    const js = emitted(`
exports.default = (0, occlude_1.sketch)({
  paper: (0, papers_1.letter)({ color: '#F5F0E6' }),
  pens: { blue: (0, pens_1.fineliner)({ color: '#2457D6' }), plain: (0, pens_1.micron_03)() },
  margin: (0, occlude_1.inch)(0.5),
}, (t) => [
  (0, occlude_1.circle)(50, 50, 20, { stroke: 'blue' }),
  (0, occlude_1.circle)(50, 50, 10, { stroke: 'plain' }),
]);`);
    const out = runSketch(js, cfg, 7, assetTable(), fillTable([]));
    expect(out.error).toBeNull();
    expect(out.run!.paper).toEqual({ w: 215.9, h: 279.4, color: '#F5F0E6' });
    expect(out.run!.pens.get('blue')).toMatchObject({ color: '#2457D6', width: DEFAULT_PENS[0].width });
    expect(out.run!.pens.get('plain')).toMatchObject({ width: DEFAULT_PENS[1].width });
    expect(out.scene!.pens.map((p) => p.name)).toEqual(['blue', 'plain']);
    expect(out.scene!.paper).toEqual({ w: 215.9, h: 279.4, color: '#F5F0E6' });
    expect(moduleName('micron-03')).toBe('micron_03');
    expect(moduleName('3b')).toBe('_3b');
  });

  it('refuses any other import, and a bad module leaves no run behind', () => {
    const out = runSketch(`require('fs');`, cfg, 1, assetTable(), fillTable([]));
    expect(String((out.error as Error).message)).toMatch(/@user\/pens/);
    expect(out.scene).toBeNull();
  });

  it('binds the draw hook to the run: the seed tail lands, the log is the run\'s', () => {
    const src = `import { sketch, circle } from 'occlude';
export default sketch({}, (t) => circle(t.rnd(10, 90), 50, 5));`;
    const tagged = tagDraws(`"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const occlude_1 = require("occlude");
exports.default = (0, occlude_1.sketch)({}, (t) => (0, occlude_1.circle)(t.rnd(10, 90), 50, 5));`);
    void src;
    const a = runSketch(tagged.js, cfg, '5', assetTable(), fillTable([]));
    const b = runSketch(tagged.js, cfg, '5', assetTable(), fillTable([]));
    expect(a.error).toBeNull();
    expect(currentDraws(a.run!).addrs).toEqual(currentDraws(b.run!).addrs);
    expect(currentDraws(a.run!).addrs.length).toBe(1);
    expect(currentSeed(a.run!)).toBe('5');
    const addr = currentDraws(a.run!).addrs[0].replace(':', '.');
    const c = runSketch(tagged.js, cfg, `5~${addr}=0.5`, assetTable(), fillTable([]));
    expect(currentDraws(c.run!).f[0]).toBe(0.5);
    expect(currentSeed(c.run!)).toBe(`5~${addr}=0.5`);
    // the earlier runs are untouched by the later one
    expect(currentDraws(a.run!).f[0]).not.toBe(0.5);
  });
});

it('awaits async modules with captured libraries and seeded draws', async () => {
  const js = emitted(`exports.default = occlude_1.sketchAsync({ seed: 42, pens: { blue: pens_1.fineliner() } }, async t => {
    await Promise.resolve();
    return occlude_1.circle(t.rnd(20, 80), 50, 10, { stroke: 'blue' });
  });`);
  const a = await runSketchAsync(js, cfg, 7, assetTable(), fillTable([]));
  const b = await runSketchAsync(js, cfg, 7, assetTable(), fillTable([]));
  expect(a.error).toBeNull(); expect(a.scene).not.toBeNull();
  expect(a.scene).toEqual(b.scene);
  expect(currentDraws(a.run!).addrs).toHaveLength(1);
  expect(runSketch(js, cfg, 7, assetTable(), fillTable([])).error).toMatchObject({ message: expect.stringContaining('async rendering required') });
});

import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { circle, exportPng, initOcclude, line, sketch, type DrawRequest } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});
const opts = { paper: 'Square20', scale: 1 };
const lines = (request: DrawRequest = {}, firstOnly = false) => sketch({ seed: 1 }, t => {
  t.plan({ optimize: false, bridge: false });
  t.draw(request);
  return [line(10, 10, 30, 10), ...(firstOnly ? [] : [line(10, 30, 30, 30)])];
});
it('PNG uses the selected plan for empty, partial, and full drawings', () => {
  const blank = exportPng(sketch({ seed: 1 }, () => []), opts);
  expect(exportPng(lines({ chains: [0, 0] }), opts)).toEqual(blank);
  expect(exportPng(lines({ progress: [0, 0.5] }), opts)).toEqual(exportPng(lines({}, true), opts));
  expect(exportPng(lines({ progress: [0, 1] }), opts)).toEqual(exportPng(lines(), opts));
  expect(exportPng(sketch({ seed: 1 }, t => { t.draw({ chains: [0, 0] }); return circle(50, 50, 10); }), opts)).toEqual(blank);
});
it('PNG includes bridges constructed by the drawing plan', () => {
  const drawing = (bridge: boolean | number, connector = false) => sketch({ seed: 1 }, t => {
    t.plan({ optimize: false, bridge });
    return [line(10, 20, 30, 20), ...(connector ? [line(30, 20, 32, 20)] : []), line(32, 20, 50, 20)];
  });
  const bridged = exportPng(drawing(5), opts);
  expect(bridged).not.toEqual(exportPng(drawing(false), opts));
  expect(bridged).toEqual(exportPng(drawing(false, true), opts));
});
it('PNG resolves time-based selections with machine timing', () => {
  expect(() => exportPng(lines({ minutes: [0, 0.1] }), opts)).toThrow(/machine timing/);
  const timing = { penOf: () => ({ feed: 3000, penDelay: 100 }), opts: { travelFeed: 6000, acceleration: 800, travelAcceleration: 1500, junctionDeviation: 0.05, minimumCruiseRatio: 0.5 } };
  expect(exportPng(lines({ minutes: [0, 100] }), { ...opts, timing })).toEqual(exportPng(lines(), opts));
  expect(exportPng(lines({ budget: 0 }), { ...opts, timing })).toEqual(exportPng(sketch({ seed: 1 }, () => []), opts));
});

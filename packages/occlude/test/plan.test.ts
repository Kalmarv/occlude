import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PENS, circle, rect, sketch, stroke, render, exportSvg, initOcclude, estimatePlanMs, schedulePlan,
  plan as planOf, planBuffer, planSvg, planGcode, planToolpath, makePlan, openPlan, hashPlan, canonicalJson,
  decodePlanBuffer, encodePlanBuffer, parseToolpath, encodeToolpath,
  selectChains, selectAll, selectProgress, selectTime, selectedFlat, standaloneEstimate, fitDuration,
  type DrawingPlan, type FlatChain, type PlanChain, type EstimateOpts,
} from '../src/index.js';

const timing: EstimateOpts = { travelFeed: 6000, acceleration: 800, travelAcceleration: 1500, junctionDeviation: 0.05, minimumCruiseRatio: 0.5 };
const penOf = (i: number) => {
  const p = DEFAULT_PENS[i];
  return p ? { feed: p.feed, penDelay: p.penDelay } : undefined;
};

// a synthetic plan: N line chains laid left to right, one dot among them
function synthetic(n: number, opts: { dotAt?: number; pens?: number } = {}): PlanChain[] {
  const chains: PlanChain[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * 10;
    if (i === opts.dotAt) chains.push({ index: i, pen: 0, dot: true, prims: [{ t: 'line', x0: x, y0: 0, x1: x, y1: 0 }] });
    else chains.push({ index: i, pen: i % (opts.pens ?? 1), dot: false, prims: [{ t: 'line', x0: x, y0: 0, x1: x + 5, y1: 20 + (i % 3) * 5 }] });
  }
  return chains;
}
const settings = { tourBudget: 1, pens: [{ name: 'a', width: 0.3 }, { name: 'b', width: 0.5 }], paper: { w: 100, h: 50 }, bridgeGapMm: [0.15, 0.25] };
async function plan(chains: PlanChain[]): Promise<DrawingPlan> {
  return makePlan(encodePlanBuffer(chains), settings);
}
function flatten(chains: PlanChain[]): FlatChain[] {
  return chains.map((c, index) => {
    const p = c.prims[0] as { x0: number; y0: number; x1: number; y1: number };
    return { index, pen: c.pen, dot: c.dot, pts: c.dot ? Float64Array.of(p.x0, p.y0) : Float64Array.of(p.x0, p.y0, p.x1, p.y1) };
  });
}

describe('plan buffer and identity', () => {
  it('round-trips every primitive kind and rejects bad buffers', () => {
    const chains: PlanChain[] = [
      { index: 0, pen: 1, dot: false, prims: [{ t: 'line', x0: 0, y0: 0, x1: 1, y1: 0 }, { t: 'arc', cx: 1, cy: 1, r: 1, start: -Math.PI / 2, sweep: Math.PI / 2 }, { t: 'cubic', x0: 2, y0: 1, c0x: 3, c0y: 2, c1x: 4, c1y: 0, x1: 5, y1: 1 }] },
      { index: 1, pen: 0, dot: true, prims: [{ t: 'line', x0: 7, y0: 7, x1: 7, y1: 7 }] },
    ];
    const buf = encodePlanBuffer(chains);
    expect(decodePlanBuffer(buf)).toEqual(chains);
    expect(() => decodePlanBuffer(buf.subarray(0, buf.length - 1))).toThrow(/truncated/);
    expect(() => decodePlanBuffer(Float64Array.of(2, 0))).toThrow(/schema/);
    const tp = encodeToolpath(flatten(synthetic(3, { dotAt: 1 })));
    expect(parseToolpath(tp, 5).map((c) => c.index)).toEqual([5, 6, 7]);
    expect(parseToolpath(tp)[1].dot).toBe(true);
  });

  it('hash covers settings and bytes, ignores key order, never timestamps', async () => {
    const buf = encodePlanBuffer(synthetic(4));
    const a = await hashPlan(buf, settings);
    const b = await hashPlan(buf, { paper: { h: 50, w: 100 }, bridgeGapMm: [0.15, 0.25], pens: settings.pens, tourBudget: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashPlan(buf, { ...settings, tourBudget: 2 })).not.toBe(a);
    expect(await hashPlan(encodePlanBuffer(synthetic(5)), settings)).not.toBe(a);
    expect(await hashPlan(buf, { ...settings, pens: [{ name: 'a', width: 0.35 }, settings.pens[1]] })).not.toBe(a);
    expect(canonicalJson({ b: [1, { z: 1, y: 2 }], a: null })).toBe('{"a":null,"b":[1,{"y":2,"z":1}]}');
    const p = await makePlan(buf, settings);
    await expect(openPlan(buf, settings, p.planHash)).resolves.toBeTruthy();
    await expect(openPlan(buf, settings, 'deadbeef')).rejects.toThrow(/hash mismatch/);
  });
});

describe('chain and progress selection', () => {
  it('empty, full, singleton, endpoints, invalid and non-finite inputs', async () => {
    const p = await plan(synthetic(10));
    expect(selectAll(p)).toMatchObject({ fromChain: 0, toChain: 10, count: 10 });
    expect(selectChains(p, { from: 3, to: 3 }).count).toBe(0);
    expect(selectChains(p, { from: 9, to: 10 }).count).toBe(1);
    expect(selectChains(p, { from: 2, to: 5 }).selectionHash).toBe(`${p.planHash}:2-5`);
    for (const bad of [{ from: -1, to: 2 }, { from: 0, to: 11 }, { from: 5, to: 4 }, { from: 1.5, to: 3 }, { from: NaN, to: 3 }, { from: 0, to: Infinity }]) {
      expect(() => selectChains(p, bad)).toThrow();
    }
    expect(selectProgress(p, { from: 0, to: 1 })).toMatchObject({ fromChain: 0, toChain: 10 });
    expect(selectProgress(p, { from: 0, to: 0.35 })).toMatchObject({ fromChain: 0, toChain: 3 });
    expect(selectProgress(p, { from: 0.25, to: 0.29 })).toMatchObject({ fromChain: 2, toChain: 2 }); // same boundary: empty, visibly
    expect(selectProgress(p, { from: 0.999, to: 1 })).toMatchObject({ fromChain: 9, toChain: 10 });
    expect(() => selectProgress(p, { from: 0.5, to: 0.2 })).toThrow();
    expect(() => selectProgress(p, { from: 0, to: 1.2 })).toThrow();
    expect(selectAll(await plan([])).count).toBe(0);
  });
});

describe('time selection and standalone estimates', () => {
  it('quantizes to completed chains, keeps zero-duration items at the start, excludes a chain it ends inside', async () => {
    const chains = synthetic(6, { dotAt: 0 });
    const p = await plan(chains);
    const flat = flatten(chains);
    const sched = schedulePlan(flat, penOf, timing);
    const done = sched.chainStartMs.map((s, i) => s + sched.chainDurMs[i]);
    const total = sched.estimate.totalMs;
    expect(selectTime(p, flat, { fromMs: 0, toMs: total }, sched).selection).toMatchObject({ fromChain: 0, toChain: 6 });
    // ending inside chain 3 excludes it
    const mid = (done[2] + done[3]) / 2;
    const t = selectTime(p, flat, { fromMs: 0, toMs: mid }, sched);
    expect(t.selection.toChain).toBe(3);
    expect(t.effective.toMs).toBe(done[2]);
    // exact completion time includes that chain
    expect(selectTime(p, flat, { fromMs: 0, toMs: done[3] }, sched).selection.toChain).toBe(4);
    // a start inside chain 1 resolves EARLIER, to the boundary after chain 0 (quantization, not clipping)
    const s = selectTime(p, flat, { fromMs: (done[0] + done[1]) / 2, toMs: total }, sched);
    expect(s.selection.fromChain).toBe(1);
    expect(s.effective.fromMs).toBe(done[0]);
    expect(() => selectTime(p, flat, { fromMs: 10, toMs: 5 }, sched)).toThrow();
    expect(() => selectTime(p, flat, { fromMs: 0, toMs: total + 1 }, sched)).toThrow();
    expect(() => selectTime(p, flat, { fromMs: NaN, toMs: 1 }, sched)).toThrow();
    const empty = await plan([]);
    const es = schedulePlan([], penOf, timing);
    expect(selectTime(empty, [], { fromMs: 0, toMs: 0 }, es).selection.count).toBe(0);
  });

  it('a middle interval costs its own travel and final lift, not a timestamp difference', async () => {
    const chains = synthetic(8);
    const p = await plan(chains);
    const flat = flatten(chains);
    const sched = schedulePlan(flat, penOf, timing);
    const sel = selectChains(p, { from: 3, to: 6 });
    const own = standaloneEstimate(flat, sel, penOf, timing);
    const direct = estimatePlanMs(flat.slice(3, 6), penOf, timing);
    expect(own.totalMs).toBe(direct.totalMs);
    const byStamps = sched.chainStartMs[5] + sched.chainDurMs[5] - sched.chainStartMs[3];
    expect(own.totalMs).not.toBe(byStamps);
    expect(own.travelMs).toBeGreaterThan(0); // travel from the origin to chain 3
  });

  it('fitDuration agrees with direct estimates at every prefix, across pen changes; budget 0 and an oversized first chain give empty', async () => {
    const chains = synthetic(9, { pens: 2, dotAt: 4 });
    const p = await plan(chains);
    const flat = flatten(chains);
    const sel = selectChains(p, { from: 2, to: 9 });
    const mine = flat.slice(2, 9);
    for (let k = 1; k <= mine.length; k++) {
      const direct = estimatePlanMs(mine.slice(0, k), penOf, timing).totalMs;
      const fit = fitDuration(p, flat, sel, { budgetMs: direct }, penOf, timing);
      expect(fit.selection.count).toBeGreaterThanOrEqual(k);
      // and the chosen prefix's reported estimate equals a direct estimate of it
      expect(fit.estimatedMs).toBeCloseTo(estimatePlanMs(mine.slice(0, fit.selection.count), penOf, timing).totalMs, 9);
      const under = fitDuration(p, flat, sel, { budgetMs: direct - 1e-6 }, penOf, timing);
      expect(under.selection.count).toBeLessThan(k + 1);
    }
    expect(fitDuration(p, flat, sel, { budgetMs: 0 }, penOf, timing).selection.count).toBe(0);
    const first = estimatePlanMs(mine.slice(0, 1), penOf, timing).totalMs;
    const tooSmall = fitDuration(p, flat, sel, { budgetMs: first / 2 }, penOf, timing);
    expect(tooSmall.selection).toMatchObject({ fromChain: 2, toChain: 2 });
    expect(tooSmall.unusedMs).toBe(first / 2);
    const all = fitDuration(p, flat, sel, { budgetMs: 1e9 }, penOf, timing);
    expect(all.selection.toChain).toBe(9);
    expect(all.dropped).toBe(0);
    const other = await plan(synthetic(2));
    expect(() => fitDuration(p, flat, selectAll(other), { budgetMs: 1 }, penOf, timing)).toThrow(/another plan/);
  });
});

describe('engine: one plan, every consumer', () => {
  beforeAll(async () => {
    const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
    await initOcclude(readFileSync(wasmPath));
  });
  const pens = DEFAULT_PENS;
  const drawing = sketch({ aspect: [1, 1], seed: 1 }, (t) =>
    t.times(12, (k, u) => [circle(20 + u * 60, 30, 8, { pen: pens[k % 2].name }), stroke([[10, 60 + k * 2.5], [90, 62 + k * 2.5]])]),
  );

  it('the full selection reproduces the legacy exports exactly; ranges are slices', async () => {
    const r = render(drawing, { paper: 'Square20' });
    const p = await planOf(r);
    const { buffer, settings } = planBuffer(r);
    expect((await makePlan(buffer, settings)).planHash).toBe(p.planHash); // plan() IS planBuffer + makePlan
    expect(p.chains.length).toBeGreaterThan(20);
    expect(p.chains.some((c) => c.prims.some((q) => q.t === 'arc'))).toBe(true); // circles stay arcs
    const legacy = exportSvg(drawing, { paper: 'Square20' });
    expect(planSvg(p, selectAll(p), r.pens)).toBe(legacy);
    // per-pen filter over the full plan equals the legacy only_pen export
    expect(planSvg(p, selectAll(p), r.pens, { onlyPen: 1 })).toBe(exportSvg(drawing, { paper: 'Square20', onlyPen: 1 }));
    const full = planToolpath(p, selectAll(p), 0.05);
    const sel = selectChains(p, { from: 5, to: 12 });
    const part = planToolpath(p, sel, 0.05);
    expect(part.map((c) => c.index)).toEqual([5, 6, 7, 8, 9, 10, 11]);
    for (let k = 0; k < part.length; k++) expect(Array.from(part[k].pts)).toEqual(Array.from(full[5 + k].pts));
    const svg = planSvg(p, sel, r.pens);
    expect(svg.match(/<path/g)?.length).toBe(p.chains.slice(5, 12).filter((c) => !c.dot).length);
    const jobs = planGcode(p, sel, r.pens);
    expect(jobs.reduce((n, j) => n + (j.gcode.match(/G0 X/g)?.length ?? 0), 0)).toBe(sel.count + jobs.length); // one travel per chain + one home per job
    const other = await makePlan(buffer, { ...settings, tourBudget: 7 });
    expect(() => planSvg(p, selectChains(other, { from: 0, to: 1 }), r.pens)).toThrow(/another plan/);
  });

  it('selecting after visibility never reveals what later ink hid', async () => {
    // a line drawn first, then an opaque disc over its middle: the plan holds
    // the two visible stubs; selecting only the line's chains shows stubs, not the whole line
    const covered = sketch({ aspect: [1, 1], seed: 1 }, () => [stroke([[10, 50], [90, 50]]), circle(50, 50, 20, { opaque: true, pen: pens[1].name })]);
    const r = render(covered, { paper: 'Square20' });
    const pb = planBuffer(r);
    const p = await makePlan(pb.buffer, pb.settings);
    const lineChains = p.chains.filter((c) => c.pen === 0);
    expect(lineChains.length).toBe(2); // two stubs
    const onlyLine = selectChains(p, { from: 0, to: lineChains.length });
    const flat = planToolpath(p, onlyLine, 0.05);
    const xs = flat.flatMap((c) => Array.from(c.pts).filter((_, i) => i % 2 === 0));
    expect(xs.every((x) => x <= 60.01 || x >= 139.99)).toBe(true); // paper is 200 mm: sketch units doubled
    // and the bare line alone WOULD have been one chain: the selection did not re-solve visibility
    const bare = render(sketch({ aspect: [1, 1], seed: 1 }, () => stroke([[10, 50], [90, 50]])), { paper: 'Square20' });
    expect(decodePlanBuffer(planBuffer(bare).buffer).length).toBe(1);
  });
});

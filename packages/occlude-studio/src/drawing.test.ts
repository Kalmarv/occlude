import { describe, expect, it } from 'vitest';
import { encodePlanBuffer, encodeToolpath, hashPlan, type FlatChain, type PlanChain, type PlanSettings } from 'occlude';
import { Drawing } from './drawing.js';
import type { RenderClient } from './workerClient.js';

const settings: PlanSettings = { tourBudget: 1, pens: [{ name: 'a', width: 0.3 }], paper: { w: 100, h: 50 }, bridgeGapMm: [0.15] };
const pens = [{ name: 'a', width: 0.3, color: '#000', feed: 3000, penDown: 0, penUp: 5, penDelay: 100 }];
const timing = () => ({
  opts: { travelFeed: 6000, acceleration: 800, travelAcceleration: 1500, junctionDeviation: 0.05, minimumCruiseRatio: 0.5 },
  penOf: () => ({ feed: 3000, penDelay: 100 }),
  tolerance: 0.05,
});
function chains(n: number): PlanChain[] {
  return Array.from({ length: n }, (_, i) => ({ index: i, pen: 0, dot: false, prims: [{ t: 'line' as const, x0: i * 10, y0: 0, x1: i * 10 + 5, y1: 20 }] }));
}
function flatOf(cs: PlanChain[]): FlatChain[] {
  return cs.map((c) => { const p = c.prims[0] as { x0: number; y0: number; x1: number; y1: number }; return { index: c.index, pen: 0, dot: false, pts: Float64Array.of(p.x0, p.y0, p.x1, p.y1) }; });
}
/** A worker stand-in: answers toolpath requests for ONE plan hash, refuses others. */
function mockClient(cs: PlanChain[], hash: string, log: string[]): RenderClient {
  return {
    planToolpath: async (range: { planHash: string; from: number; to: number }) => {
      log.push(`toolpath ${range.planHash.slice(0, 6)} ${range.from}-${range.to}`);
      if (range.planHash !== hash) throw new Error('stale plan');
      return encodeToolpath(flatOf(cs).slice(range.from, range.to));
    },
    planSvg: async (range: { planHash: string }) => { if (range.planHash !== hash) throw new Error('stale plan'); return '<svg/>'; },
    planGcode: async (range: { planHash: string }) => { if (range.planHash !== hash) throw new Error('stale plan'); return '[]'; },
  } as unknown as RenderClient;
}

describe('Drawing state', () => {
  it('re-resolves the standing request against a new plan and reports counts', async () => {
    const a = chains(10);
    const bufA = encodePlanBuffer(a);
    const hashA = await hashPlan(bufA, settings);
    const log: string[] = [];
    const d = new Drawing(mockClient(a, hashA, log), timing);
    expect(d.selection).toBeNull();
    await d.setPlan({ buffer: bufA, settings, planHash: hashA }, pens);
    expect(d.selection).toMatchObject({ fromChain: 0, toChain: 10 });
    const r = await d.select({ kind: 'progress', from: 0, to: 0.5 });
    expect(r?.selection).toMatchObject({ fromChain: 0, toChain: 5, count: 5 });
    expect(r?.estimate.totalMs).toBeGreaterThan(0);
    expect(r?.fullMs).toBeGreaterThan(r!.estimate.totalMs);
    // the same request on a bigger plan resolves to its own chains
    const b = chains(20);
    const bufB = encodePlanBuffer(b);
    const hashB = await hashPlan(bufB, settings);
    const d2 = new Drawing(mockClient(b, hashB, log), timing);
    d2.request = d.request;
    await d2.setPlan({ buffer: bufB, settings, planHash: hashB }, pens);
    expect(d2.selection).toMatchObject({ fromChain: 0, toChain: 10 });
    // one toolpath per (plan, tolerance): the cache is keyed by hash
    expect(log.filter((l) => l.startsWith(`toolpath ${hashA.slice(0, 6)}`)).length).toBe(1);
    expect(log.filter((l) => l.startsWith(`toolpath ${hashB.slice(0, 6)}`)).length).toBe(1);
    expect(d.range()).toEqual({ planHash: hashA, from: 0, to: 5 });
    expect(await d2.selectedToolpath()).toHaveLength(10);
  });

  it('a chain request beyond the new plan clamps; time and budget requests resolve through the schedule', async () => {
    const a = chains(6);
    const buf = encodePlanBuffer(a);
    const hash = await hashPlan(buf, settings);
    const d = new Drawing(mockClient(a, hash, []), timing);
    d.request = { kind: 'chains', from: 2, to: 50 };
    await d.setPlan({ buffer: buf, settings, planHash: hash }, pens);
    expect(d.selection).toMatchObject({ fromChain: 2, toChain: 6 });
    const full = (await d.select({ kind: 'full' }))!.fullMs;
    const t = await d.select({ kind: 'time', fromMs: 0, toMs: full / 2 });
    expect(t?.selection.count).toBeGreaterThan(0);
    expect(t?.selection.count).toBeLessThan(6);
    expect(t?.effective?.toMs).toBeLessThanOrEqual(full / 2);
    const fit = await d.select({ kind: 'full' }, 1);
    expect(fit?.fit?.selection.count).toBe(0); // 1 ms fits nothing
    expect(d.selection?.count).toBe(0);
    const fit2 = await d.select({ kind: 'full' }, full);
    expect(fit2?.fit?.selection.count).toBe(6);
  });

  it('a verified mismatch refuses the plan; exports of a stale hash are refused by the client', async () => {
    const a = chains(3);
    const buf = encodePlanBuffer(a);
    const hash = await hashPlan(buf, settings);
    const d = new Drawing(mockClient(a, hash, []), timing);
    await expect(d.setPlan({ buffer: buf, settings, planHash: 'nope' }, pens)).rejects.toThrow(/hash mismatch/);
    expect(d.plan).toBeNull();
    await d.setPlan({ buffer: buf, settings, planHash: hash }, pens);
    const other = new Drawing(mockClient(chains(3), 'other', []), timing);
    await other.setPlan({ buffer: buf, settings, planHash: hash }, pens).catch(() => undefined);
    await expect(other.svg(undefined)).rejects.toThrow(/stale plan/);
  });
});

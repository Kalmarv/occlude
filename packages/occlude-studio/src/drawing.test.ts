import { describe, expect, it } from 'vitest';
import { encodePlanBuffer, encodeToolpath, hashPlan, type FlatChain, type PlanChain, type PlanSettings } from 'occlude';
import { Drawing, chainsFingerprint, chainsUnder } from './drawing.js';
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
  it('resolves the sketch\'s request against each new plan and reports counts', async () => {
    const a = chains(10);
    const bufA = encodePlanBuffer(a);
    const hashA = await hashPlan(bufA, settings);
    const log: string[] = [];
    const d = new Drawing(mockClient(a, hashA, log), timing);
    expect(d.selection).toBeNull();
    await d.setPlan({ buffer: bufA, settings, planHash: hashA }, pens, { progress: [0, 0.5] });
    const r = d.current!;
    expect(r.final).toMatchObject({ fromChain: 0, toChain: 5, count: 5 });
    expect(r.estimate!.totalMs).toBeGreaterThan(0);
    expect(r.fullMs!).toBeGreaterThan(r.estimate!.totalMs);
    // the same request on a bigger plan resolves to its own chains
    const b = chains(20);
    const bufB = encodePlanBuffer(b);
    const hashB = await hashPlan(bufB, settings);
    const d2 = new Drawing(mockClient(b, hashB, log), timing);
    await d2.setPlan({ buffer: bufB, settings, planHash: hashB }, pens, { progress: [0, 0.5] });
    expect(d2.selection).toMatchObject({ fromChain: 0, toChain: 10 });
    // one toolpath per (plan, tolerance): the cache is keyed by hash
    expect(log.filter((l) => l.startsWith(`toolpath ${hashA.slice(0, 6)}`)).length).toBe(1);
    expect(log.filter((l) => l.startsWith(`toolpath ${hashB.slice(0, 6)}`)).length).toBe(1);
    expect(d.range()).toEqual({ planHash: hashA, from: 0, to: 5 });
    expect(await d2.selectedToolpath()).toHaveLength(10);
  });

  it('a repair narrows what plots, never widens it, survives a new plan, and clears', async () => {
    const a = chains(10);
    const buf = encodePlanBuffer(a);
    const hash = await hashPlan(buf, settings);
    const d = new Drawing(mockClient(a, hash, []), timing);
    let changes = 0;
    d.onRepairChange(() => { changes += 1; });
    // the sketch draws the first 80%; the repair asks for the last half of the timeline
    await d.setPlan({ buffer: buf, settings, planHash: hash }, pens, { progress: [0, 0.8] });
    const total = d.current!.fullMs! / 60000;
    expect(d.plotSelection).toEqual(d.selection);
    d.setRepair([total / 2, total]);
    expect(changes).toBe(1);
    const p = d.plotSelection!;
    expect(p.fromChain).toBeGreaterThan(0);
    expect(p.toChain).toBe(8); // intersected with the sketch's own range
    expect(p.count).toBe(p.toChain - p.fromChain);
    expect(await d.plotToolpath()).toHaveLength(p.count);
    expect(await d.selectedToolpath()).toHaveLength(8); // exports: the sketch's selection
    expect(d.repairInfo()).toMatchObject({ fromChain: p.fromChain, toChain: 8 });
    // a new plan re-resolves the same minutes
    const b = chains(20);
    const bufB = encodePlanBuffer(b);
    const hashB = await hashPlan(bufB, settings);
    const d2 = new Drawing(mockClient(b, hashB, []), timing);
    d2.setRepair([0, total / 4]);
    await d2.setPlan({ buffer: bufB, settings, planHash: hashB }, pens, {});
    const q = d2.plotSelection!;
    expect(q.fromChain).toBe(0);
    expect(q.toChain).toBeLessThan(20);
    expect(q.toChain).toBeGreaterThan(0);
    d2.setRepair(null);
    expect(d2.plotSelection).toEqual(d2.selection);
    expect(d2.repairInfo()).toBeNull();
  });

  it('a region keeps the chains with ink under a blob; the executed set has a stable fingerprint', async () => {
    const a = chains(10); // chain i runs from (10i, 0) to (10i + 5, 20)
    const buf = encodePlanBuffer(a);
    const hash = await hashPlan(buf, settings);
    const d = new Drawing(mockClient(a, hash, []), timing);
    await d.setPlan({ buffer: buf, settings, planHash: hash }, pens, {});
    expect(d.plotIndices()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // a dab over chain 3's start, and one over the ends of chains 6 and 7
    d.setRegion([{ x: 30, y: 0, r: 2 }, { x: 70, y: 20, r: 6 }]);
    expect(d.plotIndices()).toEqual([3, 6, 7]);
    expect(d.repairing).toBe(true);
    expect((await d.plotToolpath()).map((c) => c.index)).toEqual([3, 6, 7]);
    expect(await d.selectedToolpath()).toHaveLength(10); // exports untouched
    const fp = d.plotFingerprint()!;
    expect(fp.startsWith('3:')).toBe(true);
    expect(chainsFingerprint([3, 6, 7])).toBe(fp);
    expect(chainsFingerprint([3, 6, 8])).not.toBe(fp);
    // the interval and the region both narrow
    const total = d.current!.fullMs! / 60000;
    d.setRepairs([0, total / 2], d.region);
    expect(d.plotIndices()).toEqual([3]);
    d.setRepairs(null, null);
    expect(d.repairing).toBe(false);
    expect(d.plotIndices()).toHaveLength(10);
    // the pure helper, on its own
    expect(chainsUnder(flatOf(a), [{ x: 95, y: 20, r: 1 }], 0, 10)).toEqual([9]);
    expect(chainsUnder(flatOf(a), [{ x: 95, y: 20, r: 1 }], 0, 9)).toEqual([]);
  });

  it('a chain request beyond the plan clamps; minutes and budget resolve through the schedule', async () => {
    const a = chains(6);
    const buf = encodePlanBuffer(a);
    const hash = await hashPlan(buf, settings);
    const d = new Drawing(mockClient(a, hash, []), timing);
    await d.setPlan({ buffer: buf, settings, planHash: hash }, pens, { chains: [2, 50] });
    expect(d.selection).toMatchObject({ fromChain: 2, toChain: 6 });
    await d.setPlan({ buffer: buf, settings, planHash: hash }, pens, {});
    const full = d.current!.fullMs!;
    await d.setPlan({ buffer: buf, settings, planHash: hash }, pens, { minutes: [0, full / 2 / 60_000] });
    const t = d.current!;
    expect(t.final.count).toBeGreaterThan(0);
    expect(t.final.count).toBeLessThan(6);
    expect(t.effective!.toMs).toBeLessThanOrEqual(full / 2);
    await d.setPlan({ buffer: buf, settings, planHash: hash }, pens, { budget: 1 / 60_000 });
    expect(d.current!.fit!.selection.count).toBe(0); // 1 ms fits nothing
    expect(d.selection?.count).toBe(0);
    await d.setPlan({ buffer: buf, settings, planHash: hash }, pens, { budget: full / 60_000 });
    expect(d.current!.fit!.selection.count).toBe(6);
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

describe('no stand-in selection while resolving', () => {
  it('an export asked before resolution waits for the real range instead of taking everything', async () => {
    const a = chains(10);
    const buf = encodePlanBuffer(a);
    const hash = await hashPlan(buf, settings);
    const asked: string[] = [];
    // The toolpath is held open at a gate the test opens, so "the selection
    // is still resolving" is a state this test reaches exactly, not a race
    // against a timer (a sleep-based version failed under load).
    let atToolpath!: () => void;
    const reached = new Promise<void>((r) => { atToolpath = r; });
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    const client = {
      planToolpath: async (range: { planHash: string; from: number; to: number }) => {
        atToolpath();
        await gate;
        return encodeToolpath(flatOf(a).slice(range.from, range.to));
      },
      planSvg: async (range: { planHash: string; from: number; to: number }) => { asked.push(`${range.from}-${range.to}`); return '<svg/>'; },
      planGcode: async (range: { from: number; to: number }) => { asked.push(`g${range.from}-${range.to}`); return '[]'; },
    } as unknown as RenderClient;
    const d = new Drawing(client, timing);
    const landing = d.setPlan({ buffer: buf, settings, planHash: hash }, pens, { chains: [0, 2] });
    await reached;
    // the plan is adopted, the toolpath is in flight: no selection, no
    // range, and no stand-in pretending the range is everything
    expect(d.selection).toBeNull();
    expect(() => d.range()).toThrow(/not resolved/);
    const svg = d.svg(undefined); // waits
    const tp = d.selectedToolpath();
    openGate();
    await landing;
    await svg;
    expect(asked).toEqual(['0-2']);
    expect(await tp).toHaveLength(2);
    await d.gcode('{}');
    expect(asked).toEqual(['0-2', 'g0-2']);
  });
});

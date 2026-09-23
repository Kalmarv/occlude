/**
 * The engine field grid as two stages (docs/architecture.md, "Fields and
 * units"): planning fixes the lattice — bounds, pitch, origin, the read
 * window of a paper-aligned grid — and evaluation samples the callable on
 * exactly that lattice. A windowed grid keeps the FULL grid's origin as
 * its lattice reference, so the kept samples are a subset of the full
 * grid at identical positions.
 */

import { describe, expect, it } from 'vitest';
import { buildFieldGrids, evaluateGrid, paperStep, planGrid, type FieldUse } from '../src/fieldGrid.js';
import { IDENTITY } from '../src/matrix.js';

const paperW = 210;
const paperH = 297;
const unit = 1; // user unit = 1 mm, so the identity is paper → field
const inner = { innerW: paperW, innerH: paperH };

const use = (fn: FieldUse['fn'], over: Partial<FieldUse> = {}): FieldUse => ({
  fn, kind: 'p01', m: IDENTITY, domains: [],
  footprint: { x0: 0, y0: 0, x1: paperW, y1: paperH },
  shapeFp: { x0: 100, y0: 100, x1: 112, y1: 108 },
  aligned: false,
  step: paperStep(over.kind === 'vx' || over.kind === 'vy', paperW, paperH),
  ...over,
});

describe('field grids: planning', () => {
  it('a paper-aligned grid is windowed to where it is read, on the full grid\'s lattice', () => {
    const full = planGrid([use((x) => x, { shapeFp: { x0: 0, y0: 0, x1: paperW, y1: paperH } })], unit);
    const win = planGrid([use((x) => x)], unit);
    expect(win.cell).toBe(full.cell);
    expect(win.x0).toBe(full.x0);
    expect(win.y0).toBe(full.y0);
    expect(win.gw).toBeLessThan(full.gw);
    expect(win.gh).toBeLessThan(full.gh);
    expect(win.gw).toBeGreaterThanOrEqual(4);
    // the declared origin is the first kept sample, by the sampler's own expression
    expect(win.ox).toBe(win.x0 + win.ci0 * win.cell);
    expect(win.oy).toBe(win.y0 + win.cj0 * win.cell);
    expect(win.ci0).toBeGreaterThan(0);
  });

  it('a shape-aligned grid is never windowed and its pitch follows the use\'s scale', () => {
    const half = { a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 };
    const p = planGrid([use((x) => x, { aligned: true, m: half, footprint: { x0: 0, y0: 0, x1: 40, y1: 40 } })], unit);
    expect(p.ci0).toBe(0);
    expect(p.cj0).toBe(0);
    const paperStep = Math.max(0.5, Math.min(2, Math.max(paperW, paperH) / 128));
    expect(p.cell).toBe(paperStep * 0.5);
  });
});

describe('field grids: evaluation', () => {
  it('samples the callable on the planned lattice and writes the engine record', () => {
    const calls: [number, number][] = [];
    const fn = (x: number, y: number) => { calls.push([x, y]); return x / paperW; };
    const plan = planGrid([use(fn)], unit);
    const { first, second } = evaluateGrid(plan, fn, 'p01', false, inner);
    expect(second).toBeNull();
    expect(Array.from(first.subarray(0, 6))).toEqual([plan.gw, plan.gh, plan.ox, plan.oy, plan.cell, plan.cell]);
    expect(calls.length).toBe(plan.gw * plan.gh);
    expect(calls[0]).toEqual([plan.x0 + plan.ci0 * plan.cell, plan.y0 + plan.cj0 * plan.cell]);
    expect(first[6]).toBe(Math.min(1, Math.max(0, calls[0][0] / paperW)));
  });

  it('a vector field fills both components from one evaluation per sample', () => {
    let calls = 0;
    const fn = (x: number, y: number): [number, number] => { calls++; return [x, y]; };
    const plan = planGrid([use(fn, { kind: 'vx' })], unit);
    const { first, second } = evaluateGrid(plan, fn, 'vx', true, inner);
    expect(calls).toBe(plan.gw * plan.gh);
    expect(second).not.toBeNull();
    expect(first[6]).toBe(plan.ox);
    expect(second![6]).toBe(plan.oy);
  });

  it('uses of one field share one grid; a second field gets its own', () => {
    const f = (x: number) => x / paperW;
    const g = (x: number) => 1 - x / paperW;
    const uses = [use(f), use(f, { shapeFp: { x0: 10, y0: 10, x1: 20, y1: 20 } }), use(g)];
    const ids = new Map<object, number>();
    const idOf = (fn: object) => { let id = ids.get(fn); if (id === undefined) ids.set(fn, (id = ids.size)); return id; };
    const data = buildFieldGrids(uses, idOf, unit, inner);
    expect(uses[0].grid).toBe(0);
    expect(uses[1].grid).toBe(0);
    expect(uses[2].grid).toBe(1);
    expect(data.length).toBe(2 * 6 + (data[0] * data[1]) + (data[6 + data[0] * data[1]] * data[7 + data[0] * data[1]]));
  });
});

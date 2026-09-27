/**
 * A row answers `source`, so a value holds the state its `source` rows
 * belong to. A loop written by hand (`m = t.sample(m)` again and again)
 * therefore keeps every state it passed through: each state's rows name
 * rows of the one before. `t.steps` keeps one step of that lookback: the
 * rows its result made answer `source` in the step before, whose rows
 * answer none further back, so the states before that are let go.
 */

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { circle, type Edge, type Material } from '../src/index.js';
import { toolkit } from './helpers/run.js';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** How many states back a row's `source` reaches: from a sample to the edge
 * under it, and from that edge's first point to its own source, until a
 * row answers none. */
function lookback(m: Material): number {
  // A sample of a material lies on one edge: its source is that edge.
  const under = (p: { readonly source?: unknown }) => p.source as Edge | undefined;
  let depth = 0;
  for (let row = under(m.points.at(0)!); row !== undefined; row = under(row.a)) depth++;
  return depth;
}

const STEPS = 20;

describe('a value holds the states its source rows belong to', () => {
  it('a hand loop of t.sample reaches back through every state it passed', async () => {
    const t = toolkit({ aspect: [1, 1] });
    const first = t.sample(circle([50, 50], 20), { count: 32 });
    let m = first;
    for (let i = 0; i < STEPS; i++) m = t.sample(m, { count: 32 });
    expect(lookback(m)).toBe(STEPS);
    // The sample of a shape answers no source, and each state after it
    // names rows of the one before: so the first state a loop makes stays
    // alive for as long as its last state does.
    const early = new WeakRef(t.sample(first, { count: 32 }));
    let held = early.deref()!;
    for (let i = 0; i < STEPS; i++) held = t.sample(held, { count: 32 });
    gc();
    await new Promise((r) => setTimeout(r, 10));
    gc();
    expect(early.deref()).toBeDefined();
    expect(lookback(held)).toBe(STEPS + 1);
  });

  it('t.steps of t.sample keeps one step of lookback, and lets the rest go', async () => {
    const t = toolkit({ aspect: [1, 1] });
    const first = t.sample(circle([50, 50], 20), { count: 32 });
    let early: WeakRef<Material> | undefined;
    const run = t.steps(STEPS, first, (g) => {
      const next = t.sample(g, { count: 32 });
      if (early === undefined) early = new WeakRef(next);
      return next;
    });
    // The last step's samples name the edges of the state before it, and
    // those edges' points answer no source.
    expect(run.points.at(0)!.source).toBeDefined();
    expect(lookback(run)).toBe(1);
    gc();
    await new Promise((r) => setTimeout(r, 10));
    gc();
    expect(early).toBeDefined();
    expect(early!.deref()).toBeUndefined();
  });
});

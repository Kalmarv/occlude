/**
 * `t.sample` reads one open curve row as its selection does: the chain,
 * closed with a chord (promises#17). A ring's row is its ring.
 */
import { describe, expect, it } from 'vitest';
import { curve } from '../src/material.js';
import { toolkit } from './helpers/run.js';

describe('t.sample of a curve row', () => {
  it('an open curve row samples like its selection', () => {
    const t = toolkit();
    const open = curve([[10, 10], [50, 10], [50, 50]]);
    const row = t.sample(open.curves.at(0)!, { count: 10 });
    const sel = t.sample(open.curves, { count: 10 });
    expect(row.points.length).toBe(10);
    expect([...row.points].map((p) => [p.x, p.y])).toEqual([...sel.points].map((p) => [p.x, p.y]));
  });
  it('a ring row samples its ring', () => {
    const t = toolkit();
    const ring = curve([[10, 10], [50, 10], [50, 50]], { closed: true });
    expect(t.sample(ring.curves.at(0)!, { count: 12 }).points.length).toBe(12);
  });
});

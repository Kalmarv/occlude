/**
 * Materials and lattices on persistent columns: a write shares what it
 * does not touch, so a run's states cost what they wrote (a bound on the
 * heap they keep, not a count of the store's leaves — column.test.ts pins
 * the leaves), and a row view is one object per row of a state.
 */

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { curve, material } from '../src/material.js';
import { toolkit } from './helpers/run.js';

const ring = (n: number) => curve(Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI) * 40 + 50, Math.sin((i / n) * 2 * Math.PI) * 40 + 50] as [number, number]), { closed: true });

/** The heap a value keeps alive, in MB: collected before it is made and
 * again after, with the value still held. */
const kept: unknown[] = [];
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const retainedMB = (make: () => unknown): number => {
  gc();
  const before = process.memoryUsage().heapUsed;
  kept.push(make());
  gc();
  const mb = (process.memoryUsage().heapUsed - before) / 1e6;
  kept.length = 0;
  return mb;
};

// A copy of the 64 k-point ring's positions is 1 MB: a few hundred states
// that each copied them would keep hundreds of MB. The bounds below are a
// tenth of that and more; sharing keeps about 1 MB.
const N = 1 << 16;

describe('writes share what they do not touch', () => {
  it('four hundred moves of one point each keep every state for the cost of about one', () => {
    const m = ring(N);
    const states = [m];
    const mb = retainedMB(() => {
      for (let i = 0; i < 400; i++) { const g = states[states.length - 1]; states.push(g.move([1, 0], g.points.at((i * 97) % N))); }
      return states;
    });
    expect(mb).toBeLessThan(40);
    const last = states[400];
    expect(last.points.at(0).x).toBe(m.points.at(0).x + 1);
    expect(last.points.at(1).x).toBe(m.points.at(1).x);
  });

  it('a run that keeps its history keeps each step\'s write, not a copy of the value', () => {
    const t = toolkit({ seed: 3 });
    const start = ring(N).points.set('age', 0);
    let grown = start;
    const mb = retainedMB(() => (grown = t.steps(300, start, (g) => g.points.set('age', (p) => p.age + 1, g.points.at(5)), { every: 1 })));
    expect(mb).toBeLessThan(40);
    expect(grown.history.length).toBeGreaterThan(299);
    expect(grown.points.at(5).age).toBe(300);
    expect(grown.points.at(6).age).toBe(0);
    expect(grown.history[0].points.at(5).age).toBeLessThan(2);
  });

  it('a hundred spends on a 160 000-face lattice keep every state for the cost of about one', () => {
    const t = toolkit({ seed: 1 });
    const first = t.residual((x, y) => 0.5 + 0.25 * Math.sin(x + y), { spacing: 0.25 });
    expect(first.faces.length).toBe(160_000);
    const states = [first];
    const mb = retainedMB(() => {
      for (let i = 0; i < 100; i++) {
        const next = states[states.length - 1].spend([[10 + i * 0.5, 10], [11 + i * 0.5, 10]], { width: 0.4 });
        next.faces.at(0).owed;
        states.push(next);
      }
      return states;
    });
    expect(mb).toBeLessThan(40);
    expect(states[100].faces.sum('owed')).toBeLessThan(first.faces.sum('owed'));
  });
});

describe('a row view is one object per row of a state', () => {
  it('points and edges read twice are the same view, and frozen', () => {
    const m = ring(12).points.set('age', (p) => p.index);
    const p = m.points.at(3);
    expect(m.points.at(3)).toBe(p);
    expect([...m.points][3]).toBe(p);
    expect(m.points.filter((q) => q.age === 3).at(0)).toBe(p);
    expect(m.points.near([p.x, p.y], { radius: 1 }).at(0)).toBe(p);
    const e = m.edges.at(2);
    expect(m.edges.at(2)).toBe(e);
    expect(e.a).toBe(m.points.at(2));
    expect(m.edges.map((x) => x)[2]).toBe(e);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => { (p as { x: number }).x = 1; }).toThrow(TypeError);
    // A spread is still the plain record.
    expect({ ...p }).toEqual({ index: 3, x: p.x, y: p.y, age: 3 });
    // Another state has views of its own.
    expect(m.points.set('age', 0).points.at(3)).not.toBe(p);
    // A curve's points carry its own columns, one view per point there too.
    const c = m.curves.at(0);
    expect(c.points.at(1)).toBe(c.points.at(1));
    expect(typeof c.points.at(1).u).toBe('number');
    expect((m.points.at(1) as Record<string, unknown>).u).toBeUndefined();
  });

  it('a view read before many others is the same view after', () => {
    const m = ring(200);
    const p = m.points.at(3);
    const e = m.edges.at(5);
    // Reading every row moves the state's views from a few to all rows.
    const all = [...m.points];
    const edges = [...m.edges];
    expect(all[3]).toBe(p);
    expect(m.points.at(3)).toBe(p);
    expect(edges[5]).toBe(e);
    expect(m.edges.at(5).a).toBe(m.points.at(5));
  });

  it('a write hands its callback the view a read made of that row', () => {
    const m = ring(12);
    const target = m.points.at(2);
    const hit = m.points.set('hit', (p) => (p === target ? 1 : 0));
    expect(hit.points.map((p) => p.hit).indexOf(1)).toBe(2);
    expect(hit.points.filter((p) => p.hit === 1).length).toBe(1);
    const e = m.edges.at(4);
    const cut = m.split(m.edges, (x) => (x === e ? 0.5 : NaN));
    expect(cut.points.length).toBe(13);
  });

  it('a Voronoi face names its site by the site\'s own view', () => {
    const t = toolkit({ seed: 2 });
    const sites = material([[20, 20], [70, 30], [45, 70], [30, 50]]);
    const cells = t.voronoi(sites);
    for (const site of sites.points) {
      const f = cells.faces.find((g) => g.source === site);
      expect(f, `site ${site.index}`).toBeDefined();
      expect(f!.source.index).toBe(site.index);
    }
  });

  it('a lattice face read twice is the same view', () => {
    const t = toolkit({ seed: 1 });
    const l = t.lattice({ spacing: 10 }, () => 1);
    expect(l.faces.at(4)).toBe(l.faces.at(4));
    expect(l.faces.find((f) => f.index === 4)).toBe(l.faces.at(4));
  });
});

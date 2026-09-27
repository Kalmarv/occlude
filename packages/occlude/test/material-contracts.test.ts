/**
 * The material ownership contract as it stands (docs/architecture.md,
 * "Materials: ownership and identity"). These pin CURRENT behaviour at the
 * boundary a future backend would sit on: what a direct write into a
 * material's typed arrays reaches, and what — prepared earlier — does not.
 * A change here is a behaviour change to explain, not a refactor.
 */

import { describe, expect, it } from 'vitest';
import { curve, material } from '../src/material.js';
import { neighbours } from '../src/forces.js';
import { toolkit } from './helpers/run.js';
import { xy, rec } from './helpers/xy.js';

const square = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });

describe('ownership: derived states share what they did not write', () => {
  it('a derived material shares every column it did not write, and never writes one it holds', () => {
    const m = square();
    const d = m.points.set('a', 1);
    const e = m.edges.add([m.points.at(0), m.points.at(2)]);
    // A column write shares the rest; an edge write shares the points.
    expect(d.store.x).toBe(m.store.x);
    expect(d.store.edgeList).toBe(m.store.edgeList);
    expect(e.store.x).toBe(m.store.x);
    expect(e.store.pointIds).toBe(m.store.pointIds);
    expect(e.store.edgeList).not.toBe(m.store.edgeList);
    // ...and the source reads as it did.
    expect(m.attrNames).toEqual([]);
    expect(Array.from(m.edgeList)).toEqual([0, 1, 1, 2, 2, 3, 3, 0]);
    // The flat arrays are the shared storage, read-only by contract: a
    // direct write reaches every state that shares the column.
    m.x[0] = 100;
    expect(d.x[0]).toBe(100);
  });

  it('t.steps: the result, its snapshots and the input own their columns', () => {
    const m = square().points.set('age', 0);
    const r = toolkit({ seed: 1 }).steps(2, m, (g) => g.move([1, 0]), { every: 1 });
    const snap0 = r.history[0];
    r.x[0] = 500;
    expect(m.x[0]).toBe(0);
    expect(snap0.x[0]).toBe(0);
    expect(r.history[1].x[0]).toBe(1);
    m.x[1] = 700;
    expect(r.x[1]).toBe(12);
  });
});

describe('what a direct write reaches', () => {
  it('views and walks read the columns live', () => {
    const m = square();
    m.x[0] = 100;
    expect(m.vertex(0).x).toBe(100);
    expect(m.edge(0).a.x).toBe(100);
    expect(m.curves.map(rec)[0].pts[0][0]).toBe(100);
    expect(m.points.map(xy)[0][0]).toBe(100);
  });

  it('adjacency is topology only: a coordinate write cannot stale it', () => {
    const m = square();
    expect(m.points.at(0).adjacent.indices).toEqual([1, 3]);
    m.x[0] = 100;
    expect(m.points.at(0).adjacent.indices).toEqual([1, 3]);
  });

  it('the edge index keeps the geometry it was built on', () => {
    const m = square();
    const q = m.edges;
    // The index is built the first time a state is asked, and kept there.
    expect(q.nearest([1, -1], { within: 2 })).not.toBeNull();
    m.x[0] = 100; // the bottom edge now runs 100→10 in the material...
    const hit = q.nearest([1, -1], { within: 2 });
    expect(hit).not.toBeNull();
    expect(hit!.edge.index).toBe(0); // ...but the query still sees it at 0→10
    expect(hit!.distance).toBe(1);
    // the edge VIEW in the result is the state's one view of that row,
    // made on the first read (before the write) and kept
    expect(hit!.edge).toBe(m.edge(0));
    expect(hit!.edge.a.x).toBe(0);
  });

  it('a prepared neighbourhood keeps its buckets but judges distance live', () => {
    const m = material([[0, 0], [1, 0], [50, 50]]);
    const before = neighbours(m, { radius: 3 });
    expect(before([0, 0])).toEqual([0, 1]);
    // a row written AWAY drops out (its live distance is read)...
    m.x[1] = 40;
    expect(before([0, 0])).toEqual([0]);
    // ...but a row written NEAR is never found: it sits in its old bucket
    m.x[2] = 1; m.y[2] = 1;
    expect(before([0, 0])).toEqual([0]);
    expect(neighbours(m, { radius: 3 })([0, 0])).toEqual([0, 2]);
  });

  it('faces are cached per state: computed once, a later write is not seen', () => {
    const m = square();
    const f1 = m.faces;
    const area1 = f1.at(0).area;
    m.x[1] = 20;
    m.x[2] = 20;
    expect(m.faces).toBe(f1);
    expect(f1.at(0).area).toBe(area1);
  });
});

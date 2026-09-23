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
import { query } from '../src/query.js';

const square = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true });

describe('ownership: derived states copy, the public arrays stay writable', () => {
  it('a derived material never shares a column with its source', () => {
    const m = square();
    const d = m.attribute('a', 1);
    const e = m.withEdges([[0, 2]]);
    m.x[0] = 100;
    expect(d.x[0]).toBe(0);
    expect(e.x[0]).toBe(0);
    expect(d.edgeList).not.toBe(m.edgeList);
    // and a derivation made AFTER the write reads the written value
    expect(m.attribute('b', 2).x[0]).toBe(100);
  });

  it('steps: the result, its snapshots and the input own their columns', () => {
    const m = square().attribute('age', 0);
    const r = m.steps(2, (prev, next) => next.move(prev.points, [1, 0]), { every: 1 });
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
    expect(m.curves()[0].pts[0][0]).toBe(100);
    expect(m.pts[0][0]).toBe(100);
  });

  it('adjacency is topology only: a coordinate write cannot stale it', () => {
    const m = square();
    expect(m.points.at(0).adjacent.indices).toEqual([1, 3]);
    m.x[0] = 100;
    expect(m.points.at(0).adjacent.indices).toEqual([1, 3]);
  });

  it('a prepared edge query keeps the geometry it was prepared on', () => {
    const m = square();
    const q = query.edges(m);
    m.x[0] = 100; // the bottom edge now runs 100→10 in the material...
    const hit = q.nearest([1, -1], { within: 2 });
    expect(hit).not.toBeNull();
    expect(hit!.edge.index).toBe(0); // ...but the query still sees it at 0→10
    expect(hit!.distance).toBe(1);
    // the edge VIEW in the result is a live view of the (written) material
    expect(hit!.edge.a.x).toBe(100);
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
    const f1 = m.faces();
    const area1 = f1.at(0).area;
    m.x[1] = 20;
    m.x[2] = 20;
    expect(m.faces()).toBe(f1);
    expect(f1.at(0).area).toBe(area1);
  });
});

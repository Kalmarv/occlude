/**
 * A split or a replace swaps an edge for its pieces in place: the first
 * piece takes the parent's row, the others go after the last row, and
 * every other edge keeps its row. So a state shares every edge leaf the
 * write does not reach, and a run of kept splits costs what it wrote.
 */

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { curve, material } from '../src/material.js';

const ring = (n: number) => curve(Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI) * 40 + 50, Math.sin((i / n) * 2 * Math.PI) * 40 + 50] as [number, number]), { closed: true });

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
/** What a value keeps alive, in MB: the JS heap AND the typed arrays'
 * buffers, which live outside it (a column's leaves are typed arrays).
 * The second collection frees the buffers the first one let go. */
const retainedMB = (make: () => unknown): number => {
  const used = () => { gc(); gc(); const u = process.memoryUsage(); return u.heapUsed + u.arrayBuffers; };
  const before = used();
  const held = make();
  const mb = (used() - before) / 1e6;
  expect(held).toBeDefined();
  return mb;
};

const N = 1 << 16;

describe('a split writes one edge leaf and the last', () => {
  it('shares every leaf of every edge column that no child reaches', () => {
    const m = ring(N).edges.set({ w: (e) => e.index, lab: (e) => `e${e.index % 3}`, v: (e) => [e.index, 1] });
    const s = m.split(m.edges.at(77));
    for (const name of ['edgeList', 'edgeIds', 'edgeRoots'] as const) {
      const a = s.store[name].leaves();
      const b = m.store[name].leaves();
      const shared = a.filter((leaf, k) => leaf === b[k]).length;
      // The parent's leaf and the last are new.
      expect(shared, name).toBe(a.length - 2);
    }
    for (const name of ['w', 'lab', 'v']) {
      const a = s.store.edgeAttrs[name].leaves();
      const b = m.store.edgeAttrs[name].leaves();
      expect(a.filter((leaf, k) => leaf === b[k]).length, name).toBeGreaterThanOrEqual(a.length - 2);
    }
  });

  it('two hundred kept splits of a 64k ring keep every state for the cost of about one', () => {
    const states = [ring(N)];
    const mb = retainedMB(() => {
      for (let i = 0; i < 200; i++) { const g = states[states.length - 1]; states.push(g.split(g.edges.at((i * 131) % g.edges.length))); }
      return states;
    });
    // A state that copied its edge columns would keep 1.5 MB of them; 200
    // such states keep 300 MB. Sharing keeps about 8 MB.
    expect(mb).toBeLessThan(20);
    expect(states[200].edges.length).toBe(N + 200);
  });

  it('two hundred kept replaces of a 16k ring keep every state for the cost of about one', () => {
    // A state that copied its edge columns would keep 0.4 MB of them: 80 MB.
    const motif = curve([[0, 0], [0.5, 0.2], [1, 0]], { closed: false });
    const states = [ring(N / 4)];
    const mb = retainedMB(() => {
      for (let i = 0; i < 200; i++) { const g = states[states.length - 1]; states.push(g.replace(g.edges.at((i * 131) % g.edges.length), motif)); }
      return states;
    });
    expect(mb).toBeLessThan(20);
    expect(states[200].edges.length).toBe(N / 4 + 200);
  });
});

describe('the children and the rows around them', () => {
  const square = () => curve([[0, 0], [10, 0], [10, 10], [0, 10]], { closed: true }).edges.set('len', 10, { transfer: 'distribute' }).edges.set('tag', 'wall');

  it('the first child takes the parent row, the other goes last; every other edge keeps its row', () => {
    const m = square();
    const parent = m.edges.at(1);
    const s = m.split(parent, 0.25);
    expect(s.edges.length).toBe(5);
    const first = s.edges.at(1);
    const second = s.edges.at(4);
    expect([first.a.x, first.a.y, first.b.x, first.b.y]).toEqual([10, 0, 10, 2.5]);
    expect([second.a.x, second.a.y, second.b.x, second.b.y]).toEqual([10, 2.5, 10, 10]);
    for (const k of [0, 2, 3]) expect(s.edges.has(m.edges.at(k)) && s.edges.at(k).id).toBe(m.edges.at(k).id);
    // The parent is retired: its view names nothing, and each child is new
    // with the parent's lineage and the parent as its source.
    expect(s.edges.has(parent)).toBe(false);
    expect(s.edges.rows([parent]).length).toBe(0);
    expect(first.id).not.toBe(parent.id);
    expect(second.id).not.toBe(parent.id);
    expect(first.root).toBe(parent.root);
    expect(second.root).toBe(parent.root);
    expect(first.source).toBe(parent);
    expect(second.source).toBe(parent);
    expect(s.points.at(4).source).toBe(parent);
    // Columns by the policy: a copy on each, a quantity shared by length.
    expect([first.tag, second.tag]).toEqual(['wall', 'wall']);
    expect([first.len, second.len]).toEqual([2.5, 7.5]);
    // The state split was given is as it was.
    expect(m.edges.length).toBe(4);
    expect(m.edges.at(1).id).toBe(parent.id);
  });

  it('a ring keeps its seam and its u where they were', () => {
    const m = square();
    for (const e of [0, 1, 3]) {
      const c = m.split(m.edges.at(e)).curves.at(0);
      expect([c.points.at(0).x, c.points.at(0).y]).toEqual([0, 0]);
      expect(c.points.at(0).u).toBe(0);
      expect(c.length).toBe(40);
    }
  });

  it('a replace puts its first piece in the row, and removes a row none of whose pieces lands', () => {
    const tri = material([[0, 0], [10, 0], [5, 5]], { edges: [[0, 1], [0, 2], [2, 1]] });
    const bump = curve([[0, 0], [0.5, 0.5], [1, 0]], { closed: false });
    // The bump's tip lands on the third point, so both pieces are edges
    // already: the edge goes, and the rows after it move up.
    const welded = tri.replace(tri.edges.at(0), bump);
    expect(welded.edges.length).toBe(2);
    expect(welded.edges.at(0).id).toBe(tri.edges.at(1).id);
    expect(welded.edges.at(1).id).toBe(tri.edges.at(2).id);
    // A bump that lands nowhere: the first piece in the row, the second last.
    const low = curve([[0, 0], [0.5, 0.2], [1, 0]], { closed: false });
    const r = tri.replace(tri.edges.at(0), low);
    expect(r.edges.length).toBe(4);
    expect([r.edges.at(0).a.index, r.edges.at(0).b.index]).toEqual([0, 3]);
    expect([r.edges.at(3).a.index, r.edges.at(3).b.index]).toEqual([3, 1]);
    expect(r.edges.at(1).id).toBe(tri.edges.at(1).id);
    expect(r.edges.at(0).source).toBe(tri.edges.at(0));
    expect(r.edges.at(3).source).toBe(tri.edges.at(0));
  });
});

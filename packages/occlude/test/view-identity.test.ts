/**
 * One view per row of a state, wherever the sketch meets it: a callback's
 * argument (`set`, `move`, a `where`, split's `at`, replace's `flip`), an
 * iteration, a relation and `source` all hand back the same object, in
 * whatever order the rows are first read. The row views are one class for
 * every state (views.ts), so they carry their brand without a prototype
 * per state, and a copy of one is still a plain, unowned record.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { material, curve, type Material, type Vertex, type Edge } from '../src/index.js';
import { initOcclude } from '../src/host.js';
import { ownedBy, ownerOfView, viewKind } from '../src/views.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

/** A cloud of `n` points with a column, and three orders to read it in. */
const cloud = (n: number): Material =>
  material(Array.from({ length: n }, (_, i) => [(i * 37) % 101, (i * 53) % 89] as [number, number]), { w: Array.from({ length: n }, (_, i) => i % 5) });
const orders = (n: number): Record<string, number[]> => ({
  none: [],
  forward: Array.from({ length: n }, (_, i) => i),
  backward: Array.from({ length: n }, (_, i) => n - 1 - i),
  scattered: Array.from({ length: Math.ceil(n / 3) }, (_, k) => (k * 7919) % n),
});

describe('a callback is handed the row view every other read hands back', () => {
  for (const [name, order] of Object.entries(orders(120))) {
    it(`move and set, rows first read ${name}`, () => {
      const m = cloud(120);
      const before = order.map((i) => m.points.at(i));
      const seen: Vertex[] = [];
      m.move((p) => {
        seen.push(p);
        expect(p).toBe(m.points.at(p.index));
        return [0, 0];
      });
      m.points.set('w', (p) => {
        expect(p).toBe(seen[p.index]);
        return p.w;
      });
      m.points.set('w', 1, (p) => p === seen[p.index]);
      expect(seen.length).toBe(120);
      order.forEach((i, k) => expect(before[k]).toBe(seen[i]));
      expect([...m.points].every((p, i) => p === seen[i])).toBe(true);
    });
  }

  it('a move of some rows, and the rows they touch', () => {
    const m = cloud(50);
    const some = m.points.filter((p) => p.index % 3 === 0);
    const seen = new Set<Vertex>();
    m.move((p) => (seen.add(p), [1, 0]), some);
    expect([...seen]).toEqual([...some]);
    expect([...seen].every((p) => p === m.points.at(p.index))).toBe(true);
  });

  it('edges: set, a where, split at and replace flip hand the kept edge, whose ends are the kept points', () => {
    const ring = curve(Array.from({ length: 40 }, (_, i) => [Math.cos(i / 6.4) * 20, Math.sin(i / 6.4) * 20] as [number, number]), { closed: true });
    const first = ring.edges.at(17);
    const seen: Edge[] = [];
    ring.edges.set('k', (e) => (seen.push(e), e.index));
    ring.edges.set('k', 2, (e) => e === seen[e.index]);
    expect(seen[17]).toBe(first);
    for (const e of seen) {
      expect(e).toBe(ring.edges.at(e.index));
      expect(e.a).toBe(ring.points.at(e.a.index));
      expect(e.b).toBe(ring.points.at(e.b.index));
    }
    ring.split(ring.edges, (e) => (expect(e).toBe(seen[e.index]), 0.5));
    const motif = curve([[0, 0], [0.5, 0.2], [1, 0]], { closed: false });
    ring.replace(ring.edges, motif, { flip: (e) => (expect(e).toBe(seen[e.index]), false) });
  });

  it('a row read inside a callback, through a relation, is the view the callback was handed', () => {
    const ring = curve(Array.from({ length: 24 }, (_, i) => [Math.cos(i / 3.8) * 20, Math.sin(i / 3.8) * 20] as [number, number]), { closed: true });
    ring.move((p) => {
      for (const q of p.adjacent) expect(q.adjacent.has(p)).toBe(true);
      expect(p.edges.every((e) => e.a === p || e.b === p)).toBe(true);
      return [0, 0];
    });
  });
});

describe('source names the view a callback holds', () => {
  it('every Voronoi cell is found from its site inside move and set, as in the stippling recipe', () => {
    const t = toolkit({ seed: 4 });
    const g = t.scatter({ spacing: 6 });
    const cells = t.voronoi(g).faces;
    expect(cells.length).toBe(g.points.length);
    let found = 0;
    g.move((p) => {
      if (cells.find((f) => f.source === p) !== undefined) found++;
      return [0, 0];
    });
    expect(found).toBe(g.points.length);
    // A state whose sources were resolved first: set finds them the same.
    const h = g.move([0.5, 0]);
    const cellsOfH = t.voronoi(h).faces;
    const sources = [...cellsOfH].map((f) => f.source);
    let again = 0;
    h.points.set('hit', (p) => (sources.includes(p) ? ++again : 0));
    expect(again).toBe(h.points.length);
  });
});

describe('a row view is a plain record to everything but the library', () => {
  it('keys, spread and JSON see only the columns; the brand stays with the view', () => {
    const m = cloud(3);
    const p = m.points.at(1);
    expect(Object.keys(p)).toEqual(['index', 'x', 'y', 'w']);
    expect(JSON.parse(JSON.stringify(p))).toEqual({ index: 1, x: 37, y: 53, w: 1 });
    const copy = { ...p };
    expect(viewKind(p)).toBe('vertex');
    expect(ownedBy(p, m)).toBe(true);
    expect(viewKind(copy)).toBeUndefined();
    expect(ownerOfView(copy)).toBeUndefined();
    expect(ownerOfView(structuredClone(p))).toBeUndefined();
    expect(Object.isFrozen(p)).toBe(true);
    const e = curve([[0, 0], [1, 0]], { closed: false }).edges.at(0);
    expect(viewKind(e)).toBe('edge');
    expect(Object.isFrozen(e)).toBe(true);
  });

  it('two states with the same columns share nothing but the class: each view names its own state', () => {
    const a = cloud(4);
    const b = a.move([1, 0]);
    expect(ownedBy(a.points.at(0), a)).toBe(true);
    expect(ownedBy(b.points.at(0), a)).toBe(false);
    expect(a.points.at(0)).not.toBe(b.points.at(0));
    expect(Object.getPrototypeOf(a.points.at(0))).toBe(Object.getPrototypeOf(b.points.at(0)));
  });
});

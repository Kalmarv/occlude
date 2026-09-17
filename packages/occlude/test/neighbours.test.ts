import { describe, expect, it } from 'vitest';
import { connect, material, type Material } from '../src/index.js';

const cloud = (n: number, seed = 1) => {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return material(Array.from({ length: n }, () => [rnd() * 200, rnd() * 100] as [number, number]));
};
const edgeSet = (m: Material) => {
  const out = new Set<string>();
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    out.add(a < b ? `${a}-${b}` : `${b}-${a}`);
  }
  return out;
};
const components = (m: Material) => {
  const seen = new Int32Array(m.n).fill(-1);
  let c = 0;
  for (let v = 0; v < m.n; v++) {
    if (seen[v] !== -1) continue;
    const st = [v];
    seen[v] = c;
    while (st.length) for (const w of m.connected(st.pop()!)) if (seen[w] === -1) { seen[w] = c; st.push(w); }
    c++;
  }
  return c;
};

describe('connect.neighbours', () => {
  it('more room is never more edges, and never an edge Delaunay did not have', () => {
    const pts = cloud(160);
    const delaunay = edgeSet(connect.triangulate(pts));
    let previous = Infinity;
    for (const room of [1, 1.3, 1.7, 2, 2.6, 3.5, 6]) {
      const g = connect.neighbours(pts, { room });
      expect(g.edgeCount).toBeLessThanOrEqual(previous);
      previous = g.edgeCount;
      for (const e of edgeSet(g)) expect(delaunay.has(e)).toBe(true);
    }
    // The knob really does something across that range.
    expect(connect.neighbours(pts, { room: 6 }).edgeCount).toBeLessThan(connect.neighbours(pts, { room: 1 }).edgeCount / 2);
  });

  it('up to room 2 it holds the spanning tree, and past 2 it stops doing so', () => {
    const pts = cloud(140, 5);
    const tree = edgeSet(connect.tree(pts));
    // The classical guarantee: every minimum-spanning-tree edge survives.
    for (const room of [1, 1.5, 2]) {
      const g = edgeSet(connect.neighbours(pts, { room }));
      for (const e of tree) expect(g.has(e)).toBe(true);
      expect(components(connect.neighbours(pts, { room }))).toBe(1);
    }
    // Past 2 the lune is big enough to veto edges the tree needed, so the
    // lattice comes apart — which is a real property, not a bug.
    expect(connect.neighbours(pts, { room: 5 }).edgeCount).toBeLessThan(tree.size);
    expect(components(connect.neighbours(pts, { room: 5 }))).toBeGreaterThan(1);
  });

  it('room 1 and room 2 are the two classical answers, checkable by hand', () => {
    // a and b ten apart, c six above their midpoint. The disc having ab as its
    // diameter has radius 5 and does not reach c, so ab survives at room 1.
    // At room 2 the region is the two discs of radius 10 centred on a and b,
    // and c is inside both — so ab goes.
    const pts = material([[0, 0], [10, 0], [5, 6]]);
    expect(edgeSet(connect.neighbours(pts, { room: 1 })).has('0-1')).toBe(true);
    expect(edgeSet(connect.neighbours(pts, { room: 2 })).has('0-1')).toBe(false);
    // The other two edges are there either way: nothing sits between them.
    for (const room of [1, 2]) {
      const g = edgeSet(connect.neighbours(pts, { room }));
      expect(g.has('0-2')).toBe(true);
      expect(g.has('1-2')).toBe(true);
    }
  });

  it('is deterministic, and refuses what it cannot use', () => {
    const pts = cloud(90, 3);
    expect(Array.from(connect.neighbours(pts, { room: 1.6 }).edgeList))
      .toEqual(Array.from(connect.neighbours(pts, { room: 1.6 }).edgeList));
    // Rows are untouched: the lattice is in the edges.
    expect(Array.from(connect.neighbours(pts, {}).x)).toEqual(Array.from(pts.x));
    expect(() => connect.neighbours(pts, { room: 0.5 })).toThrow(/must be at least 1/);
    expect(() => connect.neighbours(pts, { room: () => 0.4 })).toThrow(/must be at least 1 everywhere/);
    expect(() => connect.neighbours(pts, { room: 'wide' as never })).toThrow(/must be a number, or a field/);
    // A field of room: tight on the left, loose on the right, so the lattice
    // is denser on the left than a single value could make it everywhere.
    const graded = connect.neighbours(pts, { room: (x) => 1 + (x / 200) * 2.5 });
    const leftOf = (m: Material, side: (x: number) => boolean) => {
      let n = 0;
      for (let e = 0; e < m.edgeCount; e++) if (side((m.x[m.edgeList[2 * e]] + m.x[m.edgeList[2 * e + 1]]) / 2)) n++;
      return n;
    };
    expect(leftOf(graded, (x) => x < 100)).toBeGreaterThan(leftOf(graded, (x) => x >= 100));
    expect(() => connect.neighbours(pts, { room: 0 })).toThrow(/must be at least 1/);
    // Too few rows to join is not an error.
    expect(connect.neighbours(material([]), {}).edgeCount).toBe(0);
    expect(connect.neighbours(material([[1, 1]]), {}).edgeCount).toBe(0);
    expect(connect.neighbours(material([[0, 0], [9, 0]]), {}).edgeCount).toBe(1);
    // Collinear rows have no triangulation either, and come back as the chain
    // along the line, which is what "nothing between them" means there.
    const line = material(Array.from({ length: 6 }, (_, k) => [k * 5, 20] as [number, number]));
    expect(connect.neighbours(line, { room: 1 }).edgeCount).toBe(5);
  });
});

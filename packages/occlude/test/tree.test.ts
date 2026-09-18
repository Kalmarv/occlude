import { describe, expect, it } from 'vitest';
import { connect, material, type Material } from '../src/index.js';

const len = (m: Material) => {
  let s = 0;
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    s += Math.hypot(m.x[a] - m.x[b], m.y[a] - m.y[b]);
  }
  return s;
};
const cloud = (n: number, seed = 1) => {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return material(Array.from({ length: n }, () => [rnd() * 200, rnd() * 100] as [number, number]));
};
/** One component and no cycle is exactly a spanning tree. */
const components = (m: Material) => {
  const seen = new Int32Array(m.n).fill(-1);
  let c = 0;
  for (let v = 0; v < m.n; v++) {
    if (seen[v] !== -1) continue;
    const stack = [v];
    seen[v] = c;
    while (stack.length) for (const w of m.connected(stack.pop()!)) if (seen[w] === -1) { seen[w] = c; stack.push(w); }
    c++;
  }
  return c;
};

describe('connect.tree', () => {
  it('reaches every row exactly once over, with no cycle anywhere', () => {
    const pts = cloud(200);
    const t = connect.tree(pts);
    // n - 1 edges and one component is a spanning tree; with n - 1 edges,
    // connected and acyclic are the same statement.
    expect(t.edgeCount).toBe(199);
    expect(components(t)).toBe(1);
    expect(t.faces().length).toBe(0); // a tree encloses nothing
    // Rows are untouched: the tree is in the edges.
    expect(Array.from(t.x)).toEqual(Array.from(pts.x));
    // It is the cheapest such tree, so it is shorter than any other spanning
    // structure over the same points.
    expect(len(t)).toBeLessThan(len(connect.chain(pts)));
    expect(len(t)).toBeLessThan(len(connect.tour(pts)));
  });

  it('is the true Euclidean minimum over a set small enough to check by hand', () => {
    // Four corners of a rectangle: the minimum spanning tree takes the three
    // short sides, never a diagonal.
    const box = material([[0, 0], [10, 0], [10, 4], [0, 4]]);
    const t = connect.tree(box);
    expect(len(t)).toBeCloseTo(4 + 10 + 4, 9);
    // Brute force against every spanning tree of a random six-point set.
    const six = cloud(6, 5);
    const all: number[][] = [];
    const edges: [number, number][] = [];
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) edges.push([i, j]);
    const d = (a: number, b: number) => Math.hypot(six.x[a] - six.x[b], six.y[a] - six.y[b]);
    // every 5-subset of the 15 edges that spans
    const pick = (start: number, chosen: number[]) => {
      if (chosen.length === 5) { all.push([...chosen]); return; }
      for (let k = start; k < edges.length; k++) { chosen.push(k); pick(k + 1, chosen); chosen.pop(); }
    };
    pick(0, []);
    let best = Infinity;
    for (const set of all) {
      const parent = [0, 1, 2, 3, 4, 5];
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      let ok = true;
      let total = 0;
      for (const k of set) {
        const [a, b] = edges[k];
        const ra = find(a); const rb = find(b);
        if (ra === rb) { ok = false; break; }
        parent[Math.max(ra, rb)] = Math.min(ra, rb);
        total += d(a, b);
      }
      if (ok) best = Math.min(best, total);
    }
    expect(len(connect.tree(six))).toBeCloseTo(best, 9);
  });

  it('spans the degenerate sets too, where there is no triangulation to draw on', () => {
    // Collinear: no Delaunay edges exist at all, and the tree is the chain.
    const line = material(Array.from({ length: 12 }, (_, k) => [k * 5, 40] as [number, number]));
    const t = connect.tree(line);
    expect(t.edgeCount).toBe(11);
    expect(components(t)).toBe(1);
    expect(len(t)).toBeCloseTo(55, 9);
    // Coincident rows are rows: Delaunay keeps the first at a position, and
    // the rest are joined to it so the tree still reaches them.
    const doubled = material([[0, 0], [0, 0], [10, 0], [10, 0], [5, 8]]);
    const dt = connect.tree(doubled);
    expect(dt.edgeCount).toBe(4);
    expect(components(dt)).toBe(1);
    // Too few rows to connect is not an error.
    expect(connect.tree(material([])).edgeCount).toBe(0);
    expect(connect.tree(material([[1, 1]])).edgeCount).toBe(0);
    expect(connect.tree(material([[1, 1], [4, 5]])).edgeCount).toBe(1);
  });

  it('takes a cost, and refuses one it cannot use', () => {
    const pts = cloud(120, 3);
    const plain = connect.tree(pts);
    // Travel along x made cheap than travel along y: the tree grows sideways.
    const flat = connect.tree(pts, { cost: (a, b) => Math.hypot(a.x - b.x, (a.y - b.y) * 6) });
    expect(Array.from(flat.edgeList)).not.toEqual(Array.from(plain.edgeList));
    const spread = (m: Material) => {
      let dx = 0; let dy = 0;
      for (let e = 0; e < m.edgeCount; e++) {
        const a = m.edgeList[2 * e]; const b = m.edgeList[2 * e + 1];
        dx += Math.abs(m.x[a] - m.x[b]); dy += Math.abs(m.y[a] - m.y[b]);
      }
      return dx / dy;
    };
    expect(spread(flat)).toBeGreaterThan(spread(plain));
    expect(components(flat)).toBe(1);
    // Deterministic.
    expect(Array.from(connect.tree(pts).edgeList)).toEqual(Array.from(connect.tree(pts).edgeList));
    expect(() => connect.tree(pts, { cost: 2 as never })).toThrow(/must be a function/);
    // A cost with no number on it is an infinitely expensive link: the tree
    // still spans, through the neighbours it can price.
    expect(connect.tree(pts, { cost: () => NaN }).edgeCount).toBe(connect.tree(pts).edgeCount);
    expect(() => connect.tree(pts, { cost: (() => 'far') as never })).toThrow(/must be a function|must be a number/);
  });
});

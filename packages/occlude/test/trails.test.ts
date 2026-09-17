import { describe, expect, it } from 'vitest';
import { connect, curve, material, type Material } from '../src/index.js';

const grid = (C: number, R: number, S = 10) => {
  const pts: [number, number][] = [];
  for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) pts.push([i * S, j * S]);
  const edges: [number, number][] = [];
  for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) {
    if (i + 1 < C) edges.push([j * C + i, j * C + i + 1]);
    if (j + 1 < R) edges.push([j * C + i, (j + 1) * C + i]);
  }
  return material(pts).withEdges(edges);
};
const oddCount = (m: Material) => {
  const d = new Int32Array(m.n);
  for (let e = 0; e < m.edgeCount; e++) { d[m.edgeList[2 * e]]++; d[m.edgeList[2 * e + 1]]++; }
  return [...d].filter((v) => v % 2 === 1).length;
};
/** Every edge as a canonical geometric key, so the two materials can be
 * compared without caring which rows they are stored against. */
const inkOf = (m: Material) => {
  const out: string[] = [];
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    const p = `${m.x[a]},${m.y[a]}`;
    const q = `${m.x[b]},${m.y[b]}`;
    out.push(p < q ? `${p}|${q}` : `${q}|${p}`);
  }
  return out.sort();
};
const components = (m: Material) => {
  const seen = new Int32Array(m.n).fill(-1);
  let c = 0;
  for (let v = 0; v < m.n; v++) {
    if (seen[v] !== -1 || m.connected(v).length === 0) continue;
    const st = [v];
    seen[v] = c;
    while (st.length) for (const w of m.connected(st.pop()!)) if (seen[w] === -1) { seen[w] = c; st.push(w); }
    c++;
  }
  return c;
};

describe('connect.trails', () => {
  it('reaches the fewest pen-down runs there can be, and draws no edge twice', () => {
    // Every trail has two ends and only an odd-degree vertex can be one, so
    // `odd / 2` is a floor nothing can beat without retracing.
    for (const [C, R] of [[9, 6], [4, 4], [12, 3]] as [number, number][]) {
      const g = grid(C, R);
      const t = connect.trails(g);
      expect(t.curves().length).toBe(Math.max(1, oddCount(g) / 2));
      // The same ink, edge for edge: nothing added, nothing dropped, nothing
      // drawn twice.
      expect(inkOf(t)).toEqual(inkOf(g));
      expect(t.edgeCount).toBe(g.edgeCount);
    }
    // And it is a real improvement on the chain walk, which breaks at junctions.
    const g = grid(9, 6);
    expect(connect.trails(g).curves().length).toBeLessThan(g.curves().length / 5);
  });

  it('a network with no odd vertex is one closed loop', () => {
    // A figure of eight: two loops sharing ONE vertex, which is therefore
    // degree 4 while every other vertex is degree 2.
    const eight = material([[0, 0], [10, 0], [10, 10], [0, 10], [20, 10], [20, 20], [10, 20]])
      .withEdges([[0, 1], [1, 2], [2, 3], [3, 0], [2, 4], [4, 5], [5, 6], [6, 2]]);
    expect(oddCount(eight)).toBe(0);
    const t = connect.trails(eight);
    expect(t.curves().length).toBe(1);
    expect(t.curves()[0].closed).toBe(true);
    expect(inkOf(t)).toEqual(inkOf(eight));
    // The degree-4 vertex became two rows the pen passes through separately.
    expect(t.n).toBeGreaterThan(eight.n);
  });

  it('counts each component on its own, and leaves isolated rows out', () => {
    const two = connect.trails(grid(3, 3).withEdges([[0, 1], [1, 2], [3, 4], [4, 5]]));
    expect(components(two)).toBe(2);
    expect(two.curves().length).toBe(2);
    // A lone point is in no trail, exactly as the chain walk leaves it out.
    const lonely = material([[0, 0], [5, 0], [50, 50]]).withEdges([[0, 1]]);
    const t = connect.trails(lonely);
    expect(t.curves().length).toBe(1);
    expect(t.edgeCount).toBe(1);
    // Nothing to route is not an error.
    expect(connect.trails(material([[1, 1], [2, 2]])).edgeCount).toBe(0);
    expect(connect.trails(material([])).edgeCount).toBe(0);
  });

  it('carries the columns, and is deterministic', () => {
    const ring = connect.ring(material([[0, 0], [10, 0], [10, 10], [0, 10]], { weight: 3 }));
    const t = connect.trails(ring);
    expect(Object.keys(t.attrs)).toEqual(['weight']);
    expect([...t.attrs.weight].every((v) => v === 3)).toBe(true);
    const a = connect.trails(grid(7, 5));
    const b = connect.trails(grid(7, 5));
    expect(Array.from(a.edgeList)).toEqual(Array.from(b.edgeList));
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    // A chain that was already one run stays one run and keeps its shape.
    const open = curve([[0, 0], [5, 1], [10, 0], [15, 2]]);
    expect(connect.trails(open).curves().length).toBe(1);
    expect(inkOf(connect.trails(open))).toEqual(inkOf(open));
  });
});

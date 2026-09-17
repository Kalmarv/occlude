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
/** A deterministic scatter that needs no toolkit. */
const cloud = (n: number, seed = 1) => {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return material(Array.from({ length: n }, () => [rnd() * 200, rnd() * 100] as [number, number]));
};
const degrees = (m: Material) => {
  const d = new Int32Array(m.n);
  for (let e = 0; e < m.edgeCount; e++) { d[m.edgeList[2 * e]]++; d[m.edgeList[2 * e + 1]]++; }
  return d;
};

describe('connect.tour', () => {
  it('visits every row once, leaves the rows alone, and is far shorter than the order it was given', () => {
    const pts = cloud(160);
    const open = connect.tour(pts);
    expect(open.n).toBe(160);
    expect(open.edgeCount).toBe(159);
    // Rows are untouched: the route is in the edges.
    expect(Array.from(open.x)).toEqual(Array.from(pts.x));
    // A path: two ends of degree 1, everything else degree 2, nothing isolated.
    const d = degrees(open);
    expect([...d].filter((v) => v === 1).length).toBe(2);
    expect([...d].filter((v) => v === 2).length).toBe(158);
    // And it is worth doing.
    expect(len(open)).toBeLessThan(len(connect.chain(pts)) / 4);
    // Closed returns to the start: one more edge, every row degree 2.
    const ring = connect.tour(pts, { closed: true });
    expect(ring.edgeCount).toBe(160);
    expect([...degrees(ring)].every((v) => v === 2)).toBe(true);
    expect(len(ring)).toBeGreaterThan(len(open));
  });

  it('terminates: an exchange between adjacent edges is not a move', () => {
    // Two edges that share a vertex cancel in exact arithmetic, but evaluated
    // left to right they leave a rounding residue that reads as a positive
    // gain — while reversing one element changes nothing. Accepting that
    // "improvement" loops forever. Any ordinary cloud reaches the case at
    // once, so simply finishing is the assertion.
    for (const n of [3, 4, 5, 12, 25, 90]) {
      const m = connect.tour(cloud(n, n));
      expect(m.edgeCount).toBe(Math.max(0, n - 1));
    }
    // Collinear and coincident rows are the sharpest version of it.
    const line = material(Array.from({ length: 30 }, (_, k) => [k * 3, 50] as [number, number]));
    expect(connect.tour(line).edgeCount).toBe(29);
    const stacked = material(Array.from({ length: 20 }, () => [40, 40] as [number, number]));
    expect(connect.tour(stacked).edgeCount).toBe(19);
  });

  it('the cost is the whole point: a different cost makes a different route', () => {
    const pts = cloud(120, 7);
    const plain = connect.tour(pts);
    // A cost that would rather travel over the left half of the page than the
    // right, whatever the distance.
    const biased = connect.tour(pts, { cost: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * (1 + ((a.x + b.x) / 2 > 100 ? 4 : 0)) });
    expect(Array.from(biased.edgeList)).not.toEqual(Array.from(plain.edgeList));
    // Under its own cost the biased route is the cheaper of the two.
    const spend = (m: Material) => {
      let s = 0;
      for (let e = 0; e < m.edgeCount; e++) {
        const a = m.edgeList[2 * e];
        const b = m.edgeList[2 * e + 1];
        s += Math.hypot(m.x[a] - m.x[b], m.y[a] - m.y[b]) * (1 + ((m.x[a] + m.x[b]) / 2 > 100 ? 4 : 0));
      }
      return s;
    };
    expect(spend(biased)).toBeLessThan(spend(plain));
    // Columns are readable from the views the cost is handed.
    const tagged = material(Array.from({ length: 40 }, (_, k) => ({ x: (k % 8) * 24 + 8, y: Math.floor(k / 8) * 22 + 8, side: k % 2 })));
    const grouped = connect.tour(tagged, { cost: (a, b) => Math.hypot(a.x - b.x, a.y - b.y) + (a.side === b.side ? 0 : 400) });
    let crossings = 0;
    for (let e = 0; e < grouped.edgeCount; e++) {
      if (grouped.attrs.side[grouped.edgeList[2 * e]] !== grouped.attrs.side[grouped.edgeList[2 * e + 1]]) crossings++;
    }
    expect(crossings).toBeLessThan(4); // one handover, not forty
  });

  it('a cost unrelated to distance finishes: the scan continues, it does not restart', () => {
    // Asked to sort by a column, the route wants very many exchanges. Taking
    // the first improvement at each position and moving on keeps a pass linear
    // in the neighbourhood; restarting the scan after every exchange does not
    // finish at all. Completing IS the assertion.
    let s = 7;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows = Array.from({ length: 150 }, () => ({ x: rnd() * 200, y: rnd() * 100, shade: rnd() }));
    const sorted = connect.tour(material(rows), { cost: (a, b) => Math.abs(a.shade - b.shade) });
    expect(sorted.edgeCount).toBe(149);
    // It really did sort: consecutive shades along the route are close, where
    // in the order they were made they are not. Only partly, though — the
    // candidate neighbours are chosen by DISTANCE, so a cost with no
    // geometric meaning is improved only among geometric neighbours.
    const step = (m: Material) => {
      let acc = 0;
      for (let e = 0; e < m.edgeCount; e++) acc += Math.abs(m.attrs.shade[m.edgeList[2 * e]] - m.attrs.shade[m.edgeList[2 * e + 1]]);
      return acc / m.edgeCount;
    };
    expect(step(sorted)).toBeLessThan(step(connect.chain(material(rows))) / 4);
  });

  it('is deterministic, and refuses what it cannot use', () => {
    const pts = cloud(60, 3);
    expect(Array.from(connect.tour(pts).edgeList)).toEqual(Array.from(connect.tour(pts).edgeList));
    const c = (a: { x: number }, b: { x: number }) => Math.abs(a.x - b.x);
    expect(Array.from(connect.tour(pts, { cost: c as never }).edgeList)).toEqual(Array.from(connect.tour(pts, { cost: c as never }).edgeList));
    expect(() => connect.tour(pts, { candidates: 1 })).toThrow(/at least 2/);
    expect(() => connect.tour(pts, { candidates: 2.5 })).toThrow(/whole number/);
    expect(() => connect.tour(pts, { cost: 3 as never })).toThrow(/must be a function/);
    expect(() => connect.tour(pts, { cost: () => NaN })).toThrow(/must be a number/);
    // Too few rows to route is not an error.
    expect(connect.tour(material([])).edgeCount).toBe(0);
    expect(connect.tour(material([[1, 1]])).edgeCount).toBe(0);
    expect(connect.tour(material([[1, 1], [9, 9]])).edgeCount).toBe(1);
  });
});

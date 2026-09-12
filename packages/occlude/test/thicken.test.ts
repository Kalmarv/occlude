import { describe, expect, it } from 'vitest';
import {
  distanceTo, material, curve, thicken, polygon, strokes, numericLoops,
  sketch, compileSketch, setPaperHint, append,
  type Material, type Vertex,
} from '../src/index.js';

import { exactEnvelopeOracle } from './helpers/envelope-oracle.js';

// ---- helpers ---------------------------------------------------------------------

/** Independent membership oracle: does `(x, y)` lie in the union of the
 * variable-radius disc envelopes? `F(t)` is the squared distance to the
 * moving centre minus the moving radius squared; coverage exists exactly
 * when its minimum over the edge is non-positive. A vertex-only
 * contribution is an edge of zero length. */
function insideEnvelope(ax: number, ay: number, bx: number, by: number, ra: number, rb: number, x: number, y: number): boolean {
  const qx = x - ax;
  const qy = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const dr = rb - ra;
  const A = dx * dx + dy * dy - dr * dr;
  const B = -2 * ((qx * dx + qy * dy) + ra * dr);
  const C = qx * qx + qy * qy - ra * ra;
  const f = (t: number) => A * t * t + B * t + C;
  let best = Math.min(f(0), f(1));
  if (A > 0) best = Math.min(best, f(Math.min(1, Math.max(0, -B / (2 * A)))));
  return best <= 0;
}

type Envelope = [number, number, number, number, number, number];

/** Membership of a point in a union of envelopes, positive inside. */
function oracle(shapes: readonly Envelope[]) {
  return (x: number, y: number): boolean => shapes.some((e) => insideEnvelope(e[0], e[1], e[2], e[3], e[4], e[5], x, y));
}

interface Loop {
  pts: [number, number][];
  area: number;
}

function loopsOf(m: Material): Loop[] {
  const out: Loop[] = [];
  for (const c of m.curves()) {
    if (!c.closed) continue;
    const pts = c.indices.map((i) => [m.x[i], m.y[i]] as [number, number]);
    let a = 0;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const q = pts[(k + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    out.push({ pts, area: a / 2 });
  }
  return out;
}

const totalArea = (m: Material) => loopsOf(m).reduce((s, l) => s + Math.abs(l.area), 0);

function bounds(m: Material): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < m.n; i++) {
    minX = Math.min(minX, m.x[i]); maxX = Math.max(maxX, m.x[i]);
    minY = Math.min(minY, m.y[i]); maxY = Math.max(maxY, m.y[i]);
  }
  return { minX, minY, maxX, maxY };
}

const edgeMaterial = (a: [number, number], b: [number, number], ra: number, rb: number) =>
  material([a, b], { edges: [[0, 1]], radius: [ra, rb] });

const radiusOf = (p: Vertex) => p.radius;

// ---- geometry and topology -------------------------------------------------------

describe('thicken: geometry and topology', () => {
  it('empty material and empty selections are valid empty material', () => {
    const empty = thicken(material([]), { radius: 2 });
    expect(empty.n).toBe(0);
    expect(empty.edgeCount).toBe(0);
    expect(empty.attrNames).toEqual([]);
    const sel = material([[0, 0]]).points.filter(() => false);
    const viaSel = thicken(sel, { radius: 2 });
    expect(viaSel.n).toBe(0);
    const esel = material([[0, 0], [1, 0]], { edges: [[0, 1]] }).edges.filter(() => false);
    expect(thicken(esel, { radius: 2 }).n).toBe(0);
  });

  it('one vertex is a closed disc within tolerance, and tiny radii survive', () => {
    const disc = thicken(material([[0, 0]]), { radius: 5 });
    const loops = loopsOf(disc);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeGreaterThan(Math.PI * 25 * 0.985);
    // Every vertex sits within tolerance of the true circle.
    for (const [x, y] of loops[0].pts) expect(Math.abs(Math.hypot(x, y) - 5)).toBeLessThanOrEqual(0.05);

    const tiny = thicken(material([[0, 0]]), { radius: 0.004, tolerance: 10 });
    expect(loopsOf(tiny)).toHaveLength(1);
    expect(loopsOf(tiny)[0].pts.length).toBeGreaterThanOrEqual(3);
    expect(totalArea(tiny)).toBeGreaterThan(0);
  });

  it('a constant-radius edge is a capsule of the expected extent and area', () => {
    const m = thicken(edgeMaterial([0, 0], [10, 0], 1, 1), { radius: radiusOf, tolerance: 0.01 });
    const b = bounds(m);
    expect(b.minX).toBeCloseTo(-1, 2);
    expect(b.maxX).toBeCloseTo(11, 2);
    expect(b.minY).toBeCloseTo(-1, 2);
    expect(b.maxY).toBeCloseTo(1, 2);
    expect(totalArea(m)).toBeCloseTo(2 * 1 * 10 + Math.PI, 1);
    const coarse = thicken(edgeMaterial([0, 0], [10, 0], 1, 1), { radius: radiusOf, tolerance: 1 });
    expect(Math.abs(totalArea(coarse) - (20 + Math.PI))).toBeGreaterThan(Math.abs(totalArea(m) - (20 + Math.PI)));
  });

  it('variable radius agrees with the independent oracle', () => {
    const cases: [number, number, number][] = [
      [2, 3, 10], // abs(dr) < L
      [3, 3, 10], // constant
      [10, 2, 10], // abs(dr) = L, internal tangency
      [10, 1, 2], // abs(dr) > L, containment
      [3, 0, 10], // zero-radius tapered tip
    ];
    for (const [ra, rb, L] of cases) {
      const body = thicken(edgeMaterial([0, 0], [L, 0], ra, rb), { radius: radiusOf, tolerance: 0.01 });
      const covers = oracle([[0, 0, L, 0, ra, rb]]);
      const d = distanceTo(body);
      // Points safely away from the analytic boundary: the sign agrees.
      for (let x = -ra - 1; x <= L + rb + 1; x += 0.37) {
        for (let y = -Math.max(ra, rb) - 1; y <= Math.max(ra, rb) + 1; y += 0.31) {
          if (Math.abs(d(x, y)) < 0.06) continue;
          expect(d(x, y) > 0, `(${x}, ${y}) ra=${ra} rb=${rb} L=${L}`).toBe(covers(x, y));
        }
      }
    }
  });

  it('distinct coincident vertices and zero-length edges reduce to discs', () => {
    const m = material([[0, 0], [0, 0], [10, 0]], { edges: [[0, 1], [1, 2]], radius: 1 });
    const body = thicken(m, { radius: radiusOf });
    expect(loopsOf(body)).toHaveLength(1);
    const d = distanceTo(body);
    expect(d(0, 0)).toBeGreaterThan(0);
    expect(d(10, 0)).toBeGreaterThan(0);
    expect(d(20, 0)).toBeLessThan(0);
    // The zero-length edge's disc does not add a second boundary.
    expect(loopsOf(body)[0].area).toBeLessThan(2 * 10 + Math.PI + 1);
  });

  it('a Y network is one connected region with no internal seams', () => {
    const tree = material([[0, 0], [10, 0], [0, 10], [-10, 0]], { edges: [[0, 1], [0, 2], [0, 3]] });
    const body = thicken(tree, { radius: 1 });
    const loops = loopsOf(body);
    expect(loops).toHaveLength(1);
    expect(loops[0].area).toBeGreaterThan(0);
    // The junction is solid: no seam boundary runs through it.
    const d = distanceTo(body);
    expect(d(0, 0)).toBeGreaterThan(0.9);
    expect(d(5, 0)).toBeGreaterThan(0.9);
    expect(d(0, 5)).toBeGreaterThan(0.9);
    // Outside the three arms.
    expect(d(5, 5)).toBeLessThan(0);
  });

  it('an acute fork, a reversal and unequal branch widths still close', () => {
    const acute = material([[0, 0], [10, 0.5], [10, -0.5]], { edges: [[0, 1], [0, 2]] });
    expect(loopsOf(thicken(acute, { radius: 1 }))).toHaveLength(1);
    const reversal = material([[0, 0], [10, 0], [0, 0.6]], { edges: [[0, 1], [1, 2]] });
    expect(loopsOf(thicken(reversal, { radius: 0.5 }))).toHaveLength(1);
    const unequal = material([[0, 0], [10, 0], [0, 10]], { edges: [[0, 1], [0, 2]], radius: [0.5, 2, 2] });
    expect(loopsOf(thicken(unequal, { radius: radiusOf }))).toHaveLength(1);
  });

  it('a closed square chain keeps its hole until the analytically expected thickness', () => {
    const square = curve([[0, 0], [20, 0], [20, 20], [0, 20]], { closed: true });
    const thin = thicken(square, { radius: 1 });
    const thinLoops = loopsOf(thin);
    expect(thinLoops).toHaveLength(2);
    expect(thinLoops.filter((l) => l.area < 0)).toHaveLength(1);
    expect(distanceTo(thin)(10, 10)).toBeLessThan(0); // the hole is outside the band

    const side = 20 - 2 * 9.99;
    const almost = thicken(square, { radius: 9.99 });
    expect(Math.abs(loopsOf(almost).find((l) => l.area < 0)!.area)).toBeCloseTo(side * side, 1);

    const closed = thicken(square, { radius: 10 });
    expect(loopsOf(closed)).toHaveLength(1);
    expect(distanceTo(closed)(10, 10)).toBeGreaterThan(0);
  });

  it('disjoint, overlapping, exactly tangent, contained and narrowly gapped coverage', () => {
    const disjoint = thicken(material([[0, 0], [10, 0]], { radius: [2, 2] }), { radius: radiusOf });
    expect(loopsOf(disjoint)).toHaveLength(2);
    expect(loopsOf(disjoint).every((l) => l.area > 0)).toBe(true);

    const overlap = thicken(material([[0, 0], [3, 0]], { radius: [2, 2] }), { radius: radiusOf });
    expect(loopsOf(overlap)).toHaveLength(1);
    expect(distanceTo(overlap)(1.5, 0)).toBeGreaterThan(0);

    const tangent = thicken(material([[0, 0], [4, 0]], { radius: [2, 2] }), { radius: radiusOf });
    const tangentLoops = loopsOf(tangent);
    expect(tangentLoops).toHaveLength(2);
    // Both loops carry the contact point as their own row.
    const contacts = tangentLoops.map((l) => l.pts.filter(([x, y]) => Math.abs(x - 2) < 1e-9 && Math.abs(y) < 1e-9).length);
    expect(contacts).toEqual([1, 1]);

    const contained = thicken(material([[0, 0], [5, 0]], { radius: [10, 2] }), { radius: radiusOf });
    expect(loopsOf(contained)).toHaveLength(1);
    expect(distanceTo(contained)(9.9, 0)).toBeGreaterThan(0);
    expect(distanceTo(contained)(10.1, 0)).toBeLessThan(0);

    // A 0.001 gap stays a gap; a 0.4 gap with radius 0.3 merges.
    const nearly = thicken(material([[0, 0], [4.001, 0]], { radius: [2, 2] }), { radius: radiusOf });
    expect(loopsOf(nearly)).toHaveLength(2);
    const channel = material([[0, 0], [10, 0], [0, 0.4], [10, 0.4]], { edges: [[0, 1], [2, 3]] });
    expect(loopsOf(thicken(channel, { radius: 0.3 }))).toHaveLength(1);
    expect(loopsOf(thicken(channel, { radius: 0.1 }))).toHaveLength(2);
  });

  it('duplicate, reversed and coincident edges count coverage once', () => {
    const dup = material([[0, 0], [10, 0], [0, 10]], { edges: [[0, 1], [0, 1], [1, 0]] });
    const body = thicken(dup, { radius: 1 });
    expect(loopsOf(body)).toHaveLength(2); // the capsule and the isolated disc
    const capsule = loopsOf(body).reduce((a, b) => (Math.abs(a.area) > Math.abs(b.area) ? a : b));
    expect(Math.abs(capsule.area)).toBeCloseTo(20 + Math.PI, 0);
    expect(distanceTo(body)(5, 0)).toBeGreaterThan(0);
    expect(distanceTo(body)(5, 2)).toBeLessThan(0);
  });

  it('a self-crossing chain closes its loops without parity cancellation', () => {
    const bow = material([[0, 0], [10, 10], [10, 0], [0, 10]], { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] });
    const body = thicken(bow, { radius: 1 });
    const loops = loopsOf(body);
    expect(loops.length).toBeGreaterThanOrEqual(1);
    for (const l of loops) {
      expect(l.pts.length).toBeGreaterThanOrEqual(3);
      for (let k = 0; k < l.pts.length; k++) {
        const p = l.pts[k];
        const q = l.pts[(k + 1) % l.pts.length];
        expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeGreaterThan(0);
      }
    }
    expect(distanceTo(body)(5, 5)).toBeGreaterThan(0);
  });

  it('subdividing an edge with interpolated position and radius preserves the union', () => {
    const coarse = thicken(edgeMaterial([0, 0], [10, 0], 3, 0), { radius: radiusOf, tolerance: 0.01 });
    const fine = thicken(
      material([[0, 0], [5, 0], [10, 0]], { edges: [[0, 1], [1, 2]], radius: [3, 1.5, 0] }),
      { radius: radiusOf, tolerance: 0.01 },
    );
    const dc = distanceTo(coarse);
    const df = distanceTo(fine);
    for (let x = -2; x <= 11; x += 0.25) {
      for (let y = -2; y <= 2; y += 0.25) {
        const a = dc(x, y);
        const b = df(x, y);
        if (Math.abs(a) < 0.1 || Math.abs(b) < 0.1) continue;
        expect(Math.sign(a)).toBe(Math.sign(b));
      }
    }
  });

  it('translation moves the result and nothing else', () => {
    const base = edgeMaterial([0, 0], [10, 0], 2, 1);
    const a = thicken(base, { radius: radiusOf, tolerance: 0.02 });
    const shifted = material([[100, 50], [110, 50]], { edges: [[0, 1]], radius: [2, 1] });
    const b = thicken(shifted, { radius: radiusOf, tolerance: 0.02 });
    expect(a.n).toBe(b.n);
    const ba = bounds(a);
    const bb = bounds(b);
    expect(bb.minX - ba.minX).toBeCloseTo(100, 9);
    expect(bb.minY - ba.minY).toBeCloseTo(50, 9);
  });
});

// ---- material and callback contract ----------------------------------------------

describe('thicken: material and callback contract', () => {
  const tree = material(
    [[0, 0], [10, 0], [0, 10], [10, 10]],
    { edges: [[0, 1], [0, 2], [1, 3]], radius: [2, 1, 1, 1], age: [4, 2, 1, 3] },
  );

  it('point selection keeps selected isolated vertices and induced edges', () => {
    const sel = tree.points.filter((p) => p.index === 0 || p.index === 1 || p.index === 3);
    expect(sel.inducedEdges().indices).toEqual([0, 2]);
    const body = thicken(sel, { radius: 1 });
    const loops = loopsOf(body);
    // One connected region (two induced edges share row 0) plus the isolated row 3? row 3 is connected by edge 2.
    expect(loops).toHaveLength(1);
    expect(distanceTo(body)(10, 10)).toBeGreaterThan(0);
    expect(distanceTo(body)(0, 10)).toBeLessThan(0);

    const isolated = tree.points.filter((p) => p.index === 2);
    const disc = thicken(isolated, { radius: 1 });
    expect(loopsOf(disc)).toHaveLength(1);
    expect(distanceTo(disc)(0, 10)).toBeGreaterThan(0);
  });

  it('edge selection contributes endpoints only', () => {
    const one = tree.edges.filter((e) => e.index === 0);
    const body = thicken(one, { radius: 1 });
    expect(loopsOf(body)).toHaveLength(1);
    expect(distanceTo(body)(5, 0)).toBeGreaterThan(0);
    expect(distanceTo(body)(5, 10)).toBeLessThan(0); // the other vertices do not participate
  });

  it('keyed selections from groupBy work at runtime and in types', () => {
    const groups = tree.points.groupBy((p) => (p.age > 2 ? 'old' : 'young'));
    expect(groups.map((g) => g.key)).toEqual(['old', 'young']);
    for (const g of groups) {
      const body = thicken(g, { radius: (p) => p.age });
      expect(body.n).toBeGreaterThan(0);
    }
  });

  it('radius runs once per participating vertex in ascending row order', () => {
    const rows: number[] = [];
    thicken(tree, { radius: (p) => { rows.push(p.index); return 1; } });
    expect(rows).toEqual([0, 1, 2, 3]);
    const seen: number[] = [];
    thicken(tree.points.filter((p) => p.index >= 2), { radius: (p) => { seen.push(p.index); return 1; } });
    expect(seen).toEqual([2, 3]);
    // Duplicate source edges never change the radius call count.
    const dup = material([[0, 0], [10, 0]], { edges: [[0, 1], [0, 1], [1, 0]] });
    const counts: number[] = [];
    thicken(dup, { radius: (p) => { counts.push(p.index); return 1; } });
    expect(counts).toEqual([0, 1]);
  });

  it('valid callbacks are not invoked on empty input, invalid options still throw', () => {
    let calls = 0;
    const empty = thicken(material([]), { radius: () => { calls++; return 1; } });
    expect(empty.n).toBe(0);
    expect(calls).toBe(0);
    expect(thicken(material([]), { radius: -1 }).n).toBe(0);
    expect(() => thicken(material([]), { radius: NaN })).toThrow(/radius must be finite/);
    expect(() => thicken(material([]), { radius: 1, tolerance: 0 })).toThrow(/tolerance/);
  });

  it('clamps negative radius fields to zero while retaining finite validation', () => {
    const src = material([[0, 0], [10, 0]]);
    const field = (p: { x: number }) => p.x / 5 - 1;
    const actual = thicken(src, { radius: field });
    const expected = thicken(src, { radius: p => Math.max(0, field(p)) });
    expect(actual.x).toEqual(expected.x);
    expect(actual.y).toEqual(expected.y);
    expect(actual.edgeList).toEqual(expected.edgeList);
    expect(thicken(src, { radius: -1 }).n).toBe(0);
    expect(() => thicken(src, { radius: () => Infinity })).toThrow(/must be finite/);
  });

  it('rejects unknown options, a missing radius and wrong sources', () => {
    expect(() => thicken(tree, { radius: 1, wobble: 2 } as never)).toThrow(/unknown option 'wobble'/);
    expect(() => thicken(tree, {} as never)).toThrow(/radius is required/);
    expect(() => thicken(tree, { radius: 'x' as never })).toThrow(/radius must be a number or a function/);
    expect(() => thicken([[0, 0]] as never, { radius: 1 })).toThrow(/source must be a Material/);
    expect(() => thicken(tree, { radius: 1, point: 3 } as never)).toThrow(/point must be a function/);
  });

  it('geometry-only output has empty domains, iteration 0, empty history and own arrays', () => {
    const body = thicken(tree, { radius: 1 });
    expect(body.attrNames).toEqual([]);
    expect(body.edgeAttrNames).toEqual([]);
    expect(body.iteration).toBe(0);
    expect(body.history).toEqual([]);
    // The source is untouched.
    expect(tree.n).toBe(4);
    expect(tree.attrNames).toEqual(['radius', 'age']);
    expect(Array.from(tree.edgeList)).toEqual([0, 1, 0, 2, 1, 3]);
    // A later write to the result does not touch the source.
    body.x[0] = 999;
    expect(tree.x[0]).toBe(0);
  });

  it('point creates complete, consistent output rows from source candidates', () => {
    const body = thicken(tree, {
      radius: (p) => p.radius,
      point: ({ candidates }) => ({
        age: Math.max(...candidates.map((c) => c.attrs.age)),
        support: candidates.length,
      }),
    });
    expect(body.attrNames).toEqual(['age', 'support']);
    for (let i = 0; i < body.n; i++) {
      expect(Number.isFinite(body.attrs.age[i])).toBe(true);
      expect(body.attrs.support[i]).toBeGreaterThanOrEqual(1);
    }
    // Edge candidates interpolate their source columns by the declared policy;
    // vertex candidates expose the source row.
    expect(body.n).toBeGreaterThan(0);
  });

  it('candidate order is deterministic: vertices by row, then edges by row and t', () => {
    const taper = edgeMaterial([0, 0], [10, 0], 3, 0);
    const seen: { vertex?: number; edge?: number; t?: number }[] = [];
    thicken(taper, {
      radius: radiusOf,
      point: (ev) => {
        for (const c of ev.candidates) seen.push({ vertex: c.vertex, edge: c.edge, t: c.t });
        return {};
      },
    });
    for (const ev of seen) {
      if (ev.vertex === undefined) { expect(ev.edge).toBe(0); expect(ev.t).toBeGreaterThan(0); expect(ev.t!).toBeLessThan(1); }
      else expect(ev.edge).toBeUndefined();
    }
  });

  it('point failures: reserved names, inconsistent columns, non-finite values and thrown errors', () => {
    expect(() => thicken(tree, { radius: 1, point: () => ({ x: 1 }) })).toThrow(/reserved name 'x'/);
    let n = 0;
    expect(() => thicken(tree, { radius: 1, point: (): Record<string, number> => (n++ === 0 ? { a: 1 } : { b: 2 }) })).toThrow(/changed its columns/);
    expect(() => thicken(tree, { radius: 1, point: () => ({ a: Infinity }) })).toThrow(/non-finite 'a'/);
    expect(() => thicken(tree, { radius: 1, point: () => { throw new Error('boom'); } })).toThrow(/point callback threw.*boom/);
  });

  it('an empty result never invokes the point callback', () => {
    let calls = 0;
    const empty = thicken(material([[0, 0]]), { radius: 0, point: () => { calls++; return {}; } });
    expect(empty.n).toBe(0);
    expect(calls).toBe(0);
  });

  it('repeated calls are identical, in arrays and callback visit order', () => {
    const visit = () => {
      const order: string[] = [];
      const body = thicken(tree, { radius: radiusOf, point: (ev) => { order.push(`${ev.position[0]},${ev.position[1]}`); return {}; } });
      return { x: Array.from(body.x), edges: Array.from(body.edgeList), order };
    };
    const a = visit();
    const b = visit();
    expect(a.x).toEqual(b.x);
    expect(a.edges).toEqual(b.edges);
    expect(a.order).toEqual(b.order);
  });
});

// ---- integration -----------------------------------------------------------------

describe('thicken: integration', () => {
  const ring = thicken(curve([[0, 0], [30, 0], [30, 30], [0, 30]], { closed: true }), { radius: 2 });

  it('polygon, strokes, distanceTo and the boundary contract accept the result', () => {
    expect(polygon(ring).geom.kind).toBe('path');
    expect(strokes(ring)).toHaveLength(2);
    expect(numericLoops(ring, 'test')).toHaveLength(2);
    const d = distanceTo(ring);
    expect(d(15, 1)).toBeGreaterThan(0);
    expect(d(15, 15)).toBeLessThan(0);
  });

  it('a disconnected, holed result reports both outer and hole contours', () => {
    const many = thicken(
      material([[0, 0], [20, 0], [20, 20], [0, 20], [60, 0]], {
        edges: [[0, 1], [1, 2], [2, 3], [3, 0]],
        radius: [1, 1, 1, 1, 3],
      }),
      { radius: radiusOf },
    );
    const loops = loopsOf(many);
    expect(loops.filter((l) => l.area > 0)).toHaveLength(2);
    expect(loops.filter((l) => l.area < 0)).toHaveLength(1);
  });
});

// ---- regressions -----------------------------------------------------------------

describe('thicken: regressions', () => {
  it('moving a thin drawing does not weld its outline or drop its thickness', () => {
    const here = thicken(material([[0, 0], [10, 0]], { edges: [[0, 1]] }), { radius: 0.01 });
    const far = thicken(material([[1e6, 1e6], [1e6 + 10, 1e6]], { edges: [[0, 1]] }), { radius: 0.01 });
    expect(here.n).toBeGreaterThan(0);
    expect(far.n).toBe(here.n);
    expect(loopsOf(far)).toHaveLength(1);
    // Same outline, translated: compare vertices rather than shoelace area,
    // which loses precision in absolute terms at a large offset.
    const key = (pts: readonly [number, number][]) => pts.map(([x, y]) => [x, y] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const herePts = key(loopsOf(here)[0].pts);
    const farPts = key(loopsOf(far)[0].pts.map(([x, y]) => [x - 1e6, y - 1e6] as [number, number]));
    expect(farPts.length).toBe(herePts.length);
    for (let k = 0; k < herePts.length; k++) {
      expect(farPts[k][0]).toBeCloseTo(herePts[k][0], 6);
      expect(farPts[k][1]).toBeCloseTo(herePts[k][1], 6);
    }
    // A real gap keeps its gap at large coordinates. (The tight 0.001 gap is
    // checked by loop count alone: a point that near the boundary is inside
    // the arc's chord approximation, not the disc.)
    const tight = thicken(material([[1e6, 1e6], [1e6 + 2.001, 1e6]], { radius: [1, 1] }), { radius: radiusOf });
    expect(loopsOf(tight)).toHaveLength(2);
    const gap = thicken(material([[1e6, 1e6], [1e6 + 2.2, 1e6]], { radius: [1, 1] }), { radius: radiusOf });
    expect(loopsOf(gap)).toHaveLength(2);
    expect(distanceTo(gap)(1e6 + 1.1, 1e6)).toBeLessThan(0);
  });

  it('each coincident generator keeps its own parameter mapping', () => {
    // Two horizontal edges overlap on [5, 10]. At (5, -1), the boundary point
    // is the second edge's own start, so its candidate is that vertex (x = 5),
    // not the midpoint of its parameter range (x = 10).
    const two = material(
      [[0, 0], [10, 0], [5, 0], [15, 0]],
      { edges: [[0, 1], [2, 3]], radius: [1, 1, 1, 1], xref: [0, 10, 5, 15] },
    );
    const events: { x: number; y: number; cands: string[]; xrefs: number[] }[] = [];
    thicken(two, {
      radius: radiusOf,
      point: (ev) => {
        events.push({
          x: ev.position[0],
          y: ev.position[1],
          cands: ev.candidates.map((c) => (c.vertex !== undefined ? `v${c.vertex}` : `e${c.edge}@${c.t}`)),
          xrefs: ev.candidates.map((c) => c.attrs.xref),
        });
        return {};
      },
    });
    const at5 = events.filter((e) => Math.abs(e.x - 5) < 1e-9 && Math.abs(e.y + 1) < 1e-9);
    expect(at5).toHaveLength(1);
    expect(at5[0].cands).toContain('v2');
    expect(at5[0].xrefs).toContain(5);
    // The first edge still reports its own 0.5 parameter there.
    expect(at5[0].cands).toContain('e0@0.5');
  });

  it('a covered generator tangent to the boundary still contributes provenance', () => {
    // Disc B (radius 1 at (1, 0)) is internally tangent to and inside disc A
    // (radius 2 at the origin). Both support the boundary point (2, 0).
    const events: { x: number; y: number; cands: string[] }[] = [];
    thicken(material([[0, 0], [1, 0]], { radius: [2, 1] }), {
      radius: radiusOf,
      point: (ev) => {
        events.push({ x: ev.position[0], y: ev.position[1], cands: ev.candidates.map((c) => (c.vertex !== undefined ? `v${c.vertex}` : `e${c.edge}`)) });
        return {};
      },
    });
    const at2 = events.filter((e) => Math.abs(e.x - 2) < 1e-9 && Math.abs(e.y) < 1e-9);
    expect(at2).toHaveLength(1);
    expect(at2[0].cands).toContain('v0');
    expect(at2[0].cands).toContain('v1');
  });
});

// ---- near-degenerate junctions ----------------------------------------------------

describe('thicken: near-degenerate junctions', () => {
  it('does not extrapolate a near-tangent crossing over an exterior interval', () => {
    const src = material([[30,70],[30,30],[35,35],[25,35],[44.99999999999999,35]], {
      edges: [[0,1],[2,3],[2,4]],
    });
    const body = thicken(src, {radius:p => 0.1 + p.x / 100 * 0.9});
    expect(body.curves()).toHaveLength(1);
    expect(body.curves()[0].closed).toBe(true);
    const d = distanceTo(body);
    expect(d(32,35)).toBeGreaterThan(0.35);
    expect(d(30,33)).toBeGreaterThan(0.35);
    expect(d(32,34)).toBeLessThan(-0.5);
  });

  const kink = (h: number, ox = 0, oy = 0, angle = 0, reverse = false) => {
    const base: [number, number][] = [[0, 0], [10, 0], [20, h]];
    const pts = base.map(([x, y]) => [
      ox + x * Math.cos(angle) - y * Math.sin(angle),
      oy + x * Math.sin(angle) + y * Math.cos(angle),
    ] as [number, number]);
    if (reverse) pts.reverse();
    return material(pts, { edges: [[0, 1], [1, 2]] });
  };

  it('an almost-collinear kink closes as one contour with its outer arc', () => {
    const body = thicken(kink(0.001), { radius: 1 });
    const loops = loopsOf(body);
    expect(loops).toHaveLength(1);
    // The outer arc at the middle vertex is present, not replaced by a false
    // second tangency event.
    expect(loops[0].pts.some(([, y]) => y < -0.9)).toBe(true);
    const d = distanceTo(body);
    expect(d(5, 0)).toBeGreaterThan(0.9);
    expect(d(15, 0.0005)).toBeGreaterThan(0.9);
    expect(d(10, 2)).toBeLessThan(0);
    expect(() => thicken(kink(0.001), { radius: 1 })).not.toThrow();
  });

  it('kinks survive at diminishing heights with interior and exterior witnesses', () => {
    for (const h of [1e-3, 1e-6, 1e-8, 1e-10, 1e-12]) {
      const body = thicken(kink(h), { radius: 1 });
      const loops = loopsOf(body);
      expect(loops, `height ${h}`).toHaveLength(1);
      expect(loops[0].pts.length).toBeGreaterThanOrEqual(3);
      const d = distanceTo(body);
      expect(d(5, 0), `inside at height ${h}`).toBeGreaterThan(0.5);
      expect(d(10, 2), `outside at height ${h}`).toBeLessThan(0);
    }
  });

  it('rotated and translated kinks close for both source orders', () => {
    let closed = 0;
    for (const h of [1e-3, 1e-6, 1e-8]) {
      for (const angle of [0, 0.37, Math.PI / 2]) {
        for (const [ox, oy] of [[0, 0], [100, 100], [1e6, 1e6]] as const) {
          for (const reverse of [false, true]) {
            const body = thicken(kink(h, ox, oy, angle, reverse), { radius: 1 });
            const loops = loopsOf(body);
            expect(loops, `h=${h} a=${angle} o=(${ox},${oy}) rev=${reverse}`).toHaveLength(1);
            expect(body.curves().every((c) => c.closed)).toBe(true);
            closed++;
          }
        }
      }
    }
    expect(closed).toBe(54);
  });

  it('duplicate and reversed edges with a third hull resolve under exact identity', () => {
    const body = thicken(
      material([[4, 7], [5, 17], [12, 6], [18, 16], [8, 6]], {
        edges: [[0, 1], [1, 2], [2, 3], [0, 4], [1, 2]],
        radius: [3.612, 0.185, 3.043, 0.093, 1.746],
      }),
      { radius: radiusOf },
    );
    expect(loopsOf(body).length).toBeGreaterThan(0);
    expect(body.curves().every((c) => c.closed)).toBe(true);
  });

  it('gaps and overlaps above the approximation budget retain topology', () => {
    const rotated = (sep: number) => {
      const a = 0.37;
      const pts = ([[0, 0], [10, 0], [5, 2 + sep]] as [number, number][]).map(([x, y]) => [
        x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a),
      ] as [number, number]);
      return material(pts, { edges: [[0, 1]], radius: [1, 1, 1] });
    };
    expect(loopsOf(thicken(rotated(1e-4), { radius: 1, tolerance: 1e-6 }))).toHaveLength(2);
    expect(loopsOf(thicken(rotated(0), { radius: 1, tolerance: 1e-6 }))).toHaveLength(2);
    expect(loopsOf(thicken(rotated(-1e-4), { radius: 1, tolerance: 1e-6 }))).toHaveLength(1);
  });

  it('separated discs far from the origin do not invent a contact', () => {
    const body = thicken(
      material([[1e6, 0], [1e6 + 0.02 + 0.001, 0]], { radius: [0.01, 0.01] }),
      { radius: radiusOf },
    );
    const loops = loopsOf(body).sort((a,b) => Math.min(...a.pts.map(p=>p[0])) - Math.min(...b.pts.map(p=>p[0])));
    expect(loops).toHaveLength(2);
    const left = Math.max(...loops[0].pts.map(([x]) => x));
    const right = Math.min(...loops[1].pts.map(([x]) => x));
    expect(right - left).toBeGreaterThan(0.0005);
  });

  it('a tiny closed disc far from the origin keeps its area', () => {
    const far = thicken(material([[1e6, 1e6]], { radius: 0.001 }), { radius: radiusOf });
    expect(loopsOf(far)).toHaveLength(1);
    expect(distanceTo(far)(1e6, 1e6)).toBeGreaterThan(0);
    const further = thicken(material([[1e8, 1e8]], { radius: 1 }), { radius: radiusOf });
    expect(loopsOf(further)).toHaveLength(1);
    expect(distanceTo(further)(1e8, 1e8)).toBeGreaterThan(0);
  });

  it('a fixed randomized corpus never crashes and keeps the oracle sign', () => {
    let s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    let checked = 0;
    for (let c = 0; c < 800; c++) {
      const n = 1 + Math.floor(rnd() * 6);
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) pts.push([Math.round(rnd() * 20), Math.round(rnd() * 20)]);
      const edges: [number, number][] = [];
      for (let i = 1; i < n; i++) if (rnd() < 0.7) edges.push([Math.floor(rnd() * i), i]);
      if (edges.length && rnd() < 0.2) { const e = edges[Math.floor(rnd() * edges.length)]; edges.push(rnd() < 0.5 ? [e[0], e[1]] : [e[1], e[0]]); }
      const radius = pts.map(() => +(rnd() * 4).toFixed(3));
      const shapes: Envelope[] = [];
      for (const [a, b] of edges) if (radius[a] > 0 || radius[b] > 0) shapes.push([pts[a][0], pts[a][1], pts[b][0], pts[b][1], radius[a], radius[b]]);
      const onEdge = new Set<number>();
      for (const [a, b] of edges) { onEdge.add(a); onEdge.add(b); }
      for (let i = 0; i < n; i++) if (!onEdge.has(i) && radius[i] > 0) shapes.push([pts[i][0], pts[i][1], pts[i][0], pts[i][1], radius[i], radius[i]]);
      const queries = Array.from({ length: 60 }, () => [-4 + rnd() * 30, -4 + rnd() * 30] as [number, number]);
      let body: Material;
      try {
        body = thicken(material(pts, { edges, radius }), { radius: radiusOf, tolerance: 0.02 });
      } catch (err) {
        throw new Error(`corpus case ${c} crashed: ${(err as Error).message}`);
      }
      if (shapes.length > 0) expect(body.n, `corpus case ${c} unexpectedly empty`).toBeGreaterThan(0);
      if (shapes.length === 0) continue;
      const covers = oracle(shapes);
      const d = distanceTo(body);
      for (const [x, y] of queries) {
        const value = d(x, y);
        if (Math.abs(value) < 0.05) continue;
        checked++;
        expect(value > 0, `corpus case ${c} at (${x}, ${y})`).toBe(covers(x, y));
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});


describe('thicken: sub-resolution near-tangent circle intersections', () => {
  it.each([
    [[-1, 0], [0.9999999999999999, 0]],
    [[0, 0], [2 * Math.cos(0.1), 2 * Math.sin(0.1)]],
  ])('returns closed bounded approximations for nearly touching discs %j', (a, b) => {
    const out = thicken(material([a as [number, number], b as [number, number]]), { radius: 1 });
    const contours = [...out.curves()];
    expect(contours.length).toBeGreaterThan(0);
    expect(contours.every(c => c.closed)).toBe(true);
    expect(totalArea(out)).toBeGreaterThan(5.5);
    expect(Array.from(out.x).every(Number.isFinite)).toBe(true);
    expect(Array.from(out.y).every(Number.isFinite)).toBe(true);
  });
});

describe('thicken: shared circle intersection construction', () => {
  it.each([
    [[0, 1], [0, 2], [1, 3]],
    [[1, 3], [0, 2], [0, 1]],
    [[0, 2], [0, 1], [1, 3]],
    [[1, 0], [2, 0], [3, 1]],
  ])('shares the junction across repeated circle pairs, edge order %j', (...edges) => {
    const source = material([
      [0.18029026687145233, 2.377823661081493],
      [11.650821128860116, 7.7608753414824605],
      [15.749140549451113, 2.8944345703348517],
      [3.4245460759848356, 7.2784881154075265],
      [10.151658169925213, 13.536654221825302],
    ], {
      edges: edges.map(([a, b]): [number, number] => [a, b]),
      radius: [0.9179886434227228, 3.5909650990739466, 3.7258079521358014,
        1.0258007360622288, 3.5144658725708724],
    });
    const body = thicken(source, {
      radius: radiusOf, tolerance: 0.02,
      point: event => ({ supports: event.candidates.length }),
    });
    expect(body.curves()).toHaveLength(1);
    expect(body.curves()[0].closed).toBe(true);
    const d = distanceTo(body);
    for (let i = 0; i < source.n; i++) expect(d(source.x[i], source.y[i])).toBeGreaterThan(0);
    const junction = body.points.filter(p => Math.hypot(p.x - 15.031654855962282, p.y - 6.550506119940689) < 0.02);
    expect(junction.indices).toHaveLength(1);
    expect(body.vertex(junction.indices[0]).supports).toBe(2);
  });
});


it('keeps closed coverage around a sub-resolution line–circle overlap', () => {
  const body = thicken(material([[-4, -2], [4, -2], [0, 0.9999999999999999]], {
    edges: [[0, 1]], radius: [1, 1, 2],
  }), { radius: radiusOf });
  expect(body.curves().every(c => c.closed)).toBe(true);
  expect(distanceTo(body)(0, -2)).toBeGreaterThan(0);
  expect(distanceTo(body)(0, 1)).toBeGreaterThan(0);
});


describe('thicken: overlapping recursive rectangles', () => {
  // Go through the real sketch/material lowering: its representable coordinates
  // include adjacent doubles, which integer-only polygon fixtures miss.
  function recursive(level: number, spacing: number | undefined, paper: number, initialSize = 40): Material {
    let result!: Material;
    setPaperHint(paper, paper);
    try {
      compileSketch(sketch({ aspect: [1, 1], margin: 6, seed: 42 }, (t) => {
        const b = t.bounds();
        let size = initialSize;
        let m = t.material(t.rect(b.cx - size / 2, b.cy - size / 2, size, size));
        for (let generation = 0; generation <= level; generation++) {
          const shapes = m.along(spacing === undefined ? undefined : { spacing }).map(p =>
            t.rect(p.x - size / 4, p.y - size / 4, size / 2, size / 2));
          m = shapes.reduce((acc, shape) => append(acc, t.material(shape)), m);
          size /= 2;
        }
        result = m;
        return [];
      }));
    } finally { setPaperHint(210, 297); }
    return result;
  }

  for (const [level, spacing, radius] of [[3, undefined, 1], [0, 3, 2], [0, 4, 2], [1, undefined, 2]] as const) {
    it(`preserves coverage and holes at level ${level}, spacing ${spacing}, radius ${radius}`, () => {
      for (const paper of [210, 304.8]) {
        const src = recursive(level, spacing, paper);
        const body = thicken(src, { radius, tolerance: 0.01 });
        expect(body.n).toBeGreaterThan(0);
        expect([...body.x, ...body.y].every(Number.isFinite)).toBe(true);
        expect(body.curves().every(c => c.closed)).toBe(true);
        const loops = loopsOf(body);
        expect(loops.some(c => c.area > 0)).toBe(true);
        expect(loops.some(c => c.area < 0)).toBe(true);
        const d = distanceTo(body);
        // The source edges leave the central square empty at every tested depth.
        expect(d(50, 50)).toBeLessThan(0);
        const covers: Envelope[] = [];
        for (let i = 0; i < src.edgeList.length; i += 2) {
          const a = src.edgeList[i], b = src.edgeList[i + 1];
          covers.push([src.x[a], src.y[a], src.x[b], src.y[b], radius, radius]);
        }
        const inside = oracle(covers);
        // Independent capsule-union membership, including interior holes and
        // exterior witnesses; skip only the output's arc tessellation budget.
        for (let i = 0; i < 900; i++) {
          const x = 7.173 + ((i * 47) % 901) / 901 * 86;
          const y = 7.291 + ((i * 313) % 907) / 907 * 86;
          const actual = d(x, y);
          if (Math.abs(actual) <= 0.025) continue;
          expect(actual > 0, `paper=${paper} point=(${x},${y})`).toBe(inside(x, y));
        }
      }
    });
  }
  it('sweeps sizes, radii, depths and station spacing against capsule coverage', () => {
    const cases: [number, number, number, number | undefined][] = [];
    for (const size of [28, 40, 53]) for (const radius of [0.4, 1.3, 2, 3])
      for (const level of [0, 1, 2]) cases.push([size, radius, level, undefined]);
    for (const spacing of [2.5, 3, 4, 5]) for (const radius of [1, 2])
      cases.push([40, radius, 0, spacing]);
    for (const [size, radius, level, spacing] of cases) {
      const context = `size=${size}, radius=${radius}, level=${level}, spacing=${spacing}`;
      const src = recursive(level, spacing, 304.8, size);
      let body: Material;
      try { body = thicken(src, { radius, tolerance: 0.01 }); }
      catch (error) { throw new Error(`${context}: ${String(error)}`); }
      expect(body.curves().every(c => c.closed), context).toBe(true);
      const shapes: Envelope[] = [];
      for (let i = 0; i < src.edgeList.length; i += 2) {
        const a = src.edgeList[i], b = src.edgeList[i + 1];
        shapes.push([src.x[a], src.y[a], src.x[b], src.y[b], radius, radius]);
      }
      const inside = oracle(shapes), d = distanceTo(body);
      for (let i = 0; i < 180; i++) {
        const x = 0.317 + ((i * 47) % 181) / 181 * 100;
        const y = 0.191 + ((i * 113) % 191) / 191 * 100;
        const actual = d(x, y);
        if (Math.abs(actual) <= 0.025) continue;
        expect(actual > 0, `${context}, (${x},${y})`).toBe(inside(x, y));
      }
    }
  }, 30000);

  it('checks varying-radius recursive boundaries against their tapered envelopes', () => {
    for (const paper of [100, 200, 210, 297, 304.8]) {
      for (const field of [
        (p: Vertex) => 0.1 + (p.x / 100) * 0.9,
        (p: Vertex) => 1 - (p.x / 100) * 0.9,
        (p: Vertex) => 0.1 + (p.y / 100) * 0.9,
      ]) {
        const src = recursive(1, undefined, paper);
        const body = thicken(src, { radius: field, tolerance: 0.01 });
        expect(body.curves().every(c => c.closed)).toBe(true);
        expect([...body.x, ...body.y].every(Number.isFinite)).toBe(true);
        const shapes: Envelope[] = [];
        const radii = Array.from({length: src.n}, (_, i) => field({x:src.x[i], y:src.y[i]} as Vertex));
        for (let i = 0; i < src.edgeList.length; i += 2) {
          const a = src.edgeList[i], b = src.edgeList[i + 1];
          shapes.push([src.x[a], src.y[a], src.x[b], src.y[b], radii[a], radii[b]]);
        }
        const inside = oracle(shapes), d = distanceTo(body);
        expect(d(50, 50)).toBeLessThan(0);
        for (let i = 0; i < 900; i++) {
          const x = 9.173 + ((i * 47) % 901) / 901 * 82;
          const y = 9.291 + ((i * 313) % 907) / 907 * 82;
          const actual = d(x, y);
          if (Math.abs(actual) <= 0.025) continue;
          expect(actual > 0, `paper=${paper}, point=(${x},${y})`).toBe(inside(x, y));
        }
      }
    }
  });
  for (const paper of [100, 200, 210, 297, 304.8])
    for (const [depth, low, high] of [
      [1, 1, 5],
      [3, 0.1, 1],
    ]) {
      it(`certifies the reported variable-radius family: paper=${paper}, depth=${depth}, radii=${low}..${high}`, () => {
        const src = recursive(depth, undefined, paper),
          radii = Array.from(src.x, (x) => low + (x / 100) * (high - low));
        const body = thicken(src, {
          radius: (p) => radii[p.index],
          tolerance: 0.01,
        });
        expect(body.curves().every((c) => c.closed)).toBe(true);
        expect([...body.x, ...body.y].every(Number.isFinite)).toBe(true);
        const envelopes: Envelope[] = [];
        for (let i = 0; i < src.edgeCount; i++) {
          const a = src.edgeList[2 * i],
            b = src.edgeList[2 * i + 1];
          envelopes.push([
            src.x[a],
            src.y[a],
            src.x[b],
            src.y[b],
            radii[a],
            radii[b],
          ]);
        }
        const oracle = exactEnvelopeOracle(envelopes),
          distance = distanceTo(body);
        expect(distance(50, 50)).toBeLessThan(0);
        for (let i = 0; i < 120; i++) {
          const x = 9.173 + (((i * 47) % 127) / 127) * 82,
            y = 9.291 + (((i * 89) % 131) / 131) * 82,
            d = distance(x, y);
          if (Math.abs(d) > 0.02)
            expect(d > 0, `query ${x},${y}`).toBe(oracle(x, y) < 0);
        }
      }, 60000);
    }

});


it('bounds polygon construction and coordinate range instead of returning partial geometry', () => {
  expect(() => thicken(material([[0, 0]]), { radius: 1, tolerance: 1e-20 })).toThrow(/budget/);
  expect(() => thicken(material([[0, 0], [1e20, 0]]), { radius: 1 })).toThrow(/range|precision/);
  expect(() => thicken(material([[1e20, 1e20]]), { radius: 1 })).toThrow(/represent/);
});

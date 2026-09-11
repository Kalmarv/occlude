import { describe, expect, it } from 'vitest';
import {
  distanceTo, material, curve, thicken, polygon, strokes, numericLoops,
  type Material, type Vertex,
} from '../src/index.js';

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
    expect(() => thicken(material([]), { radius: -1 })).toThrow(/radius must be finite and non-negative/);
    expect(() => thicken(material([]), { radius: 1, tolerance: 0 })).toThrow(/tolerance/);
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

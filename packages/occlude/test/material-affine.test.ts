import { describe, expect, it } from 'vitest';
import { append, curve, distance, material, type Material } from '../src/material.js';

// Off-centre on purpose: its bounds centre is [3, 5], not the origin.
const src = (): Material => curve([[1, 2], [5, 2], [5, 8], [1, 8]], { age: [1, 2, 3, 4] })
  .attribute('kind', 7, { transfer: 'nearest' })
  .edgeAttribute('w', (e) => e.index + 1, { transfer: 'distribute' });

const close = (got: readonly (readonly number[])[], want: readonly (readonly number[])[]) => {
  expect(got).toHaveLength(want.length);
  got.forEach(([x, y], i) => {
    expect(x).toBeCloseTo(want[i][0], 12);
    expect(y).toBeCloseTo(want[i][1], 12);
  });
};

describe('m.scale', () => {
  it('scales about the user origin when origin is unset', () => {
    close(src().scale(2).pts, [[2, 4], [10, 4], [10, 16], [2, 16]]);
  });

  it("keeps the bounds centre fixed with origin: 'center'", () => {
    close(src().scale(2, { origin: 'center' }).pts, [[-1, -1], [7, -1], [7, 11], [-1, 11]]);
  });

  it('takes a pair or a record as the pivot', () => {
    close(src().scale(2, { origin: [1, 2] }).pts, [[1, 2], [9, 2], [9, 14], [1, 14]]);
    close(src().scale(2, { origin: { x: 1, y: 2 } }).pts, [[1, 2], [9, 2], [9, 14], [1, 14]]);
  });

  it('stretches x only with [2, 1]', () => {
    close(src().scale([2, 1]).pts, [[2, 2], [10, 2], [10, 8], [2, 8]]);
  });

  it('puts every point on the pivot at zero, without throwing', () => {
    close(src().scale(0).pts, [[0, 0], [0, 0], [0, 0], [0, 0]]);
    close(src().scale(0, { origin: 'center' }).pts, [[3, 5], [3, 5], [3, 5], [3, 5]]);
  });
});

describe("origin: 'centroid'", () => {
  it('keeps a face centroid fixed when its extracted outline scales', () => {
    // Irregular on purpose, so the area centroid is not the bounds centre.
    const cells = append(
      curve([[0, 0], [9, 0], [12, 4], [3, 10], [0, 6]]),
      curve([[9, 0], [20, 1], [12, 4]]),
    ).merge().planarize().faces();
    expect(cells.faces.length).toBeGreaterThan(1);
    for (const f of cells.faces) {
      const outline = f.boundaryEdges.extract();
      const before = [...f.centroid];
      for (const [x, y] of outline.scale(0, { origin: 'centroid' }).pts) {
        expect(x).toBeCloseTo(before[0], 9);
        expect(y).toBeCloseTo(before[1], 9);
      }
      for (const k of [0.3, 2]) {
        const moved = outline.scale(k, { origin: 'centroid' });
        const again = moved.planarize().faces().faces[0];
        expect(again.centroid[0]).toBeCloseTo(before[0], 9);
        expect(again.centroid[1]).toBeCloseTo(before[1], 9);
      }
      const turned = outline.rotate(40, { origin: 'centroid' }).planarize().faces().faces[0];
      expect(turned.centroid[0]).toBeCloseTo(before[0], 9);
      expect(turned.centroid[1]).toBeCloseTo(before[1], 9);
    }
  });

  it('is not the bounds centre', () => {
    const tri = curve([[0, 0], [6, 0], [0, 6]]);
    close(tri.scale(0, { origin: 'centroid' }).pts, [[2, 2], [2, 2], [2, 2]]);
    close(tri.scale(0, { origin: 'center' }).pts, [[3, 3], [3, 3], [3, 3]]);
  });

  it('subtracts a hole, whatever way the hole is walked', () => {
    const outer = curve([[0, 0], [10, 0], [10, 10], [0, 10]]);
    for (const hole of [curve([[6, 4], [9, 4], [9, 6], [6, 6]]), curve([[6, 4], [6, 6], [9, 6], [9, 4]])]) {
      // Area 100 at [5, 5] less area 6 at [7.5, 5].
      const cx = (100 * 5 - 6 * 7.5) / 94;
      const p = append(outer, hole).scale(0, { origin: 'centroid' }).pts[0];
      expect(p[0]).toBeCloseTo(cx, 12);
      expect(p[1]).toBeCloseTo(5, 12);
    }
  });

  it('weights several separate areas by their area', () => {
    const big = curve([[0, 0], [4, 0], [4, 4], [0, 4]]);
    const small = curve([[10, 0], [12, 0], [12, 2], [10, 2]]);
    const p = append(big, small).scale(0, { origin: 'centroid' }).pts[0];
    expect(p[0]).toBeCloseTo((16 * 2 + 4 * 11) / 20, 12);
    expect(p[1]).toBeCloseTo((16 * 2 + 4 * 1) / 20, 12);
  });

  it('falls back to the mean of the points with no closed contour, and never throws', () => {
    const open = curve([[0, 0], [9, 0], [9, 3]], { closed: false });
    close(open.scale(0, { origin: 'centroid' }).pts, [[6, 1], [6, 1], [6, 1]]);
    const loose = material([[1, 1], [3, 5]]);
    close(loose.scale(0, { origin: 'centroid' }).pts, [[2, 3], [2, 3]]);
    expect(material([]).rotate(30, { origin: 'centroid' }).n).toBe(0);
  });
});

describe('m.rotate', () => {
  it('turns [1, 0] to [0, 1] about the origin by 90, counter-clockwise', () => {
    close(curve([[1, 0], [2, 0]], { closed: false }).rotate(90).pts, [[0, 1], [0, 2]]);
  });

  it('keeps distances', () => {
    const m = src();
    const r = m.rotate(37);
    for (let i = 0; i < m.n; i++) {
      for (let j = 0; j < m.n; j++) {
        expect(distance(r.pts[i], r.pts[j])).toBeCloseTo(distance(m.pts[i], m.pts[j]), 12);
      }
    }
  });

  it('keeps the pivot fixed', () => {
    const c: [number, number] = [5, 2];
    const r = src().rotate(90, { origin: c });
    close([r.pts[1]], [c]);
    close(r.pts, [[5, -2], [5, 2], [-1, 2], [-1, -2]]);
  });
});

describe('m.translate', () => {
  it('shifts every point', () => {
    close(src().translate([3, -4]).pts, [[4, -2], [8, -2], [8, 4], [4, 4]]);
    close(src().translate({ x: 3, y: -4 }).pts, [[4, -2], [8, -2], [8, 4], [4, 4]]);
  });
});

describe('m.deform', () => {
  it('with a constant field equals translate', () => {
    const m = src();
    expect(m.deform(() => [3, -4]).pts).toEqual(m.translate([3, -4]).pts);
  });

  it('with a zero field is the identity', () => {
    const m = src();
    expect(m.deform(() => [0, 0]).pts).toEqual(m.pts);
  });

  it('reads the field at the vertex and adds it', () => {
    close(src().deform((x, y) => [x * 0.5, -y]).pts, [[1.5, 0], [7.5, 0], [7.5, 0], [1.5, 0]]);
  });
});

describe('the four verbs are map underneath', () => {
  const verbs: [string, (m: Material) => Material][] = [
    ['scale', (m) => m.scale([2, 3], { origin: 'center' })],
    ['rotate', (m) => m.rotate(30, { origin: [1, 1] })],
    ['translate', (m) => m.translate([3, -4])],
    ['deform', (m) => m.deform((x, y) => [Math.sin(y), Math.cos(x)])],
  ];

  for (const [name, verb] of verbs) {
    it(`${name} keeps ids, columns and transfer policies, and a selection rebinds`, () => {
      const m = src();
      const moved = verb(m);
      const mapped = m.map((p) => [p.x, p.y]);
      expect(moved).not.toBe(m);
      expect(m.pts).toEqual([[1, 2], [5, 2], [5, 8], [1, 8]]);
      expect([...moved.points].map((p) => p.id)).toEqual([...m.points].map((p) => p.id));
      expect([...moved.edges].map((e) => e.id)).toEqual([...m.edges].map((e) => e.id));
      expect([...moved.attrs.age]).toEqual([1, 2, 3, 4]);
      expect([...moved.attrs.kind]).toEqual([7, 7, 7, 7]);
      expect([...moved.edgeAttrs.w]).toEqual([...m.edgeAttrs.w]);
      expect(moved.transfers).toEqual(mapped.transfers);
      expect(moved.edgeTransfers).toEqual(mapped.edgeTransfers);
      expect(moved.transfers.kind).toBe('nearest');
      expect(moved.edgeTransfers.w).toBe('distribute');
      expect(moved.closed).toBe(true);

      const some = m.points.filter((p) => p.age > 2);
      const again = some.in(moved);
      expect(again.length).toBe(2);
      expect(again.source).toBe(moved);
      expect([...again].map((p) => p.id)).toEqual([...some].map((p) => p.id));
    });
  }
});

describe('a non-finite input is refused by name', () => {
  it('scale, rotate, translate, deform and the pivot', () => {
    expect(() => src().deform(() => [NaN, 0])).toThrow(/m\.deform/);
    expect(() => src().deform((x) => [0, x > 3 ? Infinity : 0])).toThrow(/m\.deform/);
    expect(() => src().scale(NaN)).toThrow(/m\.scale/);
    expect(() => src().scale([1, Infinity])).toThrow(/m\.scale/);
    expect(() => src().rotate(NaN)).toThrow(/m\.rotate/);
    expect(() => src().translate([Infinity, 0])).toThrow(/m\.translate/);
    expect(() => src().scale(2, { origin: [NaN, 0] })).toThrow(/m\.scale/);
    expect(() => src().rotate(90, { origin: [0, Infinity] })).toThrow(/m\.rotate/);
  });
});

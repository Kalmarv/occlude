/**
 * The geometry protocol: one value, three accessors.
 *
 * Every resolved geometry value answers the accessors the table in
 * `working/geometry-spec.md` says it can, and nothing it cannot. The area
 * consumers — `polygon`, `distanceTo`, `force.boundary`, `t.within` — read
 * `contours()`; the chain consumers read `curves()`; the point consumers
 * read `points`. This test is the table, executable.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, connect, distanceTo, force, initOcclude, isGeometry, material, polygon, render,
  sketch, strokes, type Face, type Faces, type SketchDef,
} from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

const ink = (def: SketchDef): number => render(def, { paper: 'Square20' }).stats.fragments;

/** A closed ring, an open chain, and the collections they make. */
const ring = () => connect.ring(material([[10, 10], [60, 10], [60, 60], [10, 60]]));
const openChain = () => connect.chain(material([[10, 10], [60, 10], [60, 60]]));

function cellsOf(): Faces {
  return connect.ring(material([[10, 10], [60, 10], [60, 60], [10, 60]]))
    .withEdges([[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]])
    .planarize()
    .faces();
}

describe('what each value can say about itself', () => {
  it('a material answers all three: its points, its chains, and its closed chains as areas', () => {
    const m = ring();
    expect(isGeometry(m)).toBe(true);
    expect(m.points.length).toBe(4);
    expect(m.curves()).toHaveLength(1);
    expect(m.contours()).toHaveLength(1);
    expect(m.contours()[0].closed).toBe(true);
  });

  it('an open material has chains but no areas', () => {
    const m = openChain();
    expect(m.curves()).toHaveLength(1);
    expect(m.curves()[0].closed).toBe(false);
    expect(m.contours()).toHaveLength(0);
  });

  it('a point selection is its own points, and its chains are the edges among them', () => {
    const m = ring();
    const sel = m.points.filter((p) => p.x < 40);
    expect(isGeometry(sel)).toBe(true);
    expect(sel.points).toBe(sel);
    expect(sel.edges.length).toBe(1); // the one edge with both ends on the left
    expect(sel.curves()).toHaveLength(1);
  });

  it('an edge selection is its endpoints and its chains', () => {
    const m = ring();
    const sel = m.edges.filter((_, i) => i < 2);
    expect(isGeometry(sel)).toBe(true);
    expect(sel.points.length).toBe(3);
    expect(sel.curves()).toHaveLength(1);
  });

  it('a face collection and a selection answer contours(), and their rows are properties', () => {
    const cells = cellsOf();
    expect(cells.length).toBe(2);
    expect(cells.points.length).toBeGreaterThan(0);
    expect(cells.edges.length).toBeGreaterThan(0);
    expect(cells.contours().length).toBeGreaterThan(0);
    // boundaryEdges filters, so it stays a call.
    expect(typeof cells.boundaryEdges).toBe('function');
    const one = cells.filter((_, i) => i === 0);
    expect(one.points.length).toBeGreaterThan(0);
    expect(one.edges.length).toBeGreaterThan(0);
    expect(one.contours().length).toBeGreaterThan(0);
  });

  it('one face answers contours() like every other area, and its relations are properties', () => {
    const face: Face = cellsOf().at(0);
    expect(isGeometry(face)).toBe(true);
    expect(face.contours()).toHaveLength(1);
    expect(face.points.length).toBeGreaterThan(0);
    expect(face.edges.length).toBeGreaterThan(0);
    // A face is a plain record: the contours hang off it as a call, not as
    // one of its data keys.
    expect(Object.keys(face)).not.toContain('contours');
  });

  it('a shape is not geometry: it needs the frame first', () => {
    expect(isGeometry(circle(50, 50, 20))).toBe(false);
  });
});

describe('every area consumer reads the same values', () => {
  const rows = (): { what: string; area: unknown }[] => [
    { what: 'a material', area: ring() },
    { what: 'an edge selection', area: ring().edges },
    { what: 'a point selection', area: ring().points },
    { what: 'one face', area: cellsOf().at(0) },
    { what: 'contour records', area: ring().contours() },
    { what: 'one contour record', area: ring().contours()[0] },
    { what: 'loops of points', area: [[[10, 10], [60, 10], [60, 60]]] },
    { what: 'one loop', area: [[10, 10], [60, 10], [60, 60]] },
  ];

  it('polygon takes every row', () => {
    for (const { what, area } of rows()) {
      expect(() => polygon(area as never), what).not.toThrow();
    }
  });

  it('distanceTo and force.boundary take every row', () => {
    for (const { what, area } of rows()) {
      expect(() => distanceTo(area as never), what).not.toThrow();
      expect(() => force.boundary(area as never, { radius: 2 }), what).not.toThrow();
    }
  });

  it('t.within takes every row', () => {
    const drawn = ink(sketch({}, (t) => {
      const dots = material([[20, 20], [30, 30], [40, 40]]);
      for (const { area } of rows()) t.within(dots, area as never);
      return strokes(dots);
    }));
    expect(drawn).toBeGreaterThanOrEqual(0);
  });

  it('a face collection is several areas, and says which it means', () => {
    expect(() => polygon(cellsOf() as never)).toThrow(/face collection/);
  });

  it('a branching material is read by its faces; a branching selection has no single inside, and says so', () => {
    const star = material([[0, 0], [10, 0], [0, 10], [-10, 0]], { edges: [[0, 1], [0, 2], [0, 3]] });
    expect((polygon(star).geom as { cmds: unknown[] }).cmds).toEqual([]);
    expect(() => polygon(star.edges)).toThrow(/branches/);
  });
});

describe('a chain consumer reads curves(), whatever the value is', () => {
  it('draws a material, a point selection and an edge selection alike', () => {
    const m = ring();
    for (const source of [m, m.points, m.edges]) {
      expect(() => strokes(source as never)).not.toThrow();
    }
  });
});

describe('the consumers say what they read', () => {
  it('strokes draws any value with chains, and refuses one with none by name', () => {
    const m = ring();
    for (const source of [m, m.points, m.edges]) {
      expect(() => strokes(source as never)).not.toThrow();
    }
    // A face collection draws its edges, each wall once (spec 58, G1-22);
    // one face is an area, with no chains of its own.
    const cells = cellsOf();
    expect(strokes(cells).length).toBe(cells.edges.curves().length);
    expect(() => strokes(cells.at(0) as never)).toThrow(/no chains to draw/);
  });

  it('a branching point selection is refused as an area, like a branching material', () => {
    const star = material([[0, 0], [10, 0], [0, 10], [-10, 0]], { edges: [[0, 1], [0, 2], [0, 3]] });
    expect(() => polygon(star.points)).toThrow(/branches/);
  });

  it('t.sample redistributes a material along its own chains', () => {
    let before = 0;
    let after = 0;
    ink(sketch({}, (t) => {
      const m = ring();
      before = m.points.length;
      after = t.sample(m, { count: 40 }).points.length;
      return [];
    }));
    expect(before).toBe(4);
    expect(after).toBe(40);
  });

  it('a force reads points from any geometry that has them', () => {
    const m = ring();
    for (const source of [m, m.points, m.edges.points]) {
      expect(() => force.separation(source as never, { radius: 3 })).not.toThrow();
    }
  });
});

describe('a shape is not geometry until the toolkit lowers it', () => {
  it('every t. word takes a shape where the plain import takes geometry', () => {
    const drawn = ink(sketch({}, (t) => {
      const area = circle(50, 50, 20);
      // The toolkit lowers the shape; each of these would refuse it bare.
      expect(typeof t.distanceTo(area)).toBe('function');
      expect(typeof t.force.boundary(area, { radius: 3 })).toBe('function');
      // A point consumer refuses a shape instead: how many points a shape
      // has would be a flattening tolerance's decision, not the sketch's.
      expect(() => t.force.separation(area, { radius: 3 })).toThrow(/not a set of points/);
      expect(() => t.force.attract(area, { radius: 3 })).toThrow(/t\.sample\(shape, \{ count \}\)/);
      // Given points, they work: the door is explicit.
      const points = t.material(area);
      expect(typeof t.force.separation(points, { radius: 3 })).toBe('function');
      expect(points.points.near([50, 30], { radius: 3 }).length).toBeGreaterThan(0);
      return [];
    }));
    expect(drawn).toBe(0);
  });

  it('the same words take resolved geometry, and give the same field', () => {
    ink(sketch({}, (t) => {
      const m = t.material(circle(50, 50, 20));
      const bare = distanceTo(m);
      const viaToolkit = t.distanceTo(m);
      expect(viaToolkit(50, 50)).toBeCloseTo(bare(50, 50), 10);
      return [];
    }));
  });

  it('the pure import still refuses a shape, by name', () => {
    expect(() => distanceTo(circle(50, 50, 20) as never)).toThrow(/not geometry until the toolkit lowers it: use t\.distanceTo/);
  });
});

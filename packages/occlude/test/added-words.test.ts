/**
 * Four small words the docs audit could not write around: `t.seed`, `rows`
 * taking the views a sketch holds, `distance`/`length` on 3D rows,
 * and the face column `chart`.
 */

import { describe, expect, it } from 'vitest';
import { toolkit, SQ } from './helpers/run.js';
import { curve, distance, length } from '../src/index.js';
import { box, cone, cylinder, plane, sphere, torus } from '../src/three/api/index.js';

describe('t.seed', () => {
  it('is the configured number', () => {
    expect(toolkit({ seed: 42 }).seed).toBe(42);
  });

  it('is the configured string', () => {
    expect(toolkit({ seed: 'moth' }).seed).toBe('moth');
  });

  it("is the host seed when the config says 'url' or names none", () => {
    expect(toolkit({ seed: 'url' }, { ...SQ, seed: 'host' }).seed).toBe('host');
    expect(toolkit({}, { ...SQ, seed: 7 }).seed).toBe(7);
  });

  it('is not writable', () => {
    const t = toolkit({ seed: 3 });
    expect(() => { (t as { seed: unknown }).seed = 4; }).toThrow(TypeError);
    expect(t.seed).toBe(3);
  });
});

describe('rows takes views', () => {
  const m = curve([[0, 0], [10, 0], [10, 10], [0, 10], [0, 20]]);

  it('takes one vertex view and a list of views, never a row number', () => {
    const [a, b, c, d] = m.points;
    expect(m.points.rows(b).indices).toEqual([1]);
    expect(m.points.rows([c, a]).indices).toEqual([2, 0]);
    expect(m.points.rows([d, b]).indices).toEqual([3, 1]);
    expect(() => m.points.rows(2 as never)).toThrow(/points\.rows: expected a point row, or a list of them — got the number 2/);
    expect(() => m.points.rows([0, 1] as never)).toThrow(/points\.rows: expected a point — a vertex view or a point value; make one with point\(…\) — got the number 0/);
  });

  it('takes one edge view and a list of views', () => {
    const [e0, e1, e2, e3] = m.edges;
    expect(m.edges.rows(e1).indices).toEqual([1]);
    expect(m.edges.rows([e2, e0]).indices).toEqual([2, 0]);
    expect(m.edges.rows([e3, e1]).indices).toEqual([3, 1]);
    expect(() => m.edges.rows(0 as never)).toThrow(/edges\.rows: expected an edge row/);
  });

  it('reads a view of an earlier state by identity, and refuses one of another material by name', () => {
    // Ids are minted per run: make both in one.
    const here = curve([[0, 0], [10, 0], [10, 10], [0, 10], [0, 20]]);
    const other = curve([[0, 0], [5, 0], [5, 5]]);
    const [p] = other.points, [e] = other.edges;
    expect(() => here.points.rows(p)).toThrow(/points\.rows: that point is a row of an unrelated material/);
    expect(() => here.edges.rows([here.edges.at(0), e])).toThrow(/edges\.rows: that edge is a row of an unrelated material/);
    // A row that is gone drops out, as it does in a set operation.
    const gone = here.points.at(4);
    expect(here.points.remove(gone).points.rows([gone, here.points.at(0)]).indices).toEqual([0]);
    const later = here.points.set('h', 1);
    expect(later.points.rows(here.points.at(2)).indices).toEqual([2]);
  });

  it('refuses a view of the other kind by name', () => {
    const [p] = m.points, [e] = m.edges;
    expect(() => m.points.rows(e as never)).toThrow(/points\.rows: expected a point — a vertex view or a point value; make one with point\(…\) — got an edge view; its ends are e\.a and e\.b/);
    expect(() => m.edges.rows(p as never)).toThrow(/edges\.rows: expected an edge — an edge view or an edge value; make one with edge\(…\) — got a vertex view; its edges are p\.edges/);
    expect(m.points.rows(undefined).length).toBe(0);
  });
});

// One pair of words for the plane and for space: the root's.
describe('distance and length on triples and 3D rows', () => {
  const hypot = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  it('measure triples', () => {
    expect(distance([1, 2, 3], [4, 6, 15])).toBeCloseTo(hypot([1, 2, 3], [4, 6, 15]), 12);
    expect(length([3, 4, 12])).toBe(13);
  });

  it('measure mesh point rows directly', () => {
    const [p, q] = box([1, 2, 3]).points;
    expect(distance(p, q)).toBeCloseTo(hypot([p.x, p.y, p.z], [q.x, q.y, q.z]), 12);
    expect(length(p)).toBeCloseTo(Math.hypot(p.x, p.y, p.z), 12);
  });
});

describe('a face knows its chart', () => {
  const extruded = (() => {
    const sheet = plane(2, 2).subdivide(2);
    return sheet.extrude(sheet.faces.filter((f) => Math.abs(f.centroid[0]) < 0.5 && Math.abs(f.centroid[1]) < 0.5), { distance: 0.5 });
  })();
  const meshes = {
    sphere: sphere(1, { segments: 8, rings: 5 }),
    box: box([1, 2, 3]),
    cylinder: cylinder(1, 2, { segments: 8 }),
    cone: cone(1, 2, { segments: 8 }),
    torus: torus(2, 0.5),
    plane: plane(2, 2),
    'extrude of a plane': extruded,
  };

  for (const [name, mesh] of Object.entries(meshes)) {
    it(`${name}: every face carries its corners' chart`, () => {
      expect(mesh.faces.length).toBeGreaterThan(0);
      for (const f of mesh.faces) {
        const chart = (f as { chart?: unknown }).chart;
        expect(typeof chart).toBe('string');
        for (const c of f.corners) expect(c.chart).toBe(chart);
      }
    });
  }

  it('an extruded wall names the side chart', () => {
    const walls = extruded.faces.filter((f) => /:side:/.test(String((f as { chart?: unknown }).chart)));
    expect(walls.length).toBe(8);
  });

  it('a corner write that changes a corner chart leaves the face column', () => {
    const can = cylinder(1, 2, { segments: 8 });
    const changed = can.corners.set('chart', (c) => (c.index === 0 ? 'moved' : c.chart));
    expect(changed.corners.some((c) => c.chart === 'moved')).toBe(true);
    expect(changed.faces.map((f) => (f as { chart?: unknown }).chart)).toEqual(can.faces.map((f) => (f as { chart?: unknown }).chart));
  });
});

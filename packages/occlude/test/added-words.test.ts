/**
 * Four small words the docs audit could not write around: `t.seed`, `rows`
 * taking the views a sketch holds, `distance`/`length` from `occlude/3d`,
 * and the face column `chart`.
 */

import { describe, expect, it } from 'vitest';
import { toolkit, SQ } from './helpers/run.js';
import { connect } from '../src/index.js';
import { box, cone, cylinder, distance, length, plane, sphere, torus, v3 } from '../src/three/api/index.js';

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
  const m = connect.chain([[0, 0], [10, 0], [10, 10], [0, 10], [0, 20]]);

  it('takes one vertex view, a list of views, and views mixed with indices', () => {
    const [a, b, c] = m.points;
    expect(m.points.rows(b).indices).toEqual([1]);
    expect(m.points.rows([c, a]).indices).toEqual([0, 2]);
    expect(m.points.rows([3, b]).indices).toEqual([1, 3]);
    expect(m.points.rows(2).indices).toEqual([2]);
    expect(m.points.rows([0, 1]).indices).toEqual([0, 1]);
  });

  it('takes one edge view, a list of views, and views mixed with indices', () => {
    const [e0, e1, e2] = m.edges;
    expect(m.edges.rows(e1).indices).toEqual([1]);
    expect(m.edges.rows([e2, e0]).indices).toEqual([0, 2]);
    expect(m.edges.rows([3, e1]).indices).toEqual([1, 3]);
    expect(m.edges.rows(0).indices).toEqual([0]);
  });

  it('refuses a view of another material by name', () => {
    const other = connect.chain([[0, 0], [5, 0], [5, 5]]);
    const [p] = other.points, [e] = other.edges;
    expect(() => m.points.rows(p)).toThrow(/points\.rows: that vertex view belongs to another material/);
    expect(() => m.edges.rows([0, e])).toThrow(/edges\.rows: that edge view belongs to another material/);
  });

  it('refuses a view of the other kind by name', () => {
    const [p] = m.points, [e] = m.edges;
    expect(() => m.points.rows(e as never)).toThrow(/points\.rows: expected a row index or a vertex view, got an edge view/);
    expect(() => m.edges.rows(p as never)).toThrow(/edges\.rows: expected a row index or an edge view, got a vertex view/);
    expect(() => m.points.rows(undefined as never)).toThrow(/points\.rows: expected a row index, a view, or a list of them/);
  });
});

describe('distance and length from occlude/3d', () => {
  const hypot = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  it('measure triples', () => {
    expect(distance([1, 2, 3], [4, 6, 15])).toBe(hypot([1, 2, 3], [4, 6, 15]));
    expect(length([3, 4, 12])).toBe(Math.hypot(3, 4, 12));
  });

  it('measure mesh point rows directly', () => {
    const [p, q] = box([1, 2, 3]).points;
    expect(distance(p, q)).toBe(hypot([p.x, p.y, p.z], [q.x, q.y, q.z]));
    expect(length(p)).toBe(Math.hypot(p.x, p.y, p.z));
  });

  it('are the same functions as v3.distance and v3.length', () => {
    expect(distance).toBe(v3.distance);
    expect(length).toBe(v3.length);
  });
});

describe('a face knows its chart', () => {
  const extruded = (() => {
    const sheet = plane(2, 2).subdivide(2);
    return sheet.extrude(sheet.faces.filter((f) => Math.abs(f.center[0]) < 0.5 && Math.abs(f.center[1]) < 0.5), { distance: 0.5 });
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

  it('a cornerAttribute that changes a corner chart leaves the face column', () => {
    const can = cylinder(1, 2, { segments: 8 });
    const changed = can.cornerAttribute('chart', (c) => (c.index === 0 ? 'moved' : c.chart));
    expect(changed.corners.some((c) => c.chart === 'moved')).toBe(true);
    expect(changed.faces.map((f) => (f as { chart?: unknown }).chart)).toEqual(can.faces.map((f) => (f as { chart?: unknown }).chart));
  });
});

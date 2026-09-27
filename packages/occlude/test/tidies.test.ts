/**
 * Four tidies the geometry work left behind (spec 49). None of them changes
 * a drawing:
 *
 * 1. a charted face row's `chart` is typed on every factory that charts;
 * 2–3. one chord helper (`src/chord.ts`) names the chord the way the ink
 *    names it and measures the space's gap, for the ink's `line`, a
 *    tiling's walls and `m.transform` alike — and a tiling's bow is now in
 *    sketch units, with the same rows it had;
 * 4. `rows` on the 3D collections, as `sel.rows` in 2D.
 */

import { describe, expect, it } from 'vitest';
import { box, cone, cylinder, curve, geodesic, mesh, parametric, plane, revolve, sphere, sweep, torus, parametricCurve } from 'occlude/3d';
import { chordMiddle, metricGap } from '../src/chord.js';
import { euclideanSpace, spaceOf, type Space } from '../src/space.js';
import { space } from '../src/index.js';
import { toolkit } from './helpers/run.js';
import type { Selection } from '../src/selection.js';

/** The 3D profile circle, as the parametric curve it always was. */
const circle=(r=1,options:{segments?:number}={})=>parametricCurve(u=>[r*Math.cos(2*Math.PI*u),r*Math.sin(2*Math.PI*u),0],{...options,closed:true});

describe('a charted face row carries a typed chart', () => {
  const factories = {
    plane: plane(),
    box: box(),
    parametric: parametric((u, v) => [u, v, u * v], { cols: 3, rows: 3 }),
    sphere: sphere(),
    geodesic: geodesic(),
    cylinder: cylinder(),
    cone: cone(),
    torus: torus(),
    revolve: revolve(curve([[0, 0, 0], [1, 0, 0], [1, 0, 2]]), { segments: 8 }),
    sweep: sweep(circle(0.2), curve([[0, 0, 0], [0, 0, 1], [1, 0, 2]])),
  };

  it('answers `f.chart` as a string on every factory that charts, and none on a bare mesh', () => {
    for (const made of Object.values(factories)) expect(typeof made.faces.at(0)!.chart).toBe('string');
    // A subdivision carries the chart to every child face.
    expect(sphere().subdivide(1).faces.every((f) => typeof f.chart === 'string' && f.chart.length > 0)).toBe(true);
    const bare = mesh([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 2]]);
    expect(bare.faces.at(0)!.chart).toBeUndefined();
  });

  it('writes a non-empty string chart on every face row of every factory', () => {
    for (const [name, m] of Object.entries(factories)) {
      expect(m.faces.length, name).toBeGreaterThan(0);
      for (const f of m.faces) {
        expect(typeof f.chart, name).toBe('string');
        expect(f.chart.length, name).toBeGreaterThan(0);
      }
    }
  });
});

/** record.ts's chordMiddle before the tidy, copied as the oracle. */
const OLD_POLE_EPS = 1e-9;
function oldChordMiddle(space: Space): (a: readonly [number, number], b: readonly [number, number]) => [number, number] {
  if (!(space.curvature > 0)) return (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const ell = space.radius;
  const cy = space.center[1];
  const period = 2 * Math.PI * ell;
  const onPole = (p: readonly [number, number]): boolean => Math.abs(Math.PI / 2 - Math.abs((p[1] - cy) / ell)) < OLD_POLE_EPS;
  return (a, b) => {
    let u: [number, number] = [a[0], a[1]];
    let v: [number, number] = [b[0] - period * Math.round((b[0] - a[0]) / period), b[1]];
    if (onPole(u)) u = [v[0], u[1]];
    if (onPole(v)) v = [u[0], v[1]];
    return [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  };
}

/** A seeded stream for the pairs: mulberry32. */
function stream(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('one chord helper', () => {
  const center: [number, number] = [37, 61];
  const sphereSpace = spaceOf({ curvature: 1 / 900, center });
  const diskSpace = spaceOf({ curvature: -1 / 400, center, projection: 'klein' });
  const flat = euclideanSpace();
  const close = (got: readonly number[], want: readonly number[]): void => {
    expect(Math.abs(got[0] - want[0])).toBeLessThan(1e-12);
    expect(Math.abs(got[1] - want[1])).toBeLessThan(1e-12);
  };

  it('names a sphere\'s chord as record\'s old chordMiddle did, across the seam and to a pole', () => {
    const ell = sphereSpace.radius;
    const seam = center[0] + Math.PI * ell;
    const north = center[1] + (ell * Math.PI) / 2;
    const south = center[1] - (ell * Math.PI) / 2;
    const pairs: [number, number][][] = [
      [[seam - 3, 70], [seam + 4, 55]],
      [[seam + 4, 55], [seam - 3, 70]],
      [[center[0] - Math.PI * ell + 1, 50], [seam - 2, 52]],
      [[40, north], [80, 70]],
      [[80, 70], [12, north]],
      [[seam - 1, south], [seam + 5, 40]],
      [[20, 30], [50, 90]],
    ];
    const next = chordMiddle(sphereSpace.model);
    const old = oldChordMiddle(sphereSpace);
    for (const [a, b] of pairs) close(next(a, b), old(a, b));
  });

  it('is the plain average on the hyperbolic and flat doors', () => {
    const r = stream(7);
    for (const door of [diskSpace.model, flat.model]) {
      const middle = chordMiddle(door);
      for (let i = 0; i < 20; i++) {
        const a: [number, number] = [r() * 200 - 60, r() * 200 - 40];
        const b: [number, number] = [r() * 200 - 60, r() * 200 - 40];
        expect(middle(a, b)).toEqual([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      }
    }
  });

  it('measures the space\'s own distance, and the plane\'s', () => {
    const r = stream(42);
    const pair = (): [[number, number], [number, number]] => [
      [center[0] + (r() - 0.5) * 120, center[1] + (r() - 0.5) * 80],
      [center[0] + (r() - 0.5) * 120, center[1] + (r() - 0.5) * 80],
    ];
    for (const sp of [sphereSpace, diskSpace]) {
      const gap = metricGap(sp.model);
      for (let i = 0; i < 100; i++) {
        const [p, q] = pair();
        expect(Math.abs(gap(p, q) - sp.distance(p, q))).toBeLessThan(1e-12);
      }
    }
    const gap = metricGap(flat.model);
    for (let i = 0; i < 100; i++) {
      const [p, q] = pair();
      expect(gap(p, q)).toBe(Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
  });
});

describe('a tiling\'s bow in sketch units keeps its rows', () => {
  /** A tiling's rows as numbers: counts, full-precision coordinate sums, an
   * FNV-1a hash of every row at 1e-9 and every edge, and five rows. */
  const digest = (tl: { n: number; x: Float64Array; y: Float64Array; edgeList: Uint32Array }) => {
    let h = 0x811c9dc5;
    const mix = (v: number): void => {
      for (const c of String(v)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
      h = Math.imul(h ^ 44, 16777619) >>> 0;
    };
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < tl.n; i++) {
      sx += tl.x[i];
      sy += tl.y[i];
      mix(Math.round(tl.x[i] * 1e9));
      mix(Math.round(tl.y[i] * 1e9));
    }
    for (const e of tl.edgeList) mix(e);
    return { n: tl.n, edges: tl.edgeList.length / 2, sx, sy, hash: h, rows: [0, 1, 7, Math.floor(tl.n / 2), tl.n - 1].map((i) => [i, tl.x[i], tl.y[i]]) };
  };

  // Written from the code BEFORE the tidy (walls judged in model radians
  // against `geodesicBow·√|K|`), on the default test sheet.
  it('{5, 4} under klein', () => {
    const t = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 40 }), projection: 'klein' });
    expect(digest(t.tiling(5, 4))).toEqual({
      n: 5695, edges: 5755, sx: 279146.42148880986, sy: 284750.0000000013, hash: 2129825969,
      rows: [[0, 66.84964162924015, 50], [1, 54.312248371116596, 66.16921667511886], [7, 79.38703488736371, 66.16921667511889], [2847, 106.37423982357811, 37.642920012317106], [5694, 64.24068238034995, -3.385829220910459]],
    });
  });

  it('{3, 5} on the sphere', () => {
    const t = toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) });
    expect(digest(t.tiling(3, 5))).toEqual({
      n: 758, edges: 776, sx: 37723.3729102589, sy: 37900, hash: 1022704999,
      rows: [[0, 69.57074419353103, 50], [1, 39.05408515659552, 66.60723076691136], [7, 102.78520572735371, 49.99999999999999], [379, -2.593700516515078, 24.796230454020343], [757, 134.4546021621827, 33.72342667829642]],
    });
  });
});

describe('rows on the 3D collections', () => {
  const m = box().subdivide(1);

  it('takes a row or a list of rows, as rows of the state — never a row number', () => {
    for (const all of [m.points, m.edges, m.faces] as Selection<{ readonly id: string; readonly index: number }>[]) {
      const some = all.filter((r) => r.index % 3 === 1);
      const pick = some.at(2)!;
      expect(all.rows(pick).map((r) => r.index)).toEqual([pick.index]);
      // Rows of the state, not members of the selection; a repeat keeps
      // its first place, and the order given is the selection's order.
      const [a, b] = [all.at(5)!, all.at(0)!];
      expect(some.rows([a, b, a]).map((r) => r.index)).toEqual([5, 0]);
      expect(some.rows([pick, b, some.at(0)!]).map((r) => r.index)).toEqual([pick.index, 0, some.at(0)!.index]);
      expect(all.rows(new Set([all.at(3)!, all.at(2)!])).map((r) => r.index)).toEqual([3, 2]);
      expect(all.rows([]).length).toBe(0);
      expect(() => all.rows(pick.index as never)).toThrow(/rows: expected an? \w+ row, or a list of them — got the number/);
    }
  });

  it('is the rows of the state, not a part of the group: no key', () => {
    const [group] = m.faces.groupBy((f) => f.chart);
    expect(group.rows(m.faces.at(0)!).key).toBeUndefined();
  });

  it('reads a row of another revision by id, and refuses another domain and an index out of range', () => {
    // A row of another state of the same rows resolves to its row here.
    const later = m.translate([0, 0, 1]);
    expect(m.faces.rows(later.faces.at(0)!).at(0)!.index).toBe(0);
    expect(m.points.rows([m.points.at(0)!, later.points.at(0)!]).length).toBe(1);
    expect(m.edges.rows(later.edges.at(1)!).at(0)!.index).toBe(1);
    // Another construction of the same box is another geometry: its rows are
    // not rows of this one.
    const other = box().subdivide(1);
    expect(() => m.faces.rows(other.faces.at(0)!)).toThrow(/faces\.rows: that face is a row of an unrelated material/);
    // @ts-expect-error a point row is not a face row
    expect(() => m.faces.rows(m.points.at(0)!)).toThrow('faces.rows: expected a face view — got a vertex view');
    // The engine's door by number refuses a number that is not a row.
    const n = m.faces.length;
    expect(() => m.faces.rowsAt([n])).toThrow(`faces.rowsAt: no face ${n} in this state (${n} rows)`);
    expect(() => m.points.rowsAt([-1])).toThrow('points.rowsAt: no point -1');
    expect(() => m.edges.rowsAt([1.5])).toThrow('edges.rowsAt: no edge 1.5');
  });
});

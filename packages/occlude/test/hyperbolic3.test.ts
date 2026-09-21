/**
 * Hyperbolic SPACE in the Beltrami–Klein ball.
 *
 * The Lorentz record and its makers are INTERNAL — `hyperbolicSpace.ts` —
 * and this file is the proof that the maths they carry did not change with
 * the consolidation. The three words a sketch actually writes are the
 * interim 3D ones, `honeycomb`, `observer` and `geodesic3`, and they have
 * a describe of their own at the end.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { mesh, polyline, view, perspective, honeycomb as honeycomb3, observer, geodesic3 } from 'occlude/3d';
import { compileSketchAsync, evalPrim, initOcclude, mm, pen, render, sketchAsync, strokes } from '../src/index.js';
import {
  lorentz, boost, rotation, reflection, apply, compose, inverse, distance, geodesic, polyhedron, honeycomb, camera,
  type Lorentz,
} from '../src/hyperbolicSpace.js';

beforeAll(async () => initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));

type Vec3 = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];
/** The Minkowski form the whole model is written in. */
const form = (a: Vec4, b: Vec4): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] - a[3] * b[3];
/** A Klein point on the unit hyperboloid. */
const lift = (p: Vec3): Vec4 => {
  const s = 1 / Math.sqrt(1 - (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]));
  return [p[0] * s, p[1] * s, p[2] * s, s];
};
const away = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A reproducible stream, so a failure is the same failure the next time. */
function* uniform(seed: number): Generator<number> {
  let s = seed >>> 0;
  for (;;) {
    s = (s * 1664525 + 1013904223) >>> 0;
    yield s / 4294967296;
  }
}
function ballPoints(n: number, seed = 11, rMax = 0.97): Vec3[] {
  const u = uniform(seed);
  return Array.from({ length: n }, () => {
    const r = rMax * Math.cbrt(u.next().value as number);
    const z = 2 * (u.next().value as number) - 1;
    const th = 2 * Math.PI * (u.next().value as number);
    const s = Math.sqrt(1 - z * z);
    return [r * s * Math.cos(th), r * s * Math.sin(th), r * z] as Vec3;
  });
}

const someTransforms = (): Lorentz[] => [
  boost(0.3, -0.2, 0.15),
  rotation('z', 37),
  rotation([1, 2, -0.5], -115),
  reflection([[0.4, 0, 0], [0.4, 0.3, 0.1], [0.4, -0.2, 0.5]]),
  compose(boost(-0.6, 0.1, 0.24), rotation('x', 61)),
  compose(reflection([[0.1, 0.2, 0], [-0.3, 0.1, 0.4], [0.2, -0.5, 0.1]]), boost(0.2, 0.44, -0.3)),
];

describe('lorentz records', () => {
  it('keep the Minkowski form, the ball, and every hyperbolic distance', () => {
    for (const m of someTransforms()) {
      for (const p of ballPoints(200)) {
        const X = lift(p);
        const image = apply(m, p) as Vec3;
        expect(Math.hypot(...image)).toBeLessThan(1);
        const Y = lift(image);
        expect(form(Y, Y)).toBeCloseTo(form(X, X), 9);
      }
      const a: Vec3 = [0.1, 0.2, 0.3];
      const b: Vec3 = [-0.45, 0.05, 0.6];
      expect(distance(apply(m, a) as Vec3, apply(m, b) as Vec3)).toBeCloseTo(distance(a, b), 9);
    }
  });

  it('undo themselves and compose as matrices do', () => {
    for (const m of someTransforms()) {
      for (const p of ballPoints(20, 5)) {
        expect(away(apply(compose(inverse(m), m), p) as Vec3, p)).toBeLessThan(1e-9);
        expect(away(apply(compose(m, inverse(m)), p) as Vec3, p)).toBeLessThan(1e-9);
      }
    }
    const [a, b] = [boost(0.2, 0.1, -0.3), rotation('y', 44)];
    for (const p of ballPoints(20, 9)) {
      expect(away(apply(compose(a, b), p) as Vec3, apply(a, apply(b, p) as Vec3) as Vec3)).toBeLessThan(1e-12);
    }
  });

  it('read the mirror from the determinant, and refuse a matrix that is not an isometry', () => {
    expect(boost(0.3, 0, 0).mirror).toBe(false);
    expect(rotation('z', 30).mirror).toBe(false);
    const flip = reflection([[0.3, 0, 0], [0.3, 0.2, 0], [0.3, 0, 0.2]]);
    expect(flip.mirror).toBe(true);
    expect(compose(flip, flip).mirror).toBe(false);
    expect(inverse(flip).mirror).toBe(true);
    // A reflection is its own inverse.
    for (const p of ballPoints(10, 3)) expect(away(apply(compose(flip, flip), p) as Vec3, p)).toBeLessThan(1e-9);
    expect(lorentz(boost(0.1, 0.2, 0.3).matrix).mirror).toBe(false);
    expect(lorentz(flip.matrix).mirror).toBe(true);
    const scaled = boost(0.1, 0.2, 0.3).matrix.map((v) => v * 2);
    expect(() => lorentz(scaled)).toThrow('does not preserve');
    expect(() => lorentz([1, 2, 3])).toThrow('sixteen finite numbers');
    // Every spatial sign flipped keeps the form but turns the future sheet over.
    expect(() => lorentz([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1])).toThrow('future sheet');
  });

  it('moves the centre of the ball to the boost it names, and refuses a point outside', () => {
    for (const p of ballPoints(30, 17, 0.995)) expect(away(apply(boost(...(p as [number, number, number])), [0, 0, 0]) as Vec3, p)).toBeLessThan(1e-12);
    expect(() => boost(0.8, 0.8, 0)).toThrow('not inside the unit ball');
    expect(() => reflection([[0.1, 0, 0], [0.2, 0, 0], [0.3, 0, 0]])).toThrow('one line');
    expect(() => reflection([[2, 0, 0], [2, 1, 0], [2, 0, 1]])).toThrow('does not cut the unit ball');
    // A plane through the centre is a hyperbolic plane like any other.
    expect(reflection([[0, 0, 0], [1, 0, 0], [0, 1, 0]]).mirror).toBe(true);
  });
});

describe('geodesic', () => {
  it('runs straight in Klein coordinates and evenly in hyperbolic length', () => {
    for (const [a, b] of [[[-0.8, 0.1, 0], [0.7, 0.4, 0.2]], [[0.02, -0.03, 0.05], [-0.9, -0.3, 0.25]]] as [Vec3, Vec3][]) {
      const g = geodesic(a, b, { count: 12 }) as Vec3[];
      expect(g.length).toBe(13);
      expect(away(g[0], a)).toBe(0);
      expect(away(g[12], b)).toBe(0);
      const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      for (const p of g) {
        const w: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
        expect(Math.hypot(w[1] * d[2] - w[2] * d[1], w[2] * d[0] - w[0] * d[2], w[0] * d[1] - w[1] * d[0])).toBeLessThan(1e-9);
      }
      const steps = g.slice(1).map((p, i) => distance(g[i], p));
      for (const s of steps) expect(s).toBeCloseTo(distance(a, b) / 12, 9);
    }
    // The same two points are one place, whatever the count.
    expect(geodesic([0.2, 0.2, 0.2], [0.2, 0.2, 0.2], { count: 8 }).length).toBe(2);
    expect(geodesic([0, 0, 0], [0.5, 0, 0], { count: 0 })).toEqual([]);
  });
});

describe('polyhedron', () => {
  const cases: [number, number, number, number, number, number][] = [
    // p, q, r, vertices, faces, corners per face
    [4, 3, 5, 8, 6, 4],
    [5, 3, 4, 20, 12, 5],
    [3, 5, 3, 12, 20, 3],
    [5, 3, 5, 20, 12, 5],
  ];
  it('builds the four compact cells, with every vertex at one distance and the dihedral angle 2π/r', () => {
    for (const [p, q, r, points, faces, corners] of cases) {
      const cell = polyhedron(p, q, r);
      expect(cell.points.length).toBe(points);
      expect(cell.faces.length).toBe(faces);
      expect(new Set(cell.faces.map((f) => f.length))).toEqual(new Set([corners]));
      // Every vertex index is used q times: q faces meet at a vertex.
      const uses = new Map<number, number>();
      for (const f of cell.faces) for (const i of f) uses.set(i, (uses.get(i) ?? 0) + 1);
      expect([...uses.values()]).toEqual(Array.from({ length: points }, () => q));
      const radii = cell.points.map((v) => distance([0, 0, 0], v as Vec3));
      expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-12);
      expect(radii[0]).toBeGreaterThan(0);
      // The outward unit spacelike normal of each face, from the plane it
      // spans: the faces are flat, because a hyperbolic plane is flat here.
      const normals = cell.faces.map((f) => {
        const [a, b, c] = [cell.points[f[0]], cell.points[f[1]], cell.points[f[2]]];
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const raw = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(...raw);
        const u = raw.map((v) => v / l);
        const off = u[0] * a[0] + u[1] * a[1] + u[2] * a[2];
        const s = (off < 0 ? -1 : 1) / Math.sqrt(1 - off * off);
        // Every vertex of the face must lie on the plane.
        for (const i of f) expect(u[0] * cell.points[i][0] + u[1] * cell.points[i][1] + u[2] * cell.points[i][2]).toBeCloseTo(off, 12);
        return [u[0] * s, u[1] * s, u[2] * s, Math.abs(off) * Math.abs(s)] as Vec4;
      });
      let pairs = 0;
      for (let i = 0; i < cell.faces.length; i++) {
        for (let j = i + 1; j < cell.faces.length; j++) {
          if (cell.faces[i].filter((v) => cell.faces[j].includes(v)).length !== 2) continue;
          pairs++;
          expect(Math.acos(Math.max(-1, Math.min(1, -form(normals[i], normals[j]))))).toBeCloseTo((2 * Math.PI) / r, 9);
        }
      }
      // Every edge of the cell is one adjacent pair of faces.
      expect(pairs).toBe((points * q) / 2);
    }
  });

  it('refuses every other {p, q, r} by the geometry it belongs to', () => {
    expect(() => polyhedron(4, 3, 4)).toThrow('EUCLIDEAN');
    expect(() => polyhedron(3, 3, 3)).toThrow('SPHERICAL');
    expect(() => polyhedron(3, 3, 5)).toThrow('SPHERICAL');
    expect(() => polyhedron(3, 4, 3)).toThrow('SPHERICAL');
    expect(() => polyhedron(6, 3, 3)).toThrow('NOT compact');
    expect(() => polyhedron(4, 3, 5.5)).toThrow('whole number');
    expect(() => polyhedron(2, 3, 5)).toThrow('whole number');
    for (const message of ['{4, 3, 5}', '{5, 3, 4}', '{3, 5, 3}', '{5, 3, 5}']) {
      expect(() => polyhedron(4, 3, 4)).toThrow(message);
    }
  });

  it('is an ordinary mesh, faces and all', () => {
    const cell = polyhedron(5, 3, 4);
    const m = mesh(cell.points as [number, number, number][], cell.faces);
    expect(m.points.length).toBe(20);
    expect(m.faces.length).toBe(12);
    expect(m.edges.length).toBe(30);
  });
});

describe('honeycomb', () => {
  it('reflects the cell into its neighbours, once each', () => {
    expect(honeycomb(4, 3, 5, { depth: 0 }).length).toBe(1);
    const cells = honeycomb(4, 3, 5, { depth: 1 });
    expect(cells.length).toBe(7);
    expect(cells[0].matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const centres = cells.map((m) => apply(m, [0, 0, 0]) as Vec3);
    expect(away(centres[0], [0, 0, 0])).toBe(0);
    for (const c of centres) expect(Math.hypot(...c)).toBeLessThan(1);
    for (let i = 0; i < centres.length; i++) {
      for (let j = i + 1; j < centres.length; j++) expect(away(centres[i], centres[j])).toBeGreaterThan(1e-6);
    }
    // A neighbour's centre is the cell's centre reflected in a wall, so it
    // is twice the in-radius away: the wall is halfway between the two.
    const cell = polyhedron(4, 3, 5);
    const f = cell.faces[0];
    const [a, b, c] = [cell.points[f[0]], cell.points[f[1]], cell.points[f[2]]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const raw = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...raw);
    const inradius = Math.atanh(Math.abs((raw[0] * a[0] + raw[1] * a[1] + raw[2] * a[2]) / l));
    for (const centre of centres.slice(1)) expect(distance([0, 0, 0], centre)).toBeCloseTo(2 * inradius, 9);
    // The reflections are odd, and the next generation is even again.
    expect(cells.slice(1).every((m) => m.mirror)).toBe(true);
    expect(honeycomb(4, 3, 5, { depth: 2 }).length).toBe(37);
    expect(honeycomb(5, 3, 4, { depth: 1 }).length).toBe(13);
    expect(honeycomb(3, 5, 3, { depth: 1 }).length).toBe(21);
    expect(honeycomb(4, 3, 5, { depth: -1 })).toEqual([]);
    expect(() => honeycomb(4, 3, 4)).toThrow('EUCLIDEAN');
  });
});

describe('camera', () => {
  it('puts the eye at the centre and the target on the view axis', () => {
    const eye: Vec3 = [0.2, -0.1, 0.05];
    const target: Vec3 = [0.5, 0.4, 0.1];
    for (const up of [undefined, [0, 0, 1], [0.3, 0.2, 1]] as (Vec3 | undefined)[]) {
      const cam = camera(eye, target, up ? { up } : {});
      const home = apply(cam, eye) as Vec3;
      expect(Math.hypot(...home)).toBeLessThan(1e-12);
      const aim = apply(cam, target) as Vec3;
      expect(aim[1]).toBeGreaterThan(0);
      expect(Math.hypot(aim[0], aim[2])).toBeLessThan(1e-12);
      // The frame is a proper one: no reflection, and distances are kept.
      expect(cam.mirror).toBe(false);
      expect(distance(eye, target)).toBeCloseTo(distance([0, 0, 0], aim), 12);
    }
    // Up decides the roll: the world's up lands on +Z.
    const level = camera([0, 0, 0], [0.6, 0, 0]);
    expect(apply(level, [0, 0, 0.4])[2]).toBeGreaterThan(0.39);
    expect(() => camera([0.1, 0, 0], [0.1, 0, 0])).toThrow('no direction of view');
    expect(() => camera([0, 0, 0], [0, 0, 0.5])).toThrow('line of sight');
  });
});

describe('a honeycomb on paper', () => {
  it('renders a depth-1 {4, 3, 5} through the 3D view, inside its drawable', async () => {
    const definition = sketchAsync({ aspect: [1, 1], seed: 42, pens: { ink: pen({ width: mm(0.25) }) } }, async () => {
      const { cell, placements } = honeycomb3(4, 3, 5, { depth: 1 });
      const edges = cell.faces.flatMap((f) => f.map((a, i) => [a, f[(i + 1) % f.length]]).filter(([a, b]) => a < b));
      const eye = observer([0.05, -0.08, 0.1], [0.8, 0, 0]);
      const wires = placements.flatMap((place) => {
        const seen = cell.points.map((p) => eye(place(p as Vec3)));
        return edges.map(([a, b]) => polyline(geodesic3(seen[a], seen[b], { count: 8 }) as [number, number, number][]));
      });
      return view(wires, { camera: perspective({ eye: [0, 0, 0], target: [0, 1, 0], fovDegrees: 100, near: 0.01 }), stroke: 'ink' }, (lines) => {
        const r = lines.visible.source.frame.paper;
        const held = (p: readonly [number, number]): boolean => p[0] >= r.x && p[0] <= r.x + r.width && p[1] >= r.y && p[1] <= r.y + r.height;
        return strokes(lines.visible.filter((c) => held(c.a) && held(c.b)), { stroke: 'ink' });
      });
    });
    const out = render(await compileSketchAsync(definition), { paper: { w: 148, h: 148 }, marginPct: 5 });
    expect(out.stats.fragments).toBeGreaterThan(0);
    const x0 = out.frame.offsetX;
    const y0 = out.frame.offsetY;
    const off = out.frags.filter((frag) => {
      const [x, y] = evalPrim(frag.geom, 0.5);
      return x < x0 - 0.5 || x > x0 + out.frame.inner.innerW + 0.5 || y < y0 - 0.5 || y > y0 + out.frame.inner.innerH + 0.5;
    }).length;
    expect(off).toBe(0);
  });
});

describe('the interim 3D words', () => {
  it('hands the cell and its placements as point maps, the identity first', () => {
    const { cell, placements } = honeycomb3(4, 3, 5, { depth: 2 });
    // The counts the records have always answered with.
    expect(placements.length).toBe(37);
    expect(honeycomb3(4, 3, 5, { depth: 0 }).placements.length).toBe(1);
    expect(honeycomb3(4, 3, 5, { depth: 1 }).placements.length).toBe(7);
    expect(honeycomb3(5, 3, 4, { depth: 1 }).placements.length).toBe(13);
    expect(honeycomb3(3, 5, 3, { depth: 1 }).placements.length).toBe(21);
    expect(() => honeycomb3(4, 3, 4)).toThrow('EUCLIDEAN');
    // The cell is the same mesh `polyhedron` builds, and the first
    // placement leaves it where it is.
    expect(cell.points).toEqual(polyhedron(4, 3, 5).points);
    expect(cell.faces).toEqual(polyhedron(4, 3, 5).faces);
    for (const p of cell.points) expect(away(placements[0](p as Vec3), p as Vec3)).toBeLessThan(1e-12);
    // Every placement is an isometry: it keeps every hyperbolic length.
    const probe = ballPoints(8, 3, 0.4);
    for (const place of placements.slice(0, 8)) {
      for (let i = 0; i + 1 < probe.length; i += 2) {
        expect(distance(place(probe[i]), place(probe[i + 1]))).toBeCloseTo(distance(probe[i], probe[i + 1]), 9);
      }
    }
  });

  it('puts the observer at the centre of the ball, looking down +Y', () => {
    const eye: Vec3 = [0.2, -0.1, 0.05];
    const target: Vec3 = [0.5, 0.4, 0.1];
    const look = observer(eye, target);
    expect(Math.hypot(...look(eye))).toBeLessThan(1e-12);
    const aim = look(target);
    expect(aim[1]).toBeGreaterThan(0);
    expect(Math.hypot(aim[0], aim[2])).toBeLessThan(1e-12);
    expect(distance(eye, target)).toBeCloseTo(distance([0, 0, 0], aim), 12);
    // The world's up lands on +Z, and `up` along the line of sight names
    // no frame.
    expect(observer([0, 0, 0], [0.6, 0, 0])([0, 0, 0.4])[2]).toBeGreaterThan(0.39);
    expect(() => observer([0, 0, 0], [0, 0, 0.5])).toThrow('line of sight');
  });

  it('samples a chord by hyperbolic length, ends exact', () => {
    const a: Vec3 = [-0.2, 0.1, 0];
    const b: Vec3 = [0.85, -0.3, 0.2];
    const pts = geodesic3(a, b, { count: 8 });
    expect(pts.length).toBe(9);
    expect(away(pts[0], a)).toBeLessThan(1e-12);
    expect(away(pts[8], b)).toBeLessThan(1e-12);
    const step = distance(a, b) / 8;
    for (let k = 0; k < 8; k++) expect(distance(pts[k], pts[k + 1])).toBeCloseTo(step, 9);
  });
});

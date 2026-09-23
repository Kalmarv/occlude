/**
 * The honeycomb is geometry: one cell complex with shared vertices, each
 * wall once and each edge once, its copies as `Placement3` values, and its
 * edges as two-point wires that `transform` moves exactly.
 *
 * A honeycomb is a 3-complex, not a surface — `r` walls meet at an edge —
 * so it is not a `Mesh`; these tests read it through `points`, `faces`,
 * `wires`, `cell` and `placements`.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { honeycomb, observer, isPlacement3, view, perspective, type Honeycomb, type Placement3, type Vec3 } from 'occlude/3d';
import { clip, compileSketchAsync, initOcclude, mm, pen, rect, render, sketchAsync, strokes } from '../src/index.js';
import { identity } from '../src/placement.js';
import { spaceOf } from '../src/space.js';

beforeAll(async () => initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));

const away = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const xyz = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];

/** Every corner of every copy as an index into `h.points`, found by
 * position and never by the kernel's own key. */
function corners(h: Honeycomb): number[][] {
  const cell = h.cell.points.map(xyz);
  return h.placements.map((place) => cell.map((p) => {
    const image = place.point(p);
    let best = -1;
    let d = Infinity;
    for (const q of h.points) {
      const e = away(image, xyz(q));
      if (e < d) { d = e; best = q.index; }
    }
    expect(d).toBeLessThan(1e-9);
    return best;
  }));
}

/** Flood generation, worked out independently: breadth-first distance from
 * the room over copies that share a wall. */
function distances(h: Honeycomb, at: number[][]): number[] {
  const walls = new Map<string, number[]>();
  const loops = h.cell.faces.map((f) => f.vertices);
  at.forEach((c, k) => {
    for (const f of loops) {
      const key = f.map((j) => c[j]).sort((a, b) => a - b).join(',');
      walls.set(key, [...(walls.get(key) ?? []), k]);
    }
  });
  const out = at.map(() => Infinity);
  out[0] = 0;
  const queue = [0];
  while (queue.length) {
    const k = queue.shift()!;
    for (const f of loops) {
      const key = f.map((j) => at[k][j]).sort((a, b) => a - b).join(',');
      for (const n of walls.get(key)!) if (out[n] === Infinity) { out[n] = out[k] + 1; queue.push(n); }
    }
  }
  return out;
}

describe('the {5, 3, 4} honeycomb as a complex', () => {
  const counts = { 1: { placements: 13, points: 200, faces: 144, edges: 330 }, 2: { placements: 115, points: 1640, faces: 1236, edges: 2760 } } as const;

  for (const depth of [1, 2] as const) {
    it(`depth ${depth}: shared vertices, each wall once, each edge once`, () => {
      const h = honeycomb(5, 3, 4, { depth });
      const want = counts[depth];
      expect(h.placements.length).toBe(want.placements);
      expect(h.points.length).toBe(want.points);
      expect(h.faces.length).toBe(want.faces);
      expect(h.wires.edges.length).toBe(want.edges);
      // A ball-shaped patch of a 3-complex is contractible, so its Euler
      // characteristic V − E + F − C is 1.
      expect(h.points.length - h.wires.edges.length + h.faces.length - h.placements.length).toBe(1);

      const walls = new Set(h.faces.map((f) => [...f.vertices].sort((a, b) => a - b).join(',')));
      expect(walls.size).toBe(h.faces.length);
      const pairs = new Set(h.wires.edges.map((e) => [...e.vertices].sort((a, b) => a - b).join(',')));
      expect(pairs.size).toBe(h.wires.edges.length);

      // Every corner of every copy is a shared vertex, to 1e-9.
      const at = corners(h);
      const faceOf = new Map(h.faces.map((f) => [[...f.vertices].sort((a, b) => a - b).join(','), f]));
      const gen = distances(h, at);
      const loops = h.cell.faces.map((f) => f.vertices);
      const lowest = new Map<string, number>();
      at.forEach((c, k) => {
        for (const f of loops) {
          const key = f.map((j) => c[j]).sort((a, b) => a - b).join(',');
          expect(faceOf.has(key)).toBe(true);
          if (!lowest.has(key)) lowest.set(key, k);
        }
      });
      for (const f of h.faces) {
        const key = [...f.vertices].sort((a, b) => a - b).join(',');
        expect(f.cell).toBe(lowest.get(key));
        expect(f.generation).toBe(gen[f.cell]);
        expect(f.mirrored).toBe(h.placements[f.cell].orientation < 0);
      }
      // A reflection turns space over: odd generations are mirrored.
      for (const f of h.faces) expect(f.mirrored).toBe(f.generation % 2 === 1);

      // Each edge's columns are the lowest copy that has it and that copy's
      // generation, which is the lowest generation among its walls.
      const edgeCell = new Map<string, number>();
      at.forEach((c, k) => {
        for (const f of loops) {
          for (let i = 0; i < f.length; i++) {
            const key = [c[f[i]], c[f[(i + 1) % f.length]]].sort((a, b) => a - b).join(',');
            if (!edgeCell.has(key)) edgeCell.set(key, k);
          }
        }
      });
      for (const e of h.wires.edges) {
        const key = [...e.vertices].sort((a, b) => a - b).join(',');
        expect(e.cell).toBe(edgeCell.get(key));
        expect(e.generation).toBe(gen[e.cell]);
      }
    });
  }

  it('hands the identity first and the flood in generation order', () => {
    const h = honeycomb(5, 3, 4, { depth: 2 });
    for (const p of h.cell.points) expect(away(h.placements[0].point(xyz(p)), xyz(p))).toBe(0);
    expect(h.placements[0].orientation).toBe(1);
    const gens = h.faces.map((f) => f.generation);
    expect(gens).toEqual([...gens].sort((a, b) => a - b));
    expect(h.cell.faces.length).toBe(12);
    expect(h.cell.edges.length).toBe(30);
  });

  it('draws each edge as one two-point wire, points shared with the complex', () => {
    const h = honeycomb(5, 3, 4, { depth: 1 });
    expect(h.wires.points.length).toBe(h.points.length);
    h.wires.points.map((p, i) => {
      expect(p.id).toBe(h.points[i].id);
      expect([p.x, p.y, p.z]).toEqual(xyz(h.points[i]));
    });
    for (const e of h.wires.edges) {
      expect(e.vertices.length).toBe(2);
      expect(Number.isInteger(e.cell) && Number.isInteger(e.generation)).toBe(true);
    }
    expect(h.wires.edges.filter((e) => e.generation === 0).length).toBe(30);
  });

  it('keeps depth and refusals', () => {
    expect(honeycomb(5, 3, 4, { depth: 0 }).placements.length).toBe(1);
    expect(honeycomb(5, 3, 4, { depth: 0 }).faces.length).toBe(12);
    const none = honeycomb(5, 3, 4, { depth: -1 });
    expect(none.placements.length).toBe(0);
    expect(none.wires.edges.length).toBe(0);
    expect(() => honeycomb(4, 3, 4)).toThrow('EUCLIDEAN');
    expect(() => honeycomb(3, 3, 5)).toThrow('SPHERICAL');
  });
});

describe('Placement3', () => {
  const h = honeycomb(4, 3, 5, { depth: 2 });
  const some: Placement3[] = [h.placements[1], h.placements[5], h.placements[20], observer([0.2, -0.1, 0.05], [0.5, 0.4, 0.1])];
  const probe: Vec3[] = [[0.1, 0.2, -0.3], [-0.4, 0.05, 0.2], [0.3, -0.3, 0.1]];

  it('composes with then, undoes with inverse, multiplies orientation', () => {
    for (const a of some) {
      for (const b of some) {
        const ab = a.then(b);
        for (const p of probe) expect(away(ab.point(p), b.point(a.point(p)))).toBeLessThan(1e-9);
        expect(ab.orientation).toBe(a.orientation * b.orientation);
      }
      for (const p of probe) {
        expect(away(a.then(a.inverse()).point(p), p)).toBeLessThan(1e-9);
        expect(away(a.inverse().then(a).point(p), p)).toBeLessThan(1e-9);
        expect(away(a.inverse().inverse().point(p), a.point(p))).toBeLessThan(1e-9);
      }
      expect(a.inverse().orientation).toBe(a.orientation);
    }
    // The flood's copies: odd generations turn space over.
    expect(h.placements[1].orientation).toBe(-1);
  });

  it('is structural, and a 2D placement is not one', () => {
    for (const a of some) expect(isPlacement3(a)).toBe(true);
    expect(isPlacement3(identity(spaceOf({ curvature: 0 }).model))).toBe(false);
    expect(isPlacement3((p: Vec3) => p)).toBe(false);
    expect(() => some[0].then({ orientation: 1, point: (p: Vec3) => p, then: () => some[0], inverse: () => some[0] })).toThrow('expected a Placement3');
  });

  it('puts the observer eye at the origin and the target on +Y', () => {
    const eye: Vec3 = [0.2, -0.1, 0.05];
    const target: Vec3 = [0.5, 0.4, 0.1];
    const seen = observer(eye, target);
    expect(Math.hypot(...seen.point(eye))).toBeLessThan(1e-12);
    const aim = seen.point(target);
    expect(aim[1]).toBeGreaterThan(0);
    expect(Math.hypot(aim[0], aim[2])).toBeLessThan(1e-12);
    expect(seen.orientation).toBe(1);
  });
});

describe('transform', () => {
  it('moves wires by point and keeps every id and column', () => {
    const h = honeycomb(5, 3, 4, { depth: 1 });
    const seen = observer([0.05, -0.08, 0.1], [0.8, 0, 0]);
    const moved = h.wires.transform(seen);
    expect(moved.points.map((p) => p.id)).toEqual(h.wires.points.map((p) => p.id));
    h.wires.points.map((p, i) => expect(away(xyz(moved.points.at(i)!), seen.point(xyz(p)))).toBe(0));
    expect(moved.edges.map((e) => [e.id, e.vertices, e.cell, e.generation])).toEqual(h.wires.edges.map((e) => [e.id, e.vertices, e.cell, e.generation]));
  });

  it('moves a mesh by point, keeps ids and columns, and rewinds a mirror', () => {
    const h = honeycomb(5, 3, 4, { depth: 1 });
    const cell = h.cell.faceAttribute('tag', (f) => f.index * 2);
    const flip = h.placements[1];
    expect(flip.orientation).toBe(-1);
    const moved = cell.transform(flip);
    expect(moved.points.map((p) => p.id)).toEqual(cell.points.map((p) => p.id));
    cell.points.map((p, i) => expect(away(xyz(moved.points.at(i)!), flip.point(xyz(p)))).toBe(0));
    expect(moved.faces.map((f) => [f.id, f.tag])).toEqual(cell.faces.map((f) => [f.id, f.tag]));
    // Turned over, so each loop runs backwards and the solid stays wound
    // outward: every normal points away from the moved cell's centre.
    cell.faces.map((f, i) => expect(moved.faces.at(i)!.vertices).toEqual([...f.vertices].reverse()));
    const middle = flip.point([0, 0, 0]);
    for (const f of moved.faces) {
      const out = [f.centroid[0] - middle[0], f.centroid[1] - middle[1], f.centroid[2] - middle[2]];
      expect(out[0] * f.normal[0] + out[1] * f.normal[1] + out[2] * f.normal[2]).toBeGreaterThan(0);
    }
    // Rewound faces are reassembled, so edges keep their ids, not their rows.
    expect(moved.edges.map((e) => e.id).sort()).toEqual(cell.edges.map((e) => e.id).sort());
    // A turn that keeps the hand keeps the winding.
    const kept = cell.transform(h.placements[1].then(h.placements[2]));
    cell.faces.map((f, i) => expect(kept.faces.at(i)!.vertices).toEqual(f.vertices));
  });

  it('refuses what is not a Placement3, by name', () => {
    const h = honeycomb(5, 3, 4, { depth: 0 });
    expect(() => h.wires.transform(((p: Vec3) => p) as never)).toThrow('transform takes a Placement3');
    expect(() => h.cell.transform(identity(spaceOf({ curvature: 0 }).model) as never)).toThrow('transform takes a Placement3');
  });
});

describe('the {5, 3, 4} fence', () => {
  it('compiles through the 3D pipeline, room = the 30 edges of the first copy', async () => {
    const h = honeycomb(5, 3, 4, { depth: 2 });
    const room = h.wires.edges.filter((e) => e.generation === 0);
    const cell = h.cell.points.map(xyz);
    const want = new Set(h.cell.edges.map((e) => [e.a, e.b].map((p) => h.placements[0].point(xyz(p)).map((v) => v.toFixed(9)).join(',')).sort().join('|')));
    const got = new Set(room.map((e) => [e.a, e.b].map((p) => [p.x, p.y, p.z].map((v) => v.toFixed(9)).join(',')).sort().join('|')));
    expect(cell.length).toBe(20);
    expect(room.length).toBe(30);
    expect(got).toEqual(want);

    // The docs fence body, as it stands on the geometry page.
    const definition = sketchAsync({ aspect: [1, 1], pens: {
      ink: pen({ width: mm(0.18), color: '#46505C' }),
      room: pen({ width: mm(0.38), color: '#18202A' }),
    } }, async (t) => {
      const b = t.bounds();
      const c = h.cell.points.at(0)!;
      const toward = (f: { centroid: Vec3 }): number => f.centroid[0] * c.x + f.centroid[1] * c.y + f.centroid[2] * c.z;
      const wall = [...h.cell.faces].reduce((f, g) => (toward(f) < toward(g) ? f : g));
      const seen = observer([c.x * 0.15, c.y * 0.15, c.z * 0.15], wall.centroid, { up: [0.26, 0, 0.97] });
      const camera = perspective({ eye: [0, 0, 0], target: [0, 1, 0], fovDegrees: 100, near: 0.005 });
      return view(h.wires.transform(seen), { camera, pen: 'ink' }, (lines) => clip(rect(0, 0, b.w, b.h), [
        strokes(lines.visible.filter((w) => (w.attributes.generation as number) > 0), { stroke: 'ink' }),
        strokes(lines.visible.filter((w) => w.attributes.generation === 0), { stroke: 'room' }),
      ]));
    });
    const out = render(await compileSketchAsync(definition), { paper: { w: 148, h: 148 }, marginPct: 5 });
    expect(out.stats.fragments).toBeGreaterThan(0);
  });
});

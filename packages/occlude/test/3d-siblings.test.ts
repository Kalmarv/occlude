// Spec 66 (audit N6): 3D says the 2D word where the meaning is the same,
// and the old 3D spelling is refused by name. One block per closed entry;
// the failing lines come from the audit sketches' `// FRICTION` comments.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { initOcclude, renderAsync, sketch, pen, mm, fill, strokes, polygon, material, curve as curve2, box3, PointSelection3, lineArt3, type RenderResult } from '../src/index.js';
import * as three from '../src/three/api/index.js';
import {
  box, plane, sphere, cone, view, style, orthographic, isolines, intersections, trace, sweep, revolve,
  curve, parametricCurve, instanceOnPoints, pointCloud, grad3, curl3, sdf3,
} from '../src/three/api/index.js';
import { sampleSurfaceCurves } from '../src/three/api/curveSampling.js';
import type { ProjectedLines } from '../src/three/api/projected.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

const pens = { ink: pen({ width: mm(0.3), color: '#18202A' }), shade: pen({ width: mm(0.18), color: '#A84932' }), blue: pen({ width: mm(0.2), color: '#2457D6' }) };
const camera = orthographic({ eye: [5, 7, 6], target: [0, 0, 0], span: 6 });
const byPen = (out: RenderResult) => {
  const counts: Record<string, number> = {};
  for (const f of out.frags) counts[out.pens[f.pen].name] = (counts[out.pens[f.pen].name] ?? 0) + 1;
  return counts;
};
const draw = (body: Parameters<typeof sketch>[1]) => renderAsync(sketch({ aspect: [1, 1], pens }, body), { paper: 'Square20' });

describe('G3-23 · pen is the pen word on every 3D option', () => {
  it('draws a view, an object and a hatch recipe in the pens named `pen`', async () => {
    const out = await draw(() => view([box(1.5), sphere(0.6, { pen: 'blue', segments: 12, rings: 6 }).translate([1.6, 0, 0])], {
      camera, pen: 'ink', hatch: { spacing: mm(1.5), angle: 30, pen: 'shade' },
    }));
    const counts = byPen(out);
    expect(counts.ink).toBeGreaterThan(0);
    expect(counts.blue).toBeGreaterThan(0);
    expect(counts.shade).toBeGreaterThan(0);
  });
  it('refuses `stroke` by name wherever a 3D record names a pen', () => {
    const said = /`stroke` is the 2D outline switch — name the pen with `pen`/;
    expect(() => view(box(1), { camera, stroke: 'ink' } as never)).toThrow(said);
    expect(() => view(box(1), { camera, hatch: { spacing: mm(1), stroke: 'ink' } as never })).toThrow(said);
    expect(() => view(box(1), { camera, sections: [{ origin: [0, 0, 0], normal: [0, 0, 1], stroke: 'ink' } as never] })).toThrow(said);
    expect(() => sphere(1, { stroke: 'ink' } as never)).toThrow(said);
    expect(() => style(box(1), { stroke: 'ink' } as never)).toThrow(said);
    expect(() => box(1).style({ stroke: 'ink' } as never)).toThrow(said);
    expect(() => isolines(sphere(1), (p) => p.z, 0, { stroke: 'ink' } as never)).toThrow(said);
    expect(() => intersections(box(1), sphere(0.7), { stroke: 'ink' } as never)).toThrow(said);
    expect(() => curve([[0, 0, 0], [1, 0, 0]], { stroke: 'ink' } as never)).toThrow(said);
  });
  it('keeps the pen on the value as `pen`', () => {
    expect(sphere(1, { pen: 'blue' }).pen).toBe('blue');
    expect(box(1).style({ pen: 'shade' }).pen).toBe('shade');
    expect(isolines(sphere(1), (p) => p.z, 0, { pen: 'blue' }).pen).toBe('blue');
  });
});

describe('G3-18 · a face says centroid, as in 2D', () => {
  it('reads f.centroid on 3D faces and refuses f.center by name', () => {
    const house = box(2);
    // FRICTION G3-18: house.faces.filter((f) => f.centroid[2] > 1.1)
    const top = house.faces.filter((f) => f.centroid[2] > 0.9);
    expect(top.length).toBe(1);
    expect(top.at(0)!.centroid).toEqual([0, 0, 1]);
    expect(() => (top.at(0) as unknown as { center: unknown }).center).toThrow(/`centroid`/);
    // An edge's middle is still `center`, the 2D edge word.
    expect(house.edges.at(0)!.center).toHaveLength(3);
  });
  it('gives an extrude region its centroid', () => {
    const sheet = plane(2, 2).subdivide(1);
    const seen: number[][] = [];
    sheet.extrude(sheet.faces.filter((f) => f.centroid[0] > 0), (r) => { seen.push([...r.centroid]); return [0, 0, 0.5]; });
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBeCloseTo(0.5);
    sheet.extrude(sheet.faces.filter((f) => f.centroid[0] > 0), (r) => {
      expect(() => (r as unknown as { center: unknown }).center).toThrow(/`centroid`/);
      return [0, 0, 0.5];
    });
  });
});

describe('G3-28 · a projected line reads its columns as properties', () => {
  it('answers c.column, the same value as c.attributes.column', async () => {
    let seen: ProjectedLines | undefined;
    await draw(() => view(box(1.5), { camera, hatch: { spacing: mm(2), angle: 30, pen: 'shade' } }, (lines) => { seen = lines; return strokes(lines.visible, { pen: 'ink' }); }));
    const hatch = seen!.visible.kind('hatch');
    expect(hatch.length).toBeGreaterThan(0);
    // FRICTION G3-28: lines.visible.filter((c) => c.attrs.rim !== 1)
    for (const c of hatch) {
      expect(c.hatchFamily).toBe('hatch');
      expect(c.hatchFamily).toBe(c.attributes.hatchFamily);
      expect(c.pen).toBe('shade');
    }
  });
});

describe('G6-14 · 3D isolines take the 2D `at`', () => {
  const ball = sphere(1, { segments: 24, rings: 12 });
  const levels = (c: ReturnType<typeof isolines>) => [...new Set(c.edges.map((e) => e.level))].sort((a, b) => a - b);
  it('reads one level, a list, { count } and { spacing }', () => {
    // FRICTION G6-14: isolines(land, (p) => p.z, levels) and isolines(land, (p) => p.z, 0)
    // (Levels sit off the sphere's vertex rings: a level through a ring of
    // vertices trips the network kernel, an engine matter outside this spec.)
    expect(levels(isolines(ball, (p) => p.z, 0.1))).toEqual([0.1]);
    expect(levels(isolines(ball, (p) => p.z, [-0.45, 0.55]))).toEqual([-0.45, 0.55]);
    expect(levels(isolines(ball, (p) => p.z, { count: 4 })).length).toBe(4);
    expect(levels(isolines(ball, (p) => p.z, { spacing: 0.5, offset: 0.1 }))).toEqual([-0.9, -0.4, 0.1, 0.6]);
  });
  it('refuses the old option words by name', () => {
    expect(() => isolines(ball, (p) => p.z, { levels: [0] } as never)).toThrow(/`levels` is gone/);
    expect(() => isolines(ball, (p) => p.z, { count: 3, key: 'k' } as never)).toThrow(/'key' is an option, not a level/);
    expect(() => isolines(ball, (p) => p.z, { count: 3 }, { count: 3 } as never)).toThrow(/'count' is a level, not an option/);
  });
});

describe('G3-22 · a view hatch takes fill(\'hatch\')', () => {
  it('draws fill(\'hatch\') as the recipe with the same words', async () => {
    const recipe = await draw(() => view(box(1.5), { camera, pen: 'ink', hatch: { spacing: mm(1.2), angle: 45 } }));
    // FRICTION G3-22: hatch: fill('hatch', { angle: 45, spacing: mm(1.2) })
    const filled = await draw(() => view(box(1.5), { camera, pen: 'ink', hatch: fill('hatch', { angle: 45, spacing: mm(1.2) }) }));
    expect(filled.raw.prims).toEqual(recipe.raw.prims);
  });
  it('reads crosshatch as one recipe per angle', async () => {
    const two = await draw(() => view(box(1.5), { camera, pen: 'ink', hatch: [{ spacing: mm(1.2), angle: 0 }, { spacing: mm(1.2), angle: 90 }] }));
    const cross = await draw(() => view(box(1.5), { camera, pen: 'ink', hatch: fill('crosshatch', { angles: [0, 90], spacing: mm(1.2) }) }));
    expect(cross.raw.prims).toEqual(two.raw.prims);
  });
  it('refuses a fill with no reading on a surface, by name', () => {
    expect(() => view(box(1), { camera, hatch: fill('stipple') })).toThrow(/fill\('stipple'\)/);
    expect(() => view(box(1), { camera, hatch: fill('hatch', { angle: 10 }) })).toThrow(/needs a spacing/);
    expect(() => view(box(1), { camera, hatch: fill('hatch', { spacing: mm(1), align: 'shape' }) })).toThrow(/'align' has no reading/);
  });
});

describe('G3-20 · select takes a face selection, and the test sees the mesh row', () => {
  it('hatches the same faces for a selection, sel.has and the plain test', async () => {
    const house = box(2);
    const roof = house.faces.filter((f) => f.normal[2] > 0.5);
    // FRICTION G3-20: hatch: { …, select: roof } and select: (f) => roof.has(f)
    const bySelection = await draw(() => view(house, { camera, pen: 'ink', hatch: { spacing: mm(1), angle: 45, pen: 'shade', select: roof } }));
    const byHas = await draw(() => view(house, { camera, pen: 'ink', hatch: { spacing: mm(1), angle: 45, pen: 'shade', select: (f) => roof.has(f) } }));
    const byTest = await draw(() => view(house, { camera, pen: 'ink', hatch: { spacing: mm(1), angle: 45, pen: 'shade', select: (f) => f.normal[2] > 0.5 } }));
    expect(byPen(bySelection).shade).toBeGreaterThan(0);
    expect(bySelection.raw.prims).toEqual(byTest.raw.prims);
    expect(byHas.raw.prims).toEqual(byTest.raw.prims);
  });
});

describe('G6-17 · an object carries its own hatch, as a polygon carries its fill', () => {
  it('hatches a styled object with its own recipe and the rest with the view\'s', async () => {
    const a = box(1).translate([-1, 0, 0]), b = box(1).translate([1, 0, 0]);
    // FRICTION G6-17: style(b, { hatch: { spacing, angle: 90, stroke: 'hair', select } })
    const own = await draw(() => view([style(a, { hatch: { spacing: mm(1), angle: 90, pen: 'blue' } }), b], { camera, pen: 'ink', hatch: { spacing: mm(1), angle: 0, pen: 'shade' } }));
    const counts = byPen(own);
    expect(counts.blue).toBeGreaterThan(0);
    expect(counts.shade).toBeGreaterThan(0);
    // Styled alone: only its own recipe draws; the view's does not reach it.
    const alone = await draw(() => view([style(a, { hatch: { spacing: mm(1), angle: 90, pen: 'blue' } })], { camera, pen: 'ink', hatch: { spacing: mm(1), angle: 0, pen: 'shade' } }));
    expect(byPen(alone).shade).toBeUndefined();
    expect(byPen(alone).blue).toBe(counts.blue);
  });
});

describe('G3-26 · points.near and edges.near in space', () => {
  const m = box(1).subdivide(2);
  const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  it('finds the points strictly closer than the radius, never the row itself', () => {
    const p = m.points.at(5)!;
    // FRICTION G3-26: cur.points.near(top.at(0)!, { radius: 0.5 })
    const near = m.points.near(p, { radius: 0.5 });
    const brute = m.points.filter((q) => q !== p && dist(p, q) < 0.5);
    expect(near.indices).toEqual(brute.indices);
    expect(near.has(p)).toBe(false);
    // A position is just a position: the point under it is found.
    expect(m.points.near([p.x, p.y, p.z], { radius: 0.5 }).has(p)).toBe(true);
    // A selection answers with its own members only.
    const upper = m.points.filter((q) => q.z > 0);
    expect(upper.near(p, { radius: 0.6 }).every((q) => q.z > 0)).toBe(true);
    expect(() => m.points.near(p, { radius: 0 })).toThrow(/radius/);
  });
  it('finds the edges by the true distance to each edge', () => {
    const at = { x: 0.5, y: 0, z: 0.5 };
    const near = m.edges.near(at, { radius: 0.2 });
    const seg = (e: { a: typeof at; b: typeof at }) => {
      const d = [e.b.x - e.a.x, e.b.y - e.a.y, e.b.z - e.a.z], w = [at.x - e.a.x, at.y - e.a.y, at.z - e.a.z];
      const t = Math.max(0, Math.min(1, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / (d[0] ** 2 + d[1] ** 2 + d[2] ** 2)));
      return Math.hypot(w[0] - t * d[0], w[1] - t * d[1], w[2] - t * d[2]);
    };
    expect(near.indices).toEqual(m.edges.filter((e) => seg(e) < 0.2).indices);
    expect(near.length).toBeGreaterThan(0);
  });
});

describe('G3-25 · projected lines answer curves() and contours()', () => {
  it('reads a silhouette as an area polygon can fill', async () => {
    const ball = sphere(1.3, { segments: 16, rings: 8 });
    let rings = 0;
    const out = await draw(() => view(ball, { camera, creaseAngle: 180 }, (lines) => {
      const rim = lines.visible.kind('silhouette');
      rings = rim.contours().length;
      return [
        strokes(rim, { pen: 'ink' }),
        // FRICTION G3-25: polygon(rim, { fill: fill('hatch', …), stroke: false, fillPen: 'blue' })
        polygon(rim, { fill: fill('hatch', { angle: 30, spacing: mm(2) }), stroke: false, fillPen: 'blue' }),
      ];
    }));
    expect(rings).toBe(1);
    expect(byPen(out).blue).toBeGreaterThan(0);
  });
  it('joins intervals end to end into chains in drawable units', async () => {
    let chains: ReturnType<ProjectedLines['visible']['curves']> = [];
    await draw(() => view(plane(2, 2), { camera }, (lines) => { chains = lines.visible.curves(); return strokes(lines.visible, { pen: 'ink' }); }));
    expect(chains.length).toBeGreaterThan(0);
    for (const c of chains) for (const [x, y] of c.pts) {
      expect(x).toBeGreaterThanOrEqual(-1e-6); expect(x).toBeLessThanOrEqual(100 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6); expect(y).toBeLessThanOrEqual(100 + 1e-6);
    }
    // A square's four edges meet two at a corner: one closed ring of four.
    expect(chains).toHaveLength(1);
    expect(chains[0].closed).toBe(true);
    expect(chains[0].pts).toHaveLength(4);
  });
});

describe('G3-31 · G6-25 · a 2D chain is a profile', () => {
  const ring = curve2([[0.3, 0], [0, 0.3], [-0.3, 0], [0, -0.3]], { closed: true });
  const path = curve([[0, 0, 0], [0, 0, 1], [0.5, 0, 1.5]]);
  it('sweeps a 2D material as an XY profile, ids and columns kept', () => {
    // FRICTION G3-31: sweep(star, path)
    const tube = sweep(ring.attribute('k', (p) => p.index), path);
    const lifted = sweep(curve(ring.points.map((p) => [p.x, p.y, 0] as [number, number, number]), { closed: true }), path);
    expect(tube.points.map((p) => [p.x, p.y, p.z])).toEqual(lifted.points.map((p) => [p.x, p.y, p.z]));
    expect(tube.points.map((p) => p.k)).toEqual(lifted.points.map((_, i) => i % 4));
    expect(tube.points.at(0)!.provenance!.parents[0]).toBe(`2d:${String(ring.points.at(0)!.id)}`);
  });
  it('revolves a 2D chain as the XZ meridian', () => {
    const profile = curve2([[0, 0], [0.9, 0], [1.1, 0.8], [0.6, 1.6]], { closed: false });
    // FRICTION G3-31: revolve(profile, { segments: 24 })
    const vase = revolve(profile, { segments: 24 });
    const lifted = revolve(curve(profile.points.map((p) => [p.x, 0, p.y] as [number, number, number])), { segments: 24 });
    expect(vase.points.map((p) => [p.x, p.y, p.z])).toEqual(lifted.points.map((p) => [p.x, p.y, p.z]));
  });
  it('refuses several chains, and a shape, by name', () => {
    const two = material([[0, 0], [1, 0], [0, 1], [1, 1]], { edges: [[0, 1], [2, 3]] });
    expect(() => sweep(two, path)).toThrow(/has 2 chains/);
    expect(() => curve({ __occludeShape: true, curves: () => [] } as never)).toThrow(/a shape is not geometry until the toolkit lowers it/);
  });
});

describe('G3-33 · curve builds from positions, as in 2D', () => {
  it('builds an open chain from positions, closed only when asked', () => {
    const c = curve([[0, 0, 0], [1, 0, 0], [1, 1, 0]]);
    expect(c.edges.length).toBe(2);
    expect(curve([[0, 0, 0], [1, 0, 0], [1, 1, 0]], { closed: true }).edges.length).toBe(3);
  });
  it('gives the function form its own word and refuses the old ones by name', () => {
    expect(parametricCurve((u) => [Math.cos(u * 6), Math.sin(u * 6), u], { segments: 48 }).edges.length).toBe(48);
    expect(() => curve(((u: number) => [u, 0, 0]) as never)).toThrow(/parametricCurve/);
    expect('polyline' in three).toBe(false);
  });
});

describe('G3-34 · G5-15 · a 2D point is a 3D point at z = 0', () => {
  it('places instances on 2D points, columns kept', () => {
    const flat = material([[0, 0], [1, 2], [3, 1]]).attribute('size', (p) => p.index + 1);
    // FRICTION G3-34: instanceOnPoints(cone(…), flat.points)
    const copies = instanceOnPoints(cone(0.2, 0.5), flat.points, { scale: (p) => p.size });
    expect(copies.rows.map((r) => r.transform.translate)).toEqual([[0, 0, 0], [1, 2, 0], [3, 1, 0]]);
    expect(copies.rows.map((r) => r.transform.scale)).toEqual([[1, 1, 1], [2, 2, 2], [3, 3, 3]]);
    // FRICTION G5-15: instanceOnPoints(sphere(…), t.within(lattice.points, square), …) — a 2D selection
    expect(instanceOnPoints(cone(0.2, 0.5), flat.points.filter((p) => p.x > 0)).rows.length).toBe(2);
    expect(instanceOnPoints(cone(0.2, 0.5), [[0, 0], [2, 2]]).rows.length).toBe(2);
    expect(pointCloud(flat).points.map((p) => [p.x, p.y, p.z, p.size])).toEqual([[0, 0, 0, 1], [1, 2, 0, 2], [3, 1, 0, 3]]);
  });
});

describe('G3-37 · supported curves are a collection of chains', () => {
  it('filters, maps and groups isoline rings, each ring its points and level', () => {
    const ball = sphere(1.3, { segments: 40, rings: 20 });
    const rings = isolines(ball, (p) => p.z, { count: 7 });
    const chains = rings.curves();
    expect(chains.length).toBe(7);
    expect(chains.every((c) => c.closed)).toBe(true);
    // FRICTION G3-37: rings.filter((c) => c.points.every((p) => p.z > 0))
    const upper = rings.filter((c) => c.points.every((p) => p.z > 0));
    expect(upper.curves().length).toBe(3);
    expect(upper.curves().every((c) => (c.level ?? 0) > 0)).toBe(true);
    expect(rings.map((c) => c.level)).toEqual(chains.map((c) => c.attributes.level));
    const halves = rings.groupBy((c) => (c.level ?? 0) > 0);
    expect(halves.map((g) => g.curves.curves().length).sort()).toEqual([3, 4]);
  });
});

describe('G3-38 · a curve sample on the traced mesh is a trace seed', () => {
  it('traces from the seam samples, and refuses a sample of another mesh by name', () => {
    const ball = sphere(1.3, { segments: 24, rings: 12 });
    const block = box([1.2, 1.2, 2.8]).translate([0.5, 0.3, 0]);
    const seam = intersections(ball, block);
    const seeds = sampleSurfaceCurves(seam, { count: 12 }).points;
    // FRICTION G3-38: trace(ball, t.sample(seam, { count: 12 }).points, [0, 0, 1], …)
    const paths = trace(ball, seeds, [0, 0, 1], { step: 0.05, maxLength: 1.4 });
    expect(paths.edges.length).toBeGreaterThan(0);
    expect(() => trace(sphere(2), seeds, [0, 0, 1], { step: 0.05, maxLength: 1 })).toThrow(/does not lie on this mesh/);
  });
});

describe('G3-32 · a 3D curve has length, along and resample', () => {
  it('walks a helix by arc length, as a 2D chain walks', () => {
    const helix = parametricCurve((u) => [Math.cos(u * 12), Math.sin(u * 12), u * 2], { segments: 96 });
    // FRICTION G3-32: helix.along({ count: 20 }), helix.length, helix.resample({ spacing })
    const total = helix.edges.map((e) => e.length).reduce((a, b) => a + b, 0);
    expect(helix.length).toBeCloseTo(total, 12);
    const stations = helix.along({ count: 20 });
    expect(stations).toHaveLength(20);
    expect(stations[0].s).toBe(0);
    expect(stations[19].s).toBeCloseTo(total, 9);
    expect(Math.hypot(...stations[7].tangent)).toBeCloseTo(1, 9);
    const even = helix.resample({ spacing: 0.5 });
    expect(even.edges.length).toBe(Math.round(total / 0.5));
    expect(() => helix.along({})).toThrow(/exactly one of/);
  });
});

describe('G3-19 · a field of space is (x, y, z), as sdf3 and 2D fields', () => {
  it('takes sdf3 in grad3 and refuses a one-point function by name', () => {
    // FRICTION G3-19: const up = grad3(sdf3.sphere(0.6));
    const up = grad3(sdf3.sphere(0.6));
    // sdf3 is positive inside, so it rises toward the middle.
    const g = up(1, 0, 0);
    expect(g[0]).toBeCloseTo(-1, 6);
    expect(g[1]).toBeCloseTo(0, 6);
    expect(() => grad3(((p: number[]) => p[0]) as never)).toThrow(/takes \(x, y, z\)/);
    expect(() => curl3(((p: number[]) => [p[0], 0, 0]) as never)).toThrow(/takes \(x, y, z\)/);
    const swirl = curl3((x, y) => [0, 0, x * x + y * y]);
    expect(swirl(1, 0, 0)[1]).toBeCloseTo(-2, 6);
  });
});

describe('G3-43 · the advanced stage takes the ordinary values at the joins', () => {
  it('reads x/y/z on advanced point rows, a mesh in lineArt3 and a Surface3 in view', async () => {
    // FRICTION G3-43: new PointSelection3(s).filter((p) => p.z > 0)
    expect(new PointSelection3(box3([1.4, 1.4, 1.4])).filter((p) => p.z > 0).indices).toHaveLength(4);
    // FRICTION G3-43: lineArt3({ objects: [{ surface: m }] })
    const scene = lineArt3({ objects: [{ id: 'mesh', surface: box(1) }], camera, lineSets: [{ id: 'visible', stroke: 'ink' }] });
    expect(scene.objects[0].surface.points.length).toBe(8);
    // FRICTION G3-43: view(box3([1, 1, 1]), …)
    const a = await draw(() => view(box3([1, 1, 1]), { camera, pen: 'ink' }));
    const b = await draw(() => view(box(1), { camera, pen: 'ink' }));
    expect(a.raw.prims).toEqual(b.raw.prims);
  });
});


/**
 * Fields, forces and steps act in the sketch's space (spec 50).
 *
 * A sketch's coordinates are the space's coordinates. The engine samples a
 * field on the paper, so it reads the field at the sketch point UNDER each
 * paper sample; a `within()` bound is lowered and projected the way the ink
 * is; `t.travelTime` marches the space's metric; a material from the toolkit
 * carries the sketch's space, `m.steps` walks a move in it with `exp`, and
 * the forces measure with `distance` and `log`; `t.relax`/`t.settle` weigh a
 * cell by the space's area.
 *
 * Everything flat is bit-identical. The flat golden hashes below were
 * written from the OLD code (the tree at e4928d5, before this change), by
 * the same expressions these tests run.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SQ, toolkit } from './helpers/run.js';
import {
  append, circle, compileSketch, encodeScene, fill, force, initOcclude, line, material, rect, render, sketch, space,
  Material, type SketchConfig,
} from '../src/index.js';
import { lowerShape, unitMm, userToPaperMatrix } from '../src/record.js';
import { flattenPrim, type Prim } from '../src/prims.js';
import { paperStep, planGrid } from '../src/fieldGrid.js';
import { apply, invert, mul, scale as mscale } from '../src/matrix.js';
import { decodePrim, PRIM_STRIDE } from '../src/sceneBuffers.js';
import { densityRaster, settleMaterial } from '../src/points.js';
import { fromSheet, spaceAreaNearest, type Space } from '../src/space.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

const HYP: SketchConfig = { aspect: [1, 1], space: space.hyperbolic({ radius: 45 }) };
const SPH: SketchConfig = { aspect: [1, 1], space: space.spherical({ radius: 30 }) };
const FLAT: SketchConfig = { aspect: [1, 1] };

const hash = (xs: readonly number[]): string =>
  createHash('sha256').update(Buffer.from(Float64Array.from(xs).buffer)).digest('hex').slice(0, 16);

type Pt = [number, number];

/** The distance from `p` to a closed polyline, and whether `p` is inside. */
function against(loop: readonly Pt[], p: Pt): { inside: boolean; dist: number } {
  let inside = false;
  let dist = Infinity;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [ax, ay] = loop[j];
    const [bx, by] = loop[i];
    if ((by > p[1]) !== (ay > p[1]) && p[0] < ((ax - bx) * (p[1] - by)) / (ay - by) + bx) inside = !inside;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    dist = Math.min(dist, Math.hypot(p[0] - ax - dx * u, p[1] - ay - dy * u));
  }
  return { inside, dist };
}

/** A sketch loop, projected to paper mm the way the ink door projects it. */
function projectedLoop(t: ReturnType<typeof toolkit>, loop: readonly Pt[]): Pt[] {
  const frame = t.exec.frame;
  const unit = unitMm(frame);
  return loop.map((p) => {
    const q = t.space.project(p);
    return [q[0] * unit + frame.offsetX, q[1] * unit + frame.offsetY];
  });
}

// ---- 1. the engine reads a field where the ink is ---------------------------

describe('the engine reads a field at the sketch point under each paper sample', () => {
  /** Compile a hatched rect whose decimate field records every point it is
   * asked about, and hand back the scene and the record. */
  const recorded = (cfg: SketchConfig) => {
    const seen: Pt[] = [];
    const field = (x: number, y: number): number => {
      seen.push([x, y]);
      return 0.25;
    };
    const exec = compileSketch(sketch(cfg, () => rect(20, 20, 60, 60, { fill: fill('hatch'), decimate: { fill: field } })), SQ);
    const scene = encodeScene(exec);
    return { exec, scene, seen, field };
  };

  it('hyperbolic: every sample is fromChart of its paper lattice point', () => {
    const { exec, scene, seen } = recorded(HYP);
    const sp = exec.space;
    const frame = exec.frame;
    const unit = unitMm(frame);
    // One use, one grid: the record says where its lattice lies and the use
    // says how the paper maps onto it.
    expect(scene.fieldUses.length).toBe(14);
    const u = scene.fieldUses;
    const m = { a: u[1], b: u[2], c: u[3], d: u[4], e: u[5], f: u[6] };
    const toPaper = invert(m);
    const [gw, gh, ox, oy, dx, dy] = scene.fieldData;
    const want: Pt[] = [];
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const [px, py] = apply(toPaper, ox + i * dx, oy + j * dy);
        // Through userToPaper⁻¹: paper mm → drawable units, the chart the
        // sheet is drawn in, and back to the sketch coordinate drawn there.
        const z: Pt = [(px - frame.offsetX) / unit, (py - frame.offsetY) / unit];
        const zx = (z[0] - sp.center[0]) / sp.size;
        const zy = (z[1] - sp.center[1]) / sp.size;
        // Past the rim is no place: the sample fails open and the field is
        // never asked.
        if (!(zx * zx + zy * zy < 1)) continue;
        const s = sp.fromChart(z);
        const user = apply(invert(userToPaperMatrix(frame)), s[0] * unit + frame.offsetX, s[1] * unit + frame.offsetY);
        want.push([user[0] / unit, user[1] / unit]);
      }
    }
    expect(seen.length).toBe(want.length);
    expect(want.length).toBeGreaterThan(100);
    let worst = 0;
    for (let k = 0; k < want.length; k++) worst = Math.max(worst, Math.hypot(seen[k][0] - want[k][0], seen[k][1] - want[k][1]));
    expect(worst).toBeLessThan(1e-9);
    // And it is not the chart point: away from the centre the two differ.
    const far = want.findIndex((p) => Math.hypot(p[0] - 50, p[1] - 50) > 30);
    const [px, py] = apply(toPaper, ox + (far % gw) * dx, oy + Math.floor(far / gw) * dy);
    expect(Math.hypot(seen[far][0] - (px - frame.offsetX) / unit, seen[far][1] - (py - frame.offsetY) / unit)).toBeGreaterThan(1);
  });

  it('flat: the samples are the old lattice expression, bit for bit', () => {
    const { exec, scene, seen, field } = recorded(FLAT);
    const frame = exec.frame;
    const unit = unitMm(frame);
    expect(scene.fieldUses.length).toBe(14);
    // The use exactly as the old encoder built it: the paper-aligned
    // affine, the whole sheet, and the shape's own paper footprint.
    const m = mul(mscale(1 / unit, 1 / unit), invert(userToPaperMatrix(frame)));
    const lowered = lowerShape(exec.shapes[0], frame);
    const fp = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const c of lowered.contours) for (const p of c) for (const [x, y] of flattenPrim(p, 0.5)) {
      fp.x0 = Math.min(fp.x0, x); fp.y0 = Math.min(fp.y0, y);
      fp.x1 = Math.max(fp.x1, x); fp.y1 = Math.max(fp.y1, y);
    }
    const plan = planGrid([{
      fn: field, kind: 'p01', m, domains: [],
      footprint: { x0: 0, y0: 0, x1: frame.paperW, y1: frame.paperH }, shapeFp: fp, aligned: false,
      step: paperStep(false, frame.paperW, frame.paperH),
    }], unit);
    const want: Pt[] = [];
    for (let j = 0; j < plan.gh; j++) {
      for (let i = 0; i < plan.gw; i++) want.push([plan.x0 + (plan.ci0 + i) * plan.cell, plan.y0 + (plan.cj0 + j) * plan.cell]);
    }
    expect(seen).toEqual(want);
  });

  it('fromSheet undoes project in every chart, and answers no place off the sheet', () => {
    for (const projection of ['poincare', 'klein'] as const) {
      const sp = toolkit({ ...HYP, projection }).space;
      for (const p of [[50, 50], [80, 20], [12, 71], [95, 95]] as Pt[]) {
        const back = fromSheet(sp, sp.project(p));
        expect(Math.hypot(back[0] - p[0], back[1] - p[1])).toBeLessThan(1e-9);
      }
      expect(Number.isFinite(fromSheet(sp, [50 + sp.size * 1.01, 50])[0])).toBe(false);
    }
    for (const projection of ['stereographic', 'gnomonic', 'orthographic'] as const) {
      const sp = toolkit({ ...SPH, projection }).space;
      for (const p of [[50, 50], [70, 35], [30, 64]] as Pt[]) {
        const back = fromSheet(sp, sp.project(p));
        expect(Math.hypot(back[0] - p[0], back[1] - p[1])).toBeLessThan(1e-9);
      }
    }
    // The orthographic chart draws one hemisphere inside a circle of half
    // the size: past it the sheet shows nothing.
    const ortho = toolkit({ ...SPH, projection: 'orthographic' }).space;
    expect(Number.isFinite(fromSheet(ortho, [50 + ortho.size * 0.51, 50])[0])).toBe(false);
  });
});

describe('the ink follows the field where the ink is', () => {
  const C = circle(72, 34, 11);

  it('a distanceTo step keeps only the hatch inside the PROJECTED circle', () => {
    const t = toolkit(HYP);
    const inside = t.distanceTo(C);
    // Decimate judges each fragment at its middle, so a stipple — one
    // fragment per dot — shows the field dot by dot.
    const out = render(sketch(HYP, () => rect(2, 2, 96, 96, {
      stroke: false,
      fill: fill('stipple'),
      decimate: { fill: (x: number, y: number) => (inside(x, y) > 0 ? 0 : 1) },
    })), SQ);
    const loop = projectedLoop(t, t.material(C).pts as Pt[]);
    const dots = out.frags.filter((f) => f.dot).map((f): Pt => {
      const g = f.geom as { x0: number; y0: number };
      return [g.x0, g.y0];
    });
    expect(dots.length).toBeGreaterThan(200);
    // The raster is interpolated, so the edge is soft by a cell or two
    // (the paper step here is 1.56 mm); nothing lies further out than that.
    for (const p of dots) {
      const r = against(loop, p);
      expect(r.inside || r.dist < 3.2).toBe(true);
    }
    // The chart disk of the same numbers is another place, and a read at
    // the chart point would have kept ink inside it: here dots lie well
    // outside it, where the projected circle is.
    const unit = unitMm(t.exec.frame);
    const chartDisk = (t.material(C).pts as Pt[]).map(([x, y]): Pt => [x * unit + t.exec.frame.offsetX, y * unit + t.exec.frame.offsetY]);
    expect(dots.filter((p) => { const r = against(chartDisk, p); return !r.inside && r.dist > 2; }).length).toBeGreaterThan(20);
  });

  it('a within() bound erases exactly the projected circle', () => {
    const t = toolkit(HYP);
    const out = render(sketch(HYP, (k) => rect(2, 2, 96, 96, {
      stroke: false,
      fill: fill('stipple'),
      decimate: { fill: k.within(() => 1, C) },
    })), SQ);
    const loop = projectedLoop(t, t.material(C).pts as Pt[]);
    let outside = 0;
    for (const f of out.frags) {
      if (!f.dot) continue;
      const g = f.geom as { x0: number; y0: number };
      const r = against(loop, [g.x0, g.y0]);
      // Nothing survives inside, past the boundary's own tolerance: the
      // bound is exact geometry, not a raster.
      if (r.inside) expect(r.dist).toBeLessThan(0.1);
      else outside++;
    }
    expect(outside).toBeGreaterThan(1000);
  });

  it('the clip loop the engine receives is the projected boundary', () => {
    const t = toolkit(HYP);
    const exec = compileSketch(sketch(HYP, (k) => rect(2, 2, 96, 96, {
      fill: fill('hatch'), decimate: { fill: k.within(() => 1, C) },
    })), SQ);
    const scene = encodeScene(exec);
    const u = scene.fieldUses;
    expect(u[13]).toBe(1);
    const clip = scene.domainList[u[12]];
    const [cStart, cCount] = [scene.clipsU32[3 * clip], scene.clipsU32[3 * clip + 1]];
    expect(cCount).toBe(1);
    const [pStart, pCount] = [scene.contours[2 * cStart], scene.contours[2 * cStart + 1]];
    const got: Pt[] = [];
    for (let k = 0; k < pCount; k++) {
      const p = decodePrim(scene.prims, (pStart + k) * PRIM_STRIDE) as Extract<Prim, { t: 'line' }>;
      got.push([p.x0, p.y0]);
    }
    const want = projectedLoop(t, t.material(C).pts as Pt[]);
    // The same boundary both ways, to the lowering's sampling tolerance.
    for (const p of got) expect(against(want, p).dist).toBeLessThan(0.06);
    for (const p of want) expect(against(got, p).dist).toBeLessThan(0.06);
    // The chart disk of the same numbers is a different place.
    const chartDisk = (t.material(C).pts as Pt[]).map(([x, y]): Pt => [x * unitMm(t.exec.frame) + t.exec.frame.offsetX, y * unitMm(t.exec.frame) + t.exec.frame.offsetY]);
    expect(Math.max(...got.map((p) => against(chartDisk, p).dist))).toBeGreaterThan(1);
  });
});

// ---- 2. travelTime on the metric --------------------------------------------

describe('t.travelTime measures the walk in the space', () => {
  for (const [name, cfg] of [['sphere', SPH], ['hyperbolic', HYP]] as const) {
    it(`${name}: arrival time from a point is the space's distance`, () => {
      const t = toolkit(cfg);
      const c: Pt = [50, 50];
      const T = t.travelTime({ fromPoints: [c], step: 0.1 });
      for (const p of [[70, 50], [50, 80], [80, 80], [20, 30], [90, 10]] as Pt[]) {
        const d = t.space.distance(c, p);
        // First-order marching: within 1% of the distance, which the flat
        // march on the same grid also meets. The coordinate distance is off
        // by several units at the far points.
        expect(Math.abs(T(p[0], p[1]) - d) / d).toBeLessThan(1e-2);
      }
      expect(Math.abs(Math.hypot(40, 40) - t.space.distance(c, [90, 10]))).toBeGreaterThan(5);
    });
  }

  it('flat: bit-identical to the old march (golden from the old code)', () => {
    const t = toolkit({ aspect: [1, 1], seed: 7 });
    const T = t.travelTime({ fromPoints: [[30, 40]], speed: (x: number) => 0.5 + 0.01 * x });
    const tv: number[] = [];
    for (let y = 3; y < 100; y += 7) for (let x = 5; x < 100; x += 9) tv.push(T(x, y));
    expect(hash(tv)).toBe('6330b616447a58fe');
    expect([T(70, 60), T(12, 88)]).toEqual([45.66996899154083, 71.58218860704795]);
    const T2 = t.travelTime({ fromArea: circle(50, 50, 10), within: [[[5, 5], [95, 5], [95, 95], [5, 95]]] });
    const tv2: number[] = [];
    for (let y = 3; y < 100; y += 7) for (let x = 5; x < 100; x += 9) tv2.push(T2(x, y));
    expect(hash(tv2)).toBe('52c07405a3adf086');
    expect(T2(90, 90)).toBe(46.877796915581094);
  });
});

// ---- 3. the material carries its space --------------------------------------

describe('a material carries the space its coordinates belong to', () => {
  /** Every Material verb that answers a Material, called on `m`. The
   * prototype is enumerated below, so a new verb that is not listed here
   * fails the test that says which. */
  const verbs = (m: Material, sp: Space): Record<string, () => Material> => ({
    smooth: () => m.attribute('w', 1).smooth('w'),
    attribute: () => m.attribute('w', 1),
    attributes: () => m.attributes({ w: 1 }),
    faceAttribute: () => m.faceAttribute('f', 1),
    faceAttributes: () => m.faceAttributes({ f: 1 }),
    edgeAttribute: () => m.edgeAttribute('e', 1),
    edgeAttributes: () => m.edgeAttributes({ e: 1 }),
    withEdges: () => m.withEdges([[0, 2]]),
    resample: () => m.resample({ count: 24 }),
    spline: () => m.spline(),
    trim: () => m.trim({ start: 1 }),
    map: () => m.map((p) => [p.x + 1, p.y]),
    transform: () => m.transform(toolkitStation(sp).placement()),
    scale: () => m.scale(0.5),
    rotate: () => m.rotate(10),
    translate: () => m.translate([1, 2]),
    deform: () => m.deform(() => [0.1, 0]),
    thicken: () => m.thicken({ radius: 1 }),
    warp: () => m.warp({ from: [[0, 0], [100, 0], [100, 100], [0, 100]], to: [[0, 0], [100, 0], [100, 100], [0, 100]] }),
    oscillate: () => m.oscillate({ wavelength: 3, amplitude: 1 }),
    coil: () => m.coil({ radius: 1, pitch: 3 }),
    envelope: () => m.envelope(),
    interlace: () => m.interlace({ gap: 1 }),
    snap: () => m.snap(() => 0, { radius: 1 }),
    trails: () => m.trails(),
    steps: () => m.steps(1, { move: () => [0.1, 0] }),
    planarize: () => m.planarize(),
    merge: () => m.merge(),
    extract: () => m.points.extract(),
  });
  let stationOf: (sp: Space) => ReturnType<ReturnType<typeof toolkit>['station']>;
  const toolkitStation = (sp: Space) => stationOf(sp);

  /** Two crossing rings: faces, crossings for interlace, chains for the rest. */
  const source = (t: ReturnType<typeof toolkit>): Material =>
    t.sample(circle(45, 50, 12), { count: 40 }).steps(0, { move: () => [0, 0] });

  it('every verb that answers a material keeps the receiver\'s space', () => {
    for (const cfg of [HYP, SPH, FLAT]) {
      const t = toolkit(cfg);
      stationOf = () => t.station(50, 50, { heading: 20 });
      const m = source(t);
      expect(m.space).toBe(t.space);
      for (const [name, call] of Object.entries(verbs(m, t.space))) {
        const out = call();
        expect(out, name).toBeInstanceOf(Material);
        expect(out.space, name).toBe(t.space);
      }
    }
  });

  it('the list covers every Material verb on the prototype that answers a material', () => {
    const covered = new Set(Object.keys(verbs(material([]), toolkit(FLAT).space)));
    // Readers, lookups and constructors of other kinds of value.
    const notMaterial = new Set([
      'constructor', 'rowOfPoint', 'rowOfEdge', 'pointOf', 'edgeOf', 'vertex', 'edge', 'adjacentRows', 'incidentEdgeRows',
      'rowOfVertex', 'faces', 'cellOf', 'siteOf', 'contours', 'curves', 'edgeRowsAll', 'along', 'pivot',
    ]);
    const names = Object.getOwnPropertyNames(Material.prototype).filter((k) => typeof Object.getOwnPropertyDescriptor(Material.prototype, k)?.value === 'function');
    expect(names.filter((k) => !covered.has(k) && !notMaterial.has(k))).toEqual([]);
  });

  it('material(points) is flat and carries none; the toolkit stamps a flat run too', () => {
    expect(material([[1, 2], [3, 4]]).space).toBeUndefined();
    const flat = toolkit(FLAT);
    expect(flat.material(rect(1, 1, 5, 5)).space).toBe(flat.space);
    expect(flat.space.kind).toBe('euclidean');
    // Not enumerable: a material compared as data is compared by its rows.
    expect(Object.keys(flat.material(rect(1, 1, 5, 5)))).not.toContain('space');
  });

  it('append keeps the space of the first side that has one, and refuses two', () => {
    const t = toolkit(HYP);
    const spaced = t.material(rect(10, 10, 5, 5));
    const flat = material([[1, 2]]);
    expect(append(flat, spaced).space).toBe(t.space);
    expect(append(spaced, flat).space).toBe(t.space);
    expect(() => append(spaced, toolkit(SPH).material(rect(1, 1, 2, 2)))).toThrow(/different spaces/);
  });

  it('every stamped toolkit word answers a material in exec.space', () => {
    for (const cfg of [HYP, FLAT]) {
      const t = toolkit(cfg);
      const pts = t.scatter({ spacing: 8 });
      const words: Record<string, () => Material> = {
        material: () => t.material(rect(10, 10, 20, 20)),
        sample: () => t.sample(circle(50, 50, 10), { count: 12 }),
        sampleMaterial: () => t.sample(material([[1, 1], [9, 1], [9, 9]]), { count: 6 }),
        scatter: () => pts,
        throw: () => t.throw({ count: 10 }),
        relax: () => t.relax(material([[10, 10], [30, 40], [60, 20]])),
        settle: () => t.settle(pts, { density: () => 0.5, spacing: 8, iterations: 1 }),
        voronoi: () => t.voronoi(pts),
        quadtree: () => t.quadtree(pts),
        spacefill: () => t.spacefill(rect(10, 10, 30, 30), { spacing: 5 }),
        text: () => t.text('ab', { size: 5 }),
        isolines: () => t.isolines((x) => x, [50]),
        ridges: () => t.ridges((x, y) => -Math.hypot(x - 50, y - 50)),
        streamlines: () => t.streamlines(() => [1, 0], { spacing: 10 }),
        hexes: () => t.hexes({ spacing: 10 }),
        triangles: () => t.triangles({ size: 10 }),
      };
      for (const [name, call] of Object.entries(words)) expect(call().space, name).toBe(t.space);
    }
    const hyp = toolkit(HYP);
    expect(hyp.tiling(5, 4, { depth: 1 }).space).toBe(hyp.space);
    expect(hyp.tiling(5, 4, { depth: 1 }).geometry).toBe('hyperbolic');
  });
});

// ---- steps walk -----------------------------------------------------------

describe('a move is a walk in the material\'s space', () => {
  it('sphere: each point lands at exp(p, move)', () => {
    const t = toolkit(SPH);
    const m = t.sample(circle(50, 50, 15), { count: 16 });
    const d = 4;
    const out = m.steps(1, { move: () => [d, 0] });
    for (let i = 0; i < m.n; i++) {
      const want = t.space.exp([m.x[i], m.y[i]], [d, 0]);
      expect(out.x[i]).toBe(want[0]);
      expect(out.y[i]).toBe(want[1]);
    }
    // Two moves in one pass add up first, then walk once.
    const twice = m.steps(1, (cur, next) => {
      next.move(cur.points, () => [1, 0.5]);
      next.move(cur.points, () => [2, -0.5]);
    });
    const want = t.space.exp([m.x[3], m.y[3]], [3, 0]);
    expect([twice.x[3], twice.y[3]]).toEqual(want);
  });

  it('flat: x + d exactly, for a pure material and a flat toolkit one', () => {
    for (const m of [material([[1.1, 2.3], [7.7, 0.3]]), toolkit(FLAT).material(rect(1.1, 2.3, 4.4, 5.5))]) {
      const out = m.steps(1, { move: () => [0.1, 0] });
      for (let i = 0; i < m.n; i++) {
        expect(out.x[i]).toBe(m.x[i] + 0.1);
        expect(out.y[i]).toBe(m.y[i] + 0);
      }
    }
  });
});

// ---- forces -------------------------------------------------------------------

describe('forces measure with the space', () => {
  const pairIn = (t: ReturnType<typeof toolkit>, a: Pt, b: Pt): Material =>
    t.sample(line(a[0], a[1], b[0], b[1]), { count: 2 }).map((p) => (p.index === 0 ? a : b));

  it('separation pushes apart along the geodesic, by the old law in the space distance', () => {
    for (const cfg of [HYP, SPH]) {
      const t = toolkit(cfg);
      const r = 10;
      const a: Pt = [70, 30];
      // A point at space distance r/2 from `a`, in a direction that is not
      // a coordinate axis.
      const b = t.space.exp(a, [r / 2 * Math.cos(1), r / 2 * Math.sin(1)]) as Pt;
      const m = pairIn(t, a, b);
      expect(m.space).toBe(t.space);
      const push = force.separation(m, { radius: r });
      const v = push(m.vertex(0));
      const d = t.space.distance(a, b);
      expect(d).toBeCloseTo(r / 2, 9);
      const l = t.space.log(a, b);
      const ll = Math.hypot(l[0], l[1]);
      const s = (1 - d / r) * r;
      expect(v[0]).toBeCloseTo((-l[0] / ll) * s, 9);
      expect(v[1]).toBeCloseTo((-l[1] / ll) * s, 9);
      // The toolkit's copy hands the sketch's space to a pure list.
      const w = t.force.separation(material([a, b]), { radius: r })(material([a, b]).vertex(0));
      expect(w[0]).toBeCloseTo(v[0], 9);
      expect(w[1]).toBeCloseTo(v[1], 9);
      // The flat reading of the same numbers is a different vector.
      const flat = force.separation(material([a, b]), { radius: r })(material([a, b]).vertex(0));
      expect(Math.hypot(flat[0] - v[0], flat[1] - v[1])).toBeGreaterThan(1e-3);
    }
  });

  it('a neighbour is found by the space\'s distance, not the coordinates\'', () => {
    const t = toolkit(SPH);
    // Near the top of the sphere a row is short: two points 14 coordinate
    // units apart along it are within 10 of each other in the space.
    const a: Pt = [43, 50 - 30 * 1.3];
    const b: Pt = [57, 50 - 30 * 1.3];
    expect(t.space.distance(a, b)).toBeLessThan(10);
    const m = pairIn(t, a, b);
    const v = force.separation(m, { radius: 10 })(m.vertex(0));
    expect(Math.hypot(v[0], v[1])).toBeGreaterThan(0);
    expect(force.separation(material([a, b]), { radius: 10 })(material([a, b]).vertex(0))).toEqual([0, 0]);
  });

  it('boundary pushes inward, perpendicular to the nearest geodesic edge', () => {
    const t = toolkit(HYP);
    const tiles = t.tiling(5, 4, { depth: 1 });
    const area = tiles.seed.contours();
    const inside = t.distanceTo(tiles.seed.contours()[0].pts as Pt[]);
    const keep = t.force.boundary(area, { radius: 6, strength: 2 });
    const near = spaceAreaNearest(t.space, area.map((c) => ({ pts: c.pts, closed: true })));
    let checked = 0;
    const corners = tiles.cell as Pt[];
    for (let k = 0; k < corners.length; k++) {
      // A point a little way in from the middle of each wall, where that
      // wall is the one nearest.
      const mid = t.space.geodesic(corners[k], corners[(k + 1) % corners.length], 0.5);
      const q = t.space.geodesic(mid, [50, 50], 0.15) as Pt;
      const d = inside(q[0], q[1]);
      if (!(d > 0 && d < 6)) continue;
      const v = keep(q);
      const len = Math.hypot(v[0], v[1]);
      expect(len).toBeCloseTo((1 - d / 6) * 2, 9);
      // Away from the nearest boundary point, along the geodesic to it.
      const r = near(q[0], q[1]);
      const l = t.space.log(q, r.nearest);
      const ll = Math.hypot(l[0], l[1]);
      expect(Math.abs(t.space.distance(q, r.nearest) - d)).toBeLessThan(1e-9);
      expect(v[0] / len).toBeCloseTo(-l[0] / ll, 6);
      expect(v[1] / len).toBeCloseTo(-l[1] / ll, 6);
      // A small step along it gains that much distance from the edge.
      const eps = 1e-4;
      const s = t.space.exp(q, [(v[0] / len) * eps, (v[1] / len) * eps]);
      expect((inside(s[0], s[1]) - d) / eps).toBeCloseTo(1, 3);
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });

  it('vortex turns about the centre in the space; tension and relax read the log', () => {
    const t = toolkit(HYP);
    const c: Pt = [50, 50];
    const p: Pt = [80, 25];
    const v = t.force.vortex(c, { strength: 3, falloff: 7 })(p);
    const l = t.space.log(p, c);
    const ll = Math.hypot(l[0], l[1]);
    // Perpendicular to the geodesic from the centre, of the old magnitude.
    expect(v[0] * l[0] + v[1] * l[1]).toBeCloseTo(0, 9);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(3 / (1 + t.space.distance(p, c) / 7), 9);
    expect(ll).toBeCloseTo(t.space.distance(p, c), 9);
    const ring = t.sample(circle(60, 40, 10), { count: 9 });
    const pull = force.tension(ring, { rest: 1 });
    const q = ring.vertex(0);
    const want = [ring.vertex(1), ring.vertex(8)].reduce<Pt>((acc, n) => {
      const g = t.space.log(q, n);
      const k = (t.space.distance(q, n) - 1) / Math.hypot(g[0], g[1]);
      return [acc[0] + g[0] * k, acc[1] + g[1] * k];
    }, [0, 0]);
    const got = pull(q);
    expect(got[0]).toBeCloseTo(want[0], 9);
    expect(got[1]).toBeCloseTo(want[1], 9);
    const smooth = force.relax(ring, { amount: 0.5 })(q);
    const a = t.space.log(q, ring.vertex(1));
    const b = t.space.log(q, ring.vertex(8));
    expect(smooth[0]).toBeCloseTo(((a[0] + b[0]) / 2) * 0.5, 12);
    expect(smooth[1]).toBeCloseTo(((a[1] + b[1]) / 2) * 0.5, 12);
  });

  it('flat: the force arithmetic is the old one (golden from the old code)', () => {
    const t = toolkit({ aspect: [1, 1], seed: 7 });
    const mm = material([[10, 10], [12, 11], [15, 10], [11, 14], [30, 30], [31, 31.5]]);
    const vs: number[] = [];
    const sep = force.separation(mm, { radius: 5 });
    const att = force.attract(mm, { radius: 5, strength: 2 });
    const vor = force.vortex([20, 20], { strength: 3, falloff: 7 });
    const bnd = force.boundary([[[0, 0], [20, 0], [20, 20], [0, 20]]], { radius: 4, strength: 1.5 });
    for (const p of mm.points) vs.push(...sep(p), ...att(p), ...vor(p), ...bnd(p));
    const ring = t.sample(circle(40, 40, 10), { count: 12 }).steps(1, { move: (p) => [Math.sin(p.index) * 0.7, Math.cos(p.index * 3) * 0.5] });
    const ten = force.tension(ring, { rest: 3 });
    const rl = force.relax(ring, { amount: 0.5 });
    for (const p of ring.points) vs.push(...ten(p), ...rl(p), ring.x[p.index], ring.y[p.index]);
    expect(hash(vs)).toBe('3215f7a1190db86f');
  });
});

// ---- 4. relax / settle weighted by the area element --------------------------

describe('t.relax and t.settle weigh a cell by the space\'s area', () => {
  it('the density raster is the field times the area element', () => {
    const sp = toolkit(SPH).space;
    const field = (x: number, y: number): number => 0.3 + (x + y) / 400;
    const B = { x: 10, y: 5, w: 80, h: 90 };
    const flat = densityRaster(field, B, Math.max(B.w, B.h) / 64);
    const curved = densityRaster(field, B, Math.max(B.w, B.h) / 64, sp);
    for (let j = 0; j < flat.rows; j++) {
      for (let i = 0; i < flat.cols; i++) {
        const y = B.y + (j + 0.5) * flat.cw;
        const x = B.x + (i + 0.5) * flat.cw;
        expect(curved.dens[j * flat.cols + i]).toBeCloseTo(flat.dens[j * flat.cols + i] * sp.density([x, y]), 14);
      }
    }
  });

  it('sphere: a cell\'s demand is its density integrated against the area element', () => {
    const t = toolkit(SPH);
    const sp = t.space;
    const B = { x: 20, y: 5, w: 60, h: 60 };
    // Off the raster's rational lines, so no sample is equidistant from two.
    const sites = material([[30.31, 12.77], [60.13, 20.91], [45.72, 40.23], [70.44, 55.39], [28.96, 58.61]]);
    const density = (x: number): number => 0.2 + x / 200;
    const spacing = 9;
    const out = settleMaterial({ rnd: () => 0.25, bounds: B, len: (l) => l as number, space: sp }, sites, {
      density, spacing, iterations: 1, bounds: B, step: Math.max(B.w, B.h) / 96,
    });
    // The cells by brute force: each raster sample to its nearest site,
    // weighted by the field and by the space's area element.
    const R = 96;
    const cw = Math.max(B.w, B.h) / R;
    const cols = Math.max(2, Math.round(B.w / cw));
    const rows = Math.max(2, Math.round(B.h / cw));
    const w = new Float64Array(sites.n);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const x = B.x + (i + 0.5) * cw;
      const y = B.y + (j + 0.5) * cw;
      let best = 0;
      for (let k = 1; k < sites.n; k++) {
        if (Math.hypot(x - sites.x[k], y - sites.y[k]) < Math.hypot(x - sites.x[best], y - sites.y[best])) best = k;
      }
      w[best] += Math.min(1, density(x)) * sp.density([x, y]);
    }
    const cap = (spacing * spacing * 0.866) / (cw * cw);
    const want = [...w].map((v) => v / cap);
    expect(out.n).toBeGreaterThan(0);
    for (const d of out.attrs.demand) expect(want.some((v) => Math.abs(v - d) < 1e-9)).toBe(true);
    // And the flat reading of the same cells is a different number.
    const flatOut = settleMaterial({ rnd: () => 0.25, bounds: B, len: (l) => l as number }, sites, {
      density, spacing, iterations: 1, bounds: B, step: Math.max(B.w, B.h) / 96,
    });
    expect(Math.max(...flatOut.attrs.demand) - Math.max(...out.attrs.demand)).toBeGreaterThan(0.01);
  });

  it('flat: relax and settle are bit-identical (golden from the old code)', () => {
    const t = toolkit({ aspect: [1, 1], seed: 7 });
    const pts = t.scatter({ spacing: 6 });
    const r = t.relax(pts, { iterations: 3, density: (x: number) => 0.2 + x / 125 });
    expect(r.n).toBe(172);
    expect(hash([...r.x, ...r.y])).toBe('c32f3b60955107ed');
    const s = t.settle(pts, { density: (x: number, y: number) => 0.1 + (x * y) / 12000, spacing: 5, iterations: 6 });
    expect(s.n).toBe(207);
    expect(hash([...s.x, ...s.y, ...s.attrs.demand])).toBe('2a684d0d3172eecb');
  });
});

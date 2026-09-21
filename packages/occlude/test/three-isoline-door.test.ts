/**
 * The isoline door: contours are a recipe the view resolves.
 *
 * Two things are checked here, and they are the whole contract. A sketch that
 * reads the curves gets every crossing, exactly as an eager run built them. A
 * view that can certify faces hidden gets a smaller network, and the ink is
 * the same: every record the view dropped classifies WHOLLY hidden, and every
 * record it kept classifies to the same visible intervals and draws the same
 * segments.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileSketchAsync, dash, exportSvg, initOcclude, mm, paperSize, pen, sketch, strokes } from '../src/index.js';
import { SurfaceCurves } from '../src/three/api/supported.js';
import { geodesic, isolines, orthographic, perspective, plane, sphere, view } from '../src/three/api/index.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { featureSnapshot3, type FeatureSnapshot3 } from '../src/three/features/snapshot.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';
import { unionIntervals3, type Interval3 } from '../src/three/visibility/interval.js';
import { isolines3 } from '../src/three/curves/isolines.js';
import type { SurfaceCurveObject3 } from '../src/three/curves/network.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

const paper = { x: 5, y: 5, width: 190, height: 190 };
/** The globe fixture at a frequency a test can afford, with a plain ripple
 * where the sketch reads seeded noise. */
const globe = (frequency = 5) => {
  const base = geodesic(1, { frequency: [frequency, frequency] }).dual();
  const water = base.scale(0.99);
  const terrain = base.displace((p) => (Math.sin(p.x * 3) * Math.cos(p.y * 4) + Math.sin(p.z * 5)) * 0.04).style({ creaseAngle: 180 });
  const levels = isolines(terrain, (p) => Math.hypot(p.x, p.y, p.z), { count: 20 });
  const drawing = view([water, terrain, levels], {
    camera: perspective({ eye: [8.59782, -0.703966, -1.55822], target: [0, 0, 0], fovDegrees: 19.5622 }),
    stroke: 'ink', creaseAngle: 180,
  });
  return drawing.scene;
};
type Scene = ReturnType<typeof globe>;
/** The scene's curve list with every recipe resolved eagerly and completely —
 * what a sketch reading `curves.network` holds. */
const eagerCurves = (scene: Scene): readonly SurfaceCurveObject3[] =>
  (scene.curves ?? []).map((entry) => entry.recipe ? { id: entry.id, attributes: entry.attributes, network: entry.recipe.resolve() } : entry);
const snapshotOf = (scene: Scene, curves: readonly SurfaceCurveObject3[]): FeatureSnapshot3 =>
  featureSnapshot3(scene.objects, scene.wires, cameraFrame3(scene.camera, paper), undefined, curves);
const union = (rows: readonly Interval3[]) => unionIntervals3([...rows]).map((r) => `${r[0]},${r[1]}`).join(' ');
const whole = (rows: readonly Interval3[]) => { const u = unionIntervals3([...rows]); return u.length === 1 && u[0][0] <= 0 && u[0][1] >= 1; };

describe('the isoline view door', () => {
  it('resolves eagerly and completely for a sketch that reads the curves', () => {
    const ball = sphere(1.3, { segments: 24, rings: 12 });
    const rings = isolines(ball, (p) => p.z, { count: 9 });
    // The recipe's own answer, against the kernel called directly on the same
    // surface, values and levels: every crossing, row for row.
    const corners = [...ball.corners];
    const values = Float64Array.from(corners, (c) => c.point.z);
    let min = Infinity, max = -Infinity;
    for (const v of values) if (Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
    const levels = Array.from({ length: 9 }, (_, i) => min + (max - min) * (i + 1) / 10);
    const direct = isolines3(ball.surface, values, levels, {});
    expect(rings.network.segments.length).toBe(direct.network.segments.length);
    expect(rings.network.segments.map((s) => s.id)).toEqual(direct.network.segments.map((s) => s.id));
    expect(rings.network.nodes.map((n) => n.exact.join('/'))).toEqual(direct.network.nodes.map((n) => n.exact.join('/')));
    // The full resolution is memoised, exactly as an intersection recipe's is.
    expect(rings.recipe!.resolve()).toBe(rings.recipe!.resolve());
  });

  it('draws the same ink whether or not the view resolves it lazily', () => {
    const scene = globe();
    const eager = snapshotOf(scene, eagerCurves(scene));
    const lazy = snapshotOf(scene, scene.curves ?? []);
    expect(lazy.features.length).toBeLessThan(eager.features.length);
    const a = classifySceneCpu3(eager), b = classifySceneCpu3(lazy);
    const visible = new Map(b.features.map((row) => [row.feature.id, union(row.visible)]));
    let dropped = 0;
    for (const row of a.features) {
      const mine = visible.get(row.feature.id);
      // A record the view never built must be hidden over its whole length in
      // the complete classification: that is what the certificate claimed.
      if (mine === undefined) { dropped++; expect(whole(row.hidden), `certified but visible: ${row.feature.id}`).toBe(true); continue; }
      expect(mine, `visible ink moved: ${row.feature.id}`).toBe(union(row.visible));
    }
    expect(dropped).toBeGreaterThan(0);
    // Nothing appears that the complete run did not hold.
    const all = new Set(a.features.map((row) => row.feature.id));
    for (const row of b.features) expect(all.has(row.feature.id)).toBe(true);
  }, 120_000);

  it('dashes a partly certified closed ring exactly as full construction does', async () => {
    // A closed z-ring on a sphere is the hard case: the back half is certified
    // hidden, the ring is CLOSED, and a dash is phased by arc length along the
    // whole chain. If the lazy path shortened the chain reference, the dash
    // would start somewhere else — so this compares the two drawings byte for
    // byte, dash and all.
    const draw = (eager: boolean) => sketch(
      { aspect: [1, 1], pens: { ink: pen({ width: mm(0.3), color: '#18202A' }), line: pen({ width: mm(0.18), color: '#2457D6' }) } },
      () => {
        const ball = sphere(1.3, { segments: 40, rings: 20 });
        const recipe = isolines(ball, (p) => p.z, { count: 9 }).recipe!;
        const rings = new SurfaceCurves(eager ? recipe.resolve() : recipe, { stroke: 'line' });
        return view([ball, rings], { camera: orthographic({ eye: [5, 6, 4], span: 4 }), stroke: 'ink', creaseAngle: 180 },
          (lines) => [
            strokes(lines.visible.filter((c) => !c.kinds.has('isoline')), { stroke: 'ink' }),
            strokes(lines.visible.filter((c) => c.kinds.has('isoline')), { stroke: 'line', modifiers: [dash(mm(3), mm(1.6))] }),
          ]);
      },
    );
    const render = async (eager: boolean) => {
      const size = paperSize({ paper: 'Square20' });
      const run = await compileSketchAsync(draw(eager), { paper: { w: size.w, h: size.h }, marginPct: 5, seed: '42' });
      return exportSvg(run, { paper: { paper: 'Square20' }, marginPct: 5 });
    };
    const whole = await render(true), lazy = await render(false);
    expect(lazy).toBe(whole);
    // And the laziness really happened: the view classified fewer features
    // than the complete construction holds records.
    const ball = sphere(1.3, { segments: 40, rings: 20 });
    const rings = isolines(ball, (p) => p.z, { count: 9 });
    const scene = view([ball, rings], { camera: orthographic({ eye: [5, 6, 4], span: 4 }), stroke: 'ink', creaseAngle: 180 }).scene;
    const snapshot = snapshotOf(scene, scene.curves ?? []);
    const graph = snapshot.curveGraphs![0].network;
    expect(graph.segments.length).toBe(rings.recipe!.resolve().segments.length);
    expect(snapshot.referenceFeatures!.length).toBeGreaterThan(snapshot.features.length);
  }, 120_000);

  it('resolves completely when the view can certify nothing', () => {
    // An open sheet is not a closed shell, so it hides nothing of itself and
    // the certificate declines: the view's network is the complete one.
    const relief = plane(3, 3).subdivide(3).displace((p) => [0, 0, 0.5 * Math.sin(p.x * 2) * Math.cos(p.y * 1.5)]);
    const heights = isolines(relief, (p) => p.z, { count: 7 });
    const scene = view([relief, heights], { camera: orthographic({ eye: [5, 7, 6], span: 6 }), stroke: 'ink' }).scene;
    const snapshot = snapshotOf(scene, scene.curves ?? []);
    expect(snapshot.curveGraphs?.[0].network.segments.length).toBe(heights.network.segments.length);
  });
});

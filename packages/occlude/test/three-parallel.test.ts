/**
 * The parallel classifier draws the serial drawing.
 *
 * A feature's hidden intervals are a pure function of the scene and that
 * feature's index, so a range classified in a worker is the range the serial
 * loop would have produced and the rows assemble by index. These two scenes
 * check that on both halves of the wire form: the box field is plain mesh
 * edges (camera triangles, world vertices, occluder ids in every feature's
 * support), and the small globe adds the part that is easy to get wrong —
 * curve networks whose endpoints carry exact rational points as digit
 * strings, and two near-coincident shells that make the exact layer work.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileSketchAsync, exportSvg, initOcclude, mm, pen, sketch, paperSize } from '../src/index.js';
import { box, geodesic, isolines, orthographic, perspective, view } from '../src/three/api/index.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { featureSnapshot3 } from '../src/three/features/snapshot.js';
import { classifyScene3, type ClassifiedScene3 } from '../src/three/visibility/scene.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

/** Three workers, not every core: the tests share a box with other work. */
const WORKERS = 3;
const boxField = () => {
  const boxes = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 10; j++) {
    const h = 0.4 + ((i * 7 + j * 5) % 6) * 0.35;
    boxes.push(box([0.8, 0.8, h]).translate([i - 9.5, j - 4.5, h / 2]));
  }
  return view(boxes, { camera: orthographic({ eye: [9, -13, 8], span: 17 }), stroke: 'ink', creaseAngle: 20 });
};
/** The globe bench fixture with the frequency dropped to [5, 5], and a plain
 * ripple where the sketch reads seeded noise. */
const globe = () => {
  const base = geodesic(1, { frequency: [5, 5] }).dual();
  const water = base.scale(0.99);
  const terrain = base.displace((p) => (Math.sin(p.x * 3) * Math.cos(p.y * 4) + Math.sin(p.z * 5)) * 0.04).style({ creaseAngle: 180 });
  const levels = isolines(terrain, (p) => Math.hypot(p.x, p.y, p.z), { count: 20 });
  return view([water, terrain, levels], {
    camera: perspective({ eye: [8.59782, -0.703966, -1.55822], target: [0, 0, 0], fovDegrees: 19.5622 }),
    stroke: 'ink', creaseAngle: 180,
  });
};
const snapshotOf = (drawing: ReturnType<typeof boxField>) => {
  const scene = drawing.scene;
  return featureSnapshot3(scene.objects, scene.wires, cameraFrame3(scene.camera, { x: 5, y: 5, width: 190, height: 190 }), undefined, scene.curves);
};
/** Everything of a classified scene but the clocks. */
const ink = (result: ClassifiedScene3) => ({
  frame: result.frame,
  features: result.features,
  referenceFeatures: result.referenceFeatures,
  curveGraphs: result.curveGraphs,
  candidates: result.stats.candidates,
});
const pens = { ink: pen({ width: mm(0.3), color: '#18202A' }) };
const svgOf = async (drawing: () => ReturnType<typeof boxField>, workers: string) => {
  const previous = process.env.OCCLUDE_WORKERS;
  process.env.OCCLUDE_WORKERS = workers;
  try {
    const paper = { paper: 'Square20' as const };
    const run = await compileSketchAsync(sketch({ aspect: [1, 1], pens }, () => drawing()), { paper: paperSize(paper), marginPct: 5, seed: '42' });
    return exportSvg(run, { paper, marginPct: 5 });
  } finally {
    if (previous === undefined) delete process.env.OCCLUDE_WORKERS; else process.env.OCCLUDE_WORKERS = previous;
  }
};

describe('the classifier on every core', () => {
  it('classifies a box field the same inline and in workers', async () => {
    const snapshot = snapshotOf(boxField());
    const inline = await classifyScene3(snapshot, { workers: 1 });
    const parallel = await classifyScene3(snapshot, { workers: WORKERS });
    expect(ink(parallel)).toEqual(ink(inline));
  }, 120_000);

  it('classifies a globe with isolines the same inline and in workers', async () => {
    const snapshot = snapshotOf(globe());
    expect(snapshot.curveGraphs?.length).toBeGreaterThan(0);
    const inline = await classifyScene3(snapshot, { workers: 1 });
    const parallel = await classifyScene3(snapshot, { workers: WORKERS });
    expect(ink(parallel)).toEqual(ink(inline));
    expect(parallel.stats.candidates).toBeGreaterThan(0);
  }, 120_000);

  it('fans out the globe and keeps the box field inline when nobody names a count', async () => {
    // `setupMs` is the payload build, which only a fanned-out run pays: it is
    // the observable that says which side of the crossover a scene fell.
    const previous = process.env.OCCLUDE_WORKERS;
    process.env.OCCLUDE_WORKERS = String(WORKERS);
    try {
      expect((await classifyScene3(snapshotOf(globe()), {})).stats.timings!.setupMs).toBeGreaterThan(0);
      expect((await classifyScene3(snapshotOf(boxField()), {})).stats.timings!.setupMs).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.OCCLUDE_WORKERS; else process.env.OCCLUDE_WORKERS = previous;
    }
  }, 120_000);

  it('gives up on an abandoned render and keeps its workers', async () => {
    const snapshot = snapshotOf(globe());
    const controller = new AbortController();
    const abandoned = classifyScene3(snapshot, { workers: WORKERS, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(abandoned).rejects.toThrow();
    // The workers stay alive and idle: the next render finds a pool, not a
    // corpse, and classifies the same scene from the start.
    expect((await classifyScene3(snapshot, { workers: WORKERS })).stats.candidates).toBeGreaterThan(0);
  }, 120_000);

  it('draws the same SVG with a pool as without one', async () => {
    // The globe is over the fan-out line and really does go to the workers;
    // the box field is under it and stays inline at either setting, which is
    // the other half of the claim — the line itself moves no ink.
    expect(await svgOf(globe, String(WORKERS))).toBe(await svgOf(globe, '1'));
    expect(await svgOf(boxField, String(WORKERS))).toBe(await svgOf(boxField, '1'));
  }, 300_000);
});

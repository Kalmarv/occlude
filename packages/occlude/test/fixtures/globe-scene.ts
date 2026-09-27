/**
 * The globe scene of the certificate tests: a geodesic dual displaced into
 * terrain, its contour lines, water and the coastline, classified once — the
 * same scene the untracked globe-certs bench builds, kept here so a tracked
 * test depends only on tracked code.
 */
import { performance } from 'node:perf_hooks';
import { mm, pen, sketch } from '../../src/index.js';
import { DEFAULT_PENS, compileSketchAsync, paperSize } from '../../src/host.js';
import { geodesic, intersections, isolines, perspective, view } from '../../src/three/api/index.js';
import { featureSnapshot3, type FeatureSnapshot3, type SurfaceObject3 } from '../../src/three/features/snapshot.js';
import { viewFrame3 } from '../../src/three/resolve.js';
import type { ClassifiedScene3 } from '../../src/three/visibility/scene.js';
import type { LineArtScene3 } from '../../src/three/scene.js';
import type { Execution } from '../../src/execution.js';

export const CAMERA_EYE = [8.59782, -0.703966, -1.55822] as const;

export interface GlobeScene {
  readonly exec: Execution;
  readonly scene: LineArtScene3;
  readonly baseline: ClassifiedScene3;
  readonly modelMs: number;
  readonly baselineMs: number;
}

/** Build and classify once. `frequency` is the bench's 20 unless a run lowers
 * it for a development pass. */
export async function globeScene(options: { frequency?: number; seed?: number } = {}): Promise<GlobeScene> {
  const frequency = options.frequency ?? 20;
  const seed = options.seed ?? 42;
  const size = paperSize({ paper: 'Square20' });
  const def = sketch(
    { aspect: [1, 1], pens: { ink: pen({ width: mm(0.3), color: '#18202A' }) } },
    async (t) => {
      const pbase = geodesic(1, { frequency: [frequency, frequency] }).dual();
      const water = pbase.scale(0.99);
      const terrainDisplace = (p: { x: number; y: number; z: number }) => {
        const noise = t.noise(p.x * 2, p.y * 2, p.z * 2);
        const noise2 = t.noise(p.x * 4, p.y * 4, p.z * 4);
        const noise3 = t.noise(p.x * 10, p.y * 10, p.z * 10);
        return (noise * 0.6 + noise2 * 0.3 + noise3 * 0.1) * 0.12;
      };
      const terrain = pbase.displace((p) => terrainDisplace(p));
      const levels = isolines(terrain, (p) => Math.hypot(p.x, p.y, p.z), { count: 20 });
      // THE ONE ADDITION: water ink for the containment measurement.
      const waterLevels = isolines(water, (p) => p.z, { count: 12 });
      const coastline = intersections(water, terrain);
      return view([water, terrain, levels, waterLevels, coastline], {
        camera: perspective({ eye: [...CAMERA_EYE], target: [0, 0, 0], fovDegrees: 19.5622 }),
        pen: 'ink',
        creaseAngle: 180,
      });
    },
  );
  const t0 = performance.now();
  const exec = await compileSketchAsync(def, { paper: { w: size.w, h: size.h }, library: DEFAULT_PENS, seed, marginPct: 5 });
  const modelMs = performance.now() - t0;
  const [[scene, baseline]] = [...exec.scenes3];
  return { exec, scene, baseline, modelMs, baselineMs: baseline.stats.wallMs };
}

/** The production capture, with the caller's object list — the same call
 * `resolve.ts` makes, so a derived snapshot holds the same numbers. */
export function captureSnapshot(exec: Execution, scene: LineArtScene3, objects: readonly SurfaceObject3[]): FeatureSnapshot3 {
  return featureSnapshot3(
    objects, scene.wires, viewFrame3(exec, scene), exec.frame.inner, scene.curves,
    { x: 0, y: 0, width: exec.paper.w, height: exec.paper.h },
  );
}

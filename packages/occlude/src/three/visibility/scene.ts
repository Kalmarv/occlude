import { intervalTolerance3 } from './precision.js';
import { toPaper3, type CameraFrame3 } from '../camera.js';
import type { Feature3, FeatureSnapshot3 } from '../features/snapshot.js';
import { projectedBounds3 } from './index.js';
import { hiddenInterval3, unionIntervals3, visibleIntervals3, type Interval3 } from './interval.js';
import type { GpuIntervals3, VisibilityPair3 } from '../../compute/webgpu/interval.js';

export interface ClassifiedFeature3 { readonly feature: Feature3; readonly hidden: readonly Interval3[]; readonly visible: readonly Interval3[] }
export interface ClassifiedScene3 { readonly frame: CameraFrame3; readonly features: readonly ClassifiedFeature3[]; readonly stats: { candidates: number; dispatches: number; refinements: number; transferBytes: number; gpuMs?: number; paperToleranceMm?: number; parameterTolerance?: number; wallMs: number } }

/** Bounded pair streaming. The index is queried with un-cropped paper bounds;
 * no side-frustum or page cull may discard future style overscan. */
export function* candidatePairs3(snapshot: FeatureSnapshot3): Generator<{ feature: number; occluder: number; pair: VisibilityPair3 }> {
  for (let i = 0; i < snapshot.features.length; i++) {
    const feature = snapshot.features[i];
    const bounds = projectedBounds3([toPaper3(snapshot.frame, feature.a), toPaper3(snapshot.frame, feature.b)]);
    for (const j of snapshot.index.query(bounds)) {
      const occluder = snapshot.occluders[j];
      if (!feature.support.includes(occluder.id)) yield { feature: i, occluder: j, pair: { a: feature.a, b: feature.b, volume: occluder.volume, basis: feature.basis } };
    }
  }
}
const finish = (snapshot: FeatureSnapshot3, hidden: Interval3[][], stats: ClassifiedScene3['stats']): ClassifiedScene3 => Object.freeze({ frame: snapshot.frame, features: Object.freeze(snapshot.features.map((feature, i) => { const ranges = unionIntervals3(hidden[i]); return Object.freeze({ feature, hidden: Object.freeze(ranges.map(r=>Object.freeze(r))), visible: Object.freeze(visibleIntervals3(ranges).map(r=>Object.freeze(r))) }); })), stats: Object.freeze({...stats}) });
export function classifySceneCpu3(snapshot: FeatureSnapshot3): ClassifiedScene3 {
  const start = performance.now(), hidden: Interval3[][] = snapshot.features.map(() => []); let candidates = 0;
  for (const { feature, pair } of candidatePairs3(snapshot)) { candidates++; const interval = hiddenInterval3(pair.a, pair.b, pair.volume, pair.basis); if (interval) hidden[feature].push(interval); }
  return finish(snapshot, hidden, { candidates, dispatches: 0, refinements: 0, transferBytes: 0, wallMs: performance.now() - start });
}
export async function classifySceneGpu3(snapshot: FeatureSnapshot3, gpu: GpuIntervals3, options: { signal?: AbortSignal; pairCapacity?: number; maxCandidates?: number; parameterTolerance?: number; paperToleranceMm?: number } = {}): Promise<ClassifiedScene3> {
  const capacity = options.pairCapacity ?? 8192, limit = options.maxCandidates ?? 10_000_000;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65536 || !Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid scene visibility capacity');
  const start = performance.now(), hidden: Interval3[][] = snapshot.features.map(() => []), stats: ClassifiedScene3['stats'] = { candidates: 0, dispatches: 0, refinements: 0, transferBytes: 0, wallMs: 0, ...(gpu.timestampsEnabled ? { gpuMs: 0 } : {}) };
  // Retain only nonempty results for cross-pair topology refinement. Two
  // individually acceptable f32 endpoints can straddle a shared boundary.
  const records: { interval: Interval3; pair: VisibilityPair3 }[][] = snapshot.features.map(() => []);
  const tolerance = intervalTolerance3(snapshot, options.paperToleranceMm ?? .005, options.parameterTolerance);
  stats.paperToleranceMm = options.paperToleranceMm ?? .005;
  stats.parameterTolerance = tolerance;
  let pairs: VisibilityPair3[] = [], owners: number[] = [];
  const flush = async () => {
    options.signal?.throwIfAborted();
    const result = await gpu.classify(pairs, { signal: options.signal, parameterTolerance: tolerance });
    result.intervals.forEach((interval, i) => { if (interval) records[owners[i]].push({ interval, pair: pairs[i] }); });
    stats.dispatches += result.dispatches; stats.refinements += result.refinements; stats.transferBytes += result.transferBytes;
    if (result.gpuMs !== undefined) stats.gpuMs = (stats.gpuMs ?? 0) + result.gpuMs;
    pairs = []; owners = [];
  };
  for (const candidate of candidatePairs3(snapshot)) {
    options.signal?.throwIfAborted();
    if (++stats.candidates > limit) throw new Error(`scene exceeds ${limit} candidate pairs; raise maxCandidates or reduce overlap`);
    pairs.push(candidate.pair); owners.push(candidate.feature);
    if (pairs.length === capacity) await flush();
  }
  if (pairs.length) await flush();
  records.forEach((runs, feature) => {
    const endpoints = runs.flatMap((r, i) => r.interval.map(t => ({ t, i }))).sort((a,b) => a.t-b.t || a.i-b.i);
    const refine = new Set<number>();
    for (let i=1; i<endpoints.length; i++) {
      const a=endpoints[i-1], b=endpoints[i];
      if (a.i !== b.i && b.t-a.t <= 2*tolerance) { refine.add(a.i); refine.add(b.i); }
    }
    runs.forEach((r,i) => {
      const interval = refine.has(i) ? hiddenInterval3(r.pair.a,r.pair.b,r.pair.volume,r.pair.basis) : r.interval;
      if (refine.has(i)) stats.refinements++;
      if (interval) hidden[feature].push(interval);
    });
  });
  options.signal?.throwIfAborted(); stats.wallMs = performance.now() - start;
  return finish(snapshot, hidden, stats);
}

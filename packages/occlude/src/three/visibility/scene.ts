import { PhaseClock3, type PhaseTimings3 } from '../timing.js';
import { intervalTolerance3 } from './precision.js';
import { toPaper3, type CameraFrame3 } from '../camera.js';
import type { Feature3, FeatureSnapshot3 } from '../features/snapshot.js';
import { projectedBounds3, depthCutoff3 } from './index.js';
import { hiddenInterval3, unionIntervals3, visibleIntervals3, type Interval3 } from './interval.js';
import type { GpuIntervals3, VisibilityPair3 } from '../../compute/webgpu/interval.js';

export interface ClassifiedFeature3 { readonly feature: Feature3; readonly hidden: readonly Interval3[]; readonly visible: readonly Interval3[] }
export interface ClassifiedScene3 { readonly curveGraphs?:FeatureSnapshot3['curveGraphs']; readonly referenceFeatures?:readonly Feature3[]; readonly frame: CameraFrame3; readonly features: readonly ClassifiedFeature3[]; readonly stats: { candidates: number; dispatches: number; refinements: number; transferBytes: number; gpuMs?: number; paperToleranceMm?: number; parameterTolerance?: number; wallMs: number; timings?: PhaseTimings3 } }

/** Bounded pair streaming. The index is queried with un-cropped paper bounds;
 * no side-frustum or page cull may discard future style overscan. */
export function* candidatePairs3(snapshot: FeatureSnapshot3): Generator<{ feature: number; occluder: number; pair: VisibilityPair3 }> {
  for (let i = 0; i < snapshot.features.length; i++) {
    const feature = snapshot.features[i];
    const bounds = projectedBounds3([toPaper3(snapshot.frame, feature.a), toPaper3(snapshot.frame, feature.b)]);
    for (const j of snapshot.index.query(bounds, depthCutoff3(Math.min(feature.a[2], feature.b[2])))) {
      const occluder = snapshot.occluders[j];
      if (!feature.support.includes(occluder.id)) yield { feature: i, occluder: j, pair: { a: feature.a, b: feature.b, volume: occluder.volume, basis: feature.basis } };
    }
  }
}
/** Which f32 intervals of one feature need exact re-evaluation: any two from
 * different pairs whose endpoints come within the tolerance. Two occluders
 * that are edge-adjacent triangles of one object are watertight across their
 * shared edge, so an end-to-start abutment between them is closed (the union
 * is contiguous there) instead of re-evaluated; any other near endpoints, and
 * abutments of unrelated occluders, are refined exactly. */
export function refinementTargets3(runs: readonly { interval: Interval3; occluder: number }[], tolerance: number, adjacent: (a: number, b: number) => boolean): { refine: Set<number>; closed: { end: number; start: number }[] } {
  const endpoints = runs.flatMap((r, i) => r.interval.map((t, side) => ({ t, i, side }))).sort((a,b) => a.t-b.t || a.i-b.i);
  const refine = new Set<number>(), closed: { end: number; start: number }[] = [];
  for (let i=1; i<endpoints.length; i++) {
    const a=endpoints[i-1], b=endpoints[i];
    if (a.i === b.i || b.t-a.t > 2*tolerance) continue;
    // The feature's own ends are clipping bounds, not occlusion boundaries:
    // many occluders covering a whole feature all end there, and nothing is
    // learned by re-evaluating them.
    if (a.t === b.t && (a.t === 0 || a.t === 1)) continue;
    if (adjacent(runs[a.i].occluder, runs[b.i].occluder)) {
      // f32 rounding puts a watertight seam either way round; two near starts
      // or two near ends of adjacent occluders change the union by less than
      // the tolerance and open no gap.
      if (a.side !== b.side) closed.push(a.side === 1 ? { end: a.i, start: b.i } : { end: b.i, start: a.i });
    } else { refine.add(a.i); refine.add(b.i); }
  }
  return { refine, closed };
}
const finish = (snapshot: FeatureSnapshot3, hidden: Interval3[][], stats: ClassifiedScene3['stats']): ClassifiedScene3 => Object.freeze({ frame: snapshot.frame, referenceFeatures:snapshot.referenceFeatures, curveGraphs:snapshot.curveGraphs, features: Object.freeze(snapshot.features.map((feature, i) => { const ranges = unionIntervals3(hidden[i]); return Object.freeze({ feature, hidden: Object.freeze(ranges.map(r=>Object.freeze(r))), visible: Object.freeze(visibleIntervals3(ranges).map(r=>Object.freeze(r))) }); })), stats: Object.freeze({...stats}) });
export function classifySceneCpu3(snapshot: FeatureSnapshot3): ClassifiedScene3 {
  const timing = new PhaseClock3(), start = performance.now(), hidden: Interval3[][] = snapshot.features.map(() => []); let candidates = 0;
  timing.measure('cpuMs', () => { for (const { feature, pair } of candidatePairs3(snapshot)) { candidates++; const interval = hiddenInterval3(pair.a, pair.b, pair.volume, pair.basis); if (interval) hidden[feature].push(interval); } });
  const result = timing.measure('finalizeMs', () => finish(snapshot, hidden, { candidates, dispatches: 0, refinements: 0, transferBytes: 0, wallMs: performance.now() - start }));
  return Object.freeze({...result, stats:Object.freeze({...result.stats,timings:timing.finish()})});
}
export async function classifySceneGpu3(snapshot: FeatureSnapshot3, gpu: GpuIntervals3, options: { signal?: AbortSignal; pairCapacity?: number; maxCandidates?: number; parameterTolerance?: number; paperToleranceMm?: number } = {}): Promise<ClassifiedScene3> {
  const capacity = options.pairCapacity ?? 8192, limit = options.maxCandidates ?? Infinity;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65536 || !(limit === Infinity || Number.isSafeInteger(limit)) || limit < 0) throw new Error('invalid scene visibility capacity');
  const timing = new PhaseClock3(), start = performance.now(), hidden: Interval3[][] = snapshot.features.map(() => []), stats: ClassifiedScene3['stats'] = { candidates: 0, dispatches: 0, refinements: 0, transferBytes: 0, wallMs: 0, ...(gpu.timestampsEnabled ? { gpuMs: 0 } : {}) };
  // Retain only nonempty results for cross-pair topology refinement. Two
  // individually acceptable f32 endpoints can straddle a shared boundary.
  const records: { interval: Interval3; pair: VisibilityPair3; occluder: number }[][] = snapshot.features.map(() => []);
  // An f32 endpoint within the tolerance of a feature end reaches that end.
  const clampEnd = (t: number) => t <= tolerance ? 0 : t >= 1 - tolerance ? 1 : t;
  const tolerance = intervalTolerance3(snapshot, options.paperToleranceMm ?? .005, options.parameterTolerance);
  stats.paperToleranceMm = options.paperToleranceMm ?? .005;
  stats.parameterTolerance = tolerance;
  let pairs: VisibilityPair3[] = [], owners: number[] = [], occluderOf: number[] = [];
  const flush = async () => {
    options.signal?.throwIfAborted();
    const result = await gpu.classify(pairs, { signal: options.signal, parameterTolerance: tolerance });
    timing.merge(result.timings);
    timing.measure('finalizeMs', () => result.intervals.forEach((interval, i) => { if (interval) records[owners[i]].push({ interval: [clampEnd(interval[0]), clampEnd(interval[1])], pair: pairs[i], occluder: occluderOf[i] }); }));
    stats.dispatches += result.dispatches; stats.refinements += result.refinements; stats.transferBytes += result.transferBytes;
    if (result.gpuMs !== undefined) stats.gpuMs = (stats.gpuMs ?? 0) + result.gpuMs;
    pairs = []; owners = []; occluderOf = [];
  };
  let candidateStarted = performance.now();
  for (const candidate of candidatePairs3(snapshot)) {
    options.signal?.throwIfAborted();
    if (++stats.candidates > limit) throw new Error(`scene exceeds ${limit} candidate pairs; raise maxCandidates or reduce overlap`);
    pairs.push(candidate.pair); owners.push(candidate.feature); occluderOf.push(candidate.occluder);
    if (pairs.length === capacity) { timing.since('candidateMs',candidateStarted); await flush(); candidateStarted=performance.now(); }
  }
  timing.since('candidateMs',candidateStarted);
  if (pairs.length) await flush();
  const refinementStarted=performance.now();
  const adjacent = (i: number, j: number) => { const a = snapshot.occluders[i], b = snapshot.occluders[j]; return a.neighbors.includes(b.id) || b.neighbors.includes(a.id); };
  records.forEach((runs, feature) => {
    const { refine, closed } = refinementTargets3(runs.map(r => ({ interval: r.interval, occluder: r.occluder })), tolerance, adjacent);
    const intervals: (Interval3 | null)[] = runs.map((r,i) => {
      if (refine.has(i)) { stats.refinements++; return hiddenInterval3(r.pair.a,r.pair.b,r.pair.volume,r.pair.basis); }
      return r.interval;
    });
    // Close watertight abutments so the union carries no rounding gap.
    for (const { end, start } of closed) {
      const a = intervals[end], b = intervals[start]; if (!a || !b) continue;
      const seam = Math.max(a[1], b[0]); intervals[end] = [a[0], seam]; intervals[start] = [Math.min(b[0], seam), b[1]];
    }
    for (const interval of intervals) if (interval) hidden[feature].push(interval);
  });
  timing.since('refinementMs',refinementStarted);
  options.signal?.throwIfAborted(); stats.wallMs = performance.now() - start;
  const result=timing.measure('finalizeMs',()=>finish(snapshot, hidden, stats));
  return Object.freeze({...result,stats:Object.freeze({...result.stats,timings:timing.finish()})});
}

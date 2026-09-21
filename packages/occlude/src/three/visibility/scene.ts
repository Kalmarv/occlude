import { runGeometryJob3, runGeometryJobAsync3 } from '../geometry/job.js';
import { PhaseClock3, type PhaseTimings3 } from '../timing.js';
import { intervalTolerance3 } from './precision.js';
import { toPaper3, type CameraFrame3 } from '../camera.js';
import type { Occluder3, Feature3, FeatureSnapshot3 } from '../features/snapshot.js';
import { ProjectedIndex3, projectedBounds3, depthCutoff3, type Bounds3 } from './index.js';
import { rasterFilter3, type RasterFilter3 } from './raster.js';
import { hiddenInterval3, hiddenIntervalOf3, prepareSegment3, unionIntervals3, visibleIntervals3, type AffinePoint3, type Interval3, type OcclusionVolume3, type Plane3, type SegmentBasis3 } from './interval.js';
import type { WorldOcclusion3 } from './worldInterval.js';
import type { EncodedPoint3 } from '../geometry/exact.js';
import type { Triangle3, Vec3 } from '../math.js';
import { classifyWithPool3, poolWorkerCount3 } from './pool.js';
import { facingCertificate3, type FacingCertificate3, type FacingStats3 } from './facing.js';
import type { GpuIntervals3, VisibilityPair3 } from '../../compute/webgpu/interval.js';

export interface ClassifiedFeature3 { readonly feature: Feature3; readonly hidden: readonly Interval3[]; readonly visible: readonly Interval3[] }
export interface ClassifiedScene3 { readonly curveGraphs?:FeatureSnapshot3['curveGraphs']; readonly referenceFeatures?:readonly Feature3[]; readonly frame: CameraFrame3; readonly features: readonly ClassifiedFeature3[]; readonly stats: { candidates: number; dispatches: number; refinements: number; transferBytes: number; gpuMs?: number; paperToleranceMm?: number; parameterTolerance?: number; wallMs: number; timings?: PhaseTimings3; certificates?: FacingStats3 } }

/** Everything the exact classifier reads of a captured snapshot: the camera
 * frame, each feature's two endpoints, its basis and the ids of its own
 * supporting triangles, and each occluder's id, camera triangle, projected
 * bounds and occlusion volume. A `FeatureSnapshot3` is one of these; so is the
 * value a worker rebuilds from `classifyPayload3`, holding the same numbers.
 * Nothing else of the snapshot takes part, which is what makes the wire form
 * below complete rather than approximate. */
export type ClassifyFeature3 = Pick<Feature3, 'a' | 'b' | 'basis' | 'support'>;
export type ClassifyOccluder3 = Pick<Occluder3, 'id' | 'triangle' | 'volume'>;
export interface ClassifySource3 {
  readonly frame: CameraFrame3;
  readonly features: readonly ClassifyFeature3[];
  readonly occluders: readonly ClassifyOccluder3[];
  readonly occluderBounds: Float64Array;
  readonly occluderNearest: Float64Array;
  readonly index: ProjectedIndex3;
}
/** Bounded pair streaming. The index is queried with un-cropped paper bounds;
 * no side-frustum or page cull may discard future style overscan. */
export function* candidatePairs3(snapshot: FeatureSnapshot3, filter?: RasterFilter3): Generator<{ feature: number; occluder: number; pair: VisibilityPair3 }> {
  for (let i = 0; i < snapshot.features.length; i++) yield* featureCandidates3(snapshot, i, filter);
}
/** One feature's candidate pairs: the raster's cell walk when it covers the
 * feature (a tighter superset of the true overlaps), else the index. Both
 * keep the depth cutoff and exclude the feature's own supporting triangles. */
export function* featureCandidates3(snapshot: FeatureSnapshot3, i: number, filter?: RasterFilter3): Generator<{ feature: number; occluder: number; pair: VisibilityPair3 }> {
  const feature = snapshot.features[i], out: number[] = [];
  collectFeatureCandidates3(snapshot, i, filter, out);
  for (const j of out) yield { feature: i, occluder: j, pair: { a: feature.a, b: feature.b, volume: snapshot.occluders[j].volume, basis: feature.basis } };
}
/** `featureCandidates3` without the pair records: the occluder indices, in the
 * same order, appended to a caller-owned array. Every pair carries the same
 * two endpoints and the same basis — the feature's own — so a consumer that
 * reads them straight off the feature needs no record per candidate. */
export function collectFeatureCandidates3(snapshot: ClassifySource3, i: number, filter: RasterFilter3 | undefined, out: number[]): void {
  out.length = 0;
  const feature = snapshot.features[i], cutoff = depthCutoff3(Math.min(feature.a[2], feature.b[2]));
  const bounds = projectedBounds3([toPaper3(snapshot.frame, feature.a), toPaper3(snapshot.frame, feature.b)]);
  const support = feature.support, occluders = snapshot.occluders;
  if (filter) {
    // The cell walk over-approximates a diagonal segment by whole cells; the
    // enveloped bounds test the index path always applied rejects most of that
    // excess before any exact arithmetic (73% of the pairs on a dense torus).
    // Both tests read the per-view arrays the snapshot derived once: the same
    // bounds and the same maximum camera z the occluder record carries.
    const b = snapshot.occluderBounds, near = snapshot.occluderNearest;
    const x0 = bounds[0], y0 = bounds[1], x1 = bounds[2], y1 = bounds[3];
    if (filter.candidatesInto(i, out, (j) => {
      const o = j * 4;
      return x0 <= b[o + 2] && x1 >= b[o] && y0 <= b[o + 3] && y1 >= b[o + 1] && near[j] >= cutoff && !support.includes(occluders[j].id);
    })) return;
  }
  for (const j of snapshot.index.query(bounds, cutoff)) if (!support.includes(occluders[j].id)) out.push(j);
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
/** The exact classifier as a task-yielding job (a checkpoint every 1024
 * candidate pairs), so a worker can cancel it and keep its message loop alive;
 * same result as `classifySceneCpu3`. */
/** `raster: false` bypasses the certified raster filter (the exact classifier
 * alone), for oracles and for diagnosing a suspected filter fault.
 *
 * `certificates: false` does the same for the self-occlusion certificate:
 * every feature goes through the pairwise path. It exists so a test can put
 * the two answers side by side, and `raster: false` implies it — an oracle
 * asks for the exact classifier alone. `OCCLUDE_CERTIFICATES=0` says the same
 * to a whole process. Neither is a drawing mode: the certificate is proved
 * before it is used, so a picture is the same either way. */
export interface ClassifyOptions3 { readonly raster?: boolean; readonly certificates?: boolean }
/** The certificate this run may use, or null when it was asked for the
 * pairwise path alone. Computed once per scene, on the thread that holds the
 * snapshot, before any feature is handed anywhere. */
export function sceneCertificate3(snapshot: FeatureSnapshot3, options: ClassifyOptions3 = {}): FacingCertificate3 | null {
  if (options.raster === false || options.certificates === false) return null;
  if (options.certificates === undefined
    && (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OCCLUDE_CERTIFICATES === '0') return null;
  return facingCertificate3(snapshot);
}
export function* classifySceneCpuJob3(snapshot: FeatureSnapshot3, options: ClassifyOptions3 = {}, certificate?: FacingCertificate3 | null): Generator<void, ClassifiedScene3> {
  const start = performance.now(), hidden: Interval3[][] = snapshot.features.map(() => []); let candidates = 0;
  const filter = options.raster === false ? undefined : rasterFilter3(snapshot);
  const proved = (certificate === undefined ? sceneCertificate3(snapshot, options) : certificate) ?? undefined;
  yield;
  // One scratch list for the whole scene. Every pair of one feature names the
  // same endpoints and the same basis, so the occluder index is the only thing
  // that varies and a record per pair would be the same feature written out
  // 1.6 million times.
  const walked: number[] = [];
  let checkpoint = 1024;
  for (let i = 0; i < snapshot.features.length; i++) {
    candidates += classifyFeature3(snapshot, filter, i, walked, hidden[i], proved?.certified);
    if (candidates >= checkpoint) { checkpoint = candidates + 1024; yield; }
  }
  // Phase timings belong to the runner that drove the job.
  return finish(snapshot, hidden, { candidates, dispatches: 0, refinements: 0, transferBytes: 0, wallMs: performance.now() - start, ...(proved ? { certificates: proved.stats } : {}) });
}
/** One feature's hidden intervals, appended to `into`; the count of candidate
 * pairs tested is returned. This reads nothing but `(source, filter, i)` and
 * writes nothing but `into`, so feature i's answer is the same wherever it is
 * computed — which is the whole licence for classifying a range of features in
 * another thread and assembling the rows by index. `walked` is scratch the
 * caller owns and this rewrites. */
export function classifyFeature3(source: ClassifySource3, filter: RasterFilter3 | undefined, i: number, walked: number[], into: Interval3[], certified?: Uint8Array): number {
  // A certified feature is hidden over its whole length, written exactly as
  // the raster's own proof writes one: one closed interval, the same
  // normalisation, the same `finish`.
  if (certified?.[i]) { into.push([0, 1]); return 0; }
  if (filter?.provenHidden(i)) { into.push([0, 1]); return 0; }
  const feature = source.features[i], occluders = source.occluders;
  collectFeatureCandidates3(source, i, filter, walked);
  if (!walked.length) return 0;
  const segment = prepareSegment3(feature.a, feature.b, feature.basis);
  for (let k = 0; k < walked.length; k++) { const interval = hiddenIntervalOf3(segment, occluders[walked[k]].volume); if (interval) into.push(interval); }
  return walked.length;
}
/** The raster filter reads a snapshot's frame, its features' endpoints and its
 * occluders' camera triangles — the fields `ClassifySource3` names — so a
 * rebuilt source is one for its purposes. */
export const classifyFilter3 = (source: ClassifySource3): RasterFilter3 => rasterFilter3(source as FeatureSnapshot3);
export function classifySceneCpu3(snapshot: FeatureSnapshot3): ClassifiedScene3 {
  const job = runGeometryJob3(classifySceneCpuJob3(snapshot));
  return Object.freeze({...job.value, stats:Object.freeze({...job.value.stats,timings:job.timings})});
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

/* --------------------------------------------------------------------------
 * The classifier's input on a wire.
 *
 * Every feature's answer is a pure function of (source, i), so a range of
 * features can be classified in another thread and the rows assembled by
 * index. What crosses is this payload: typed arrays, one string of decimal
 * digits and two small plain records.
 *
 * It is a serialiser rather than a `structuredClone` of the snapshot's plain
 * parts because structured clone charges per object, not per byte. Measured
 * on the globe case (96 k occluders, 153 k features, 306 k basis terms):
 * cloning the snapshot's own objects costs 5.6 s per worker — 45 s of the
 * main thread for eight — while these arrays clone in tens of milliseconds
 * (a 96 k x 25 Float64Array clones in 18 ms). The snapshot also cannot be
 * cloned as it stands: its `index` is a class instance.
 * ------------------------------------------------------------------------ */

/** `occluderFlags` bits. */
const VOLUME_TRIANGLE = 1, VOLUME_PERSPECTIVE = 2, VOLUME_WORLD = 4;
export interface ClassifyPayload3 {
  readonly frame: CameraFrame3;
  /** The one world view every occlusion volume of a snapshot shares. */
  readonly view: WorldOcclusion3['view'] | null;
  /** 6 per feature: the camera-space `a` then `b`. */
  readonly featureEnds: Float64Array;
  /** 1 where the feature carries a basis, 0 where it has none. */
  readonly featureBasis: Uint8Array;
  /** 2f+1 term offsets; end `e` of feature `i` is `[t[2i+e], t[2i+e+1])`. */
  readonly termStart: Int32Array;
  readonly termPoint: Float64Array;
  readonly termWorld: Float64Array;
  readonly termHasWorld: Uint8Array;
  readonly termWeight: Float64Array;
  /** Index into the encoding table, or -1 for a term without an exact point. */
  readonly termEncoding: Int32Array;
  /** Every encoded coordinate concatenated, with the end offset of each: four
   * per encoded point. One string clones as one copy; 317 k of them do not. */
  readonly encodingChars: string;
  readonly encodingEnd: Int32Array;
  readonly supportStart: Int32Array;
  readonly supportIds: Int32Array;
  /** The distinct occluder ids, interned: a feature's support and an
   * occluder's id are the same string object again on the other side. */
  readonly ids: readonly string[];
  readonly occluderId: Int32Array;
  /** 9 per occluder: the camera-space triangle, which is the volume's too. */
  readonly occluderTriangle: Float64Array;
  readonly occluderFlags: Uint8Array;
  /** n+1 offsets in planes; each plane is four numbers of `planes`. */
  readonly planeStart: Int32Array;
  readonly planes: Float64Array;
  /** The distinct world positions the occluders' triangles name, 3 apiece.
   * A mesh vertex belongs to about six triangles and the exact layer caches
   * its exact point by the identity of the position it is handed, so the
   * sharing is rebuilt rather than flattened away. */
  readonly worldVertex: Float64Array;
  readonly occluderWorld: Int32Array;
  readonly occluderBounds: Float64Array;
  readonly occluderNearest: Float64Array;
  /** 1 where the pre-pass proved the whole feature hidden by its own shell,
   * or null when this run holds no certificate. One byte per feature: the
   * proof itself stays on the main thread, and only its verdict crosses. */
  readonly certified: Uint8Array | null;
}

/** Payload memory. Where the platform offers shared memory the arrays are
 * allocated in it, and the payload reaches every worker without a copy:
 * `structuredClone` charges 0.6 s for the globe case's 80 MB, which eight
 * workers would pay eight times over, on the one thread that has other work
 * to do. Node always offers it; a browser page offers it only when it is
 * cross-origin isolated, which the studio is not, so there the payload is
 * copied per worker and the fan-out keeps a smaller share of its win. The
 * numbers are the same either way: nothing writes to these arrays after the
 * payload is built. */
const sharedMemory = typeof SharedArrayBuffer === 'function';
const f64 = (length: number): Float64Array => sharedMemory ? new Float64Array(new SharedArrayBuffer(length * 8)) : new Float64Array(length);
const i32 = (length: number): Int32Array => sharedMemory ? new Int32Array(new SharedArrayBuffer(length * 4)) : new Int32Array(length);
const u8 = (length: number): Uint8Array => sharedMemory ? new Uint8Array(new SharedArrayBuffer(length)) : new Uint8Array(length);
const copyF64 = (from: Float64Array): Float64Array => { const out = f64(from.length); out.set(from); return out; };
const copyU8 = (from: Uint8Array): Uint8Array => { const out = u8(from.length); out.set(from); return out; };
const fill = <T extends Float64Array | Int32Array>(into: T, from: readonly number[]): T => { into.set(from); return into; };

const sameTriangle = (a: Triangle3, b: Triangle3): boolean =>
  a[0][0] === b[0][0] && a[0][1] === b[0][1] && a[0][2] === b[0][2]
  && a[1][0] === b[1][0] && a[1][1] === b[1][1] && a[1][2] === b[1][2]
  && a[2][0] === b[2][0] && a[2][1] === b[2][1] && a[2][2] === b[2][2];

/** This source as data a worker can be handed, or null when it holds a shape
 * the wire form does not describe — several world views in one snapshot, or a
 * volume whose triangle is not the occluder's own. `featureSnapshot3` produces
 * neither; a caller that meets one runs the serial loop, which is the same
 * answer. */
export function classifyPayload3(source: ClassifySource3, certified?: Uint8Array): ClassifyPayload3 | null {
  const features = source.features, occluders = source.occluders, f = features.length, n = occluders.length;
  let view: WorldOcclusion3['view'] | null = null, planeCount = 0, termCount = 0;
  for (let j = 0; j < n; j++) {
    const volume = occluders[j].volume;
    planeCount += volume.planes.length;
    if (volume.world) { if (view && volume.world.view !== view) return null; view ??= volume.world.view; }
    if (volume.triangle && !sameTriangle(volume.triangle, occluders[j].triangle)) return null;
  }
  for (let i = 0; i < f; i++) { const basis = features[i].basis; if (basis) termCount += basis[0].length + basis[1].length; }

  const featureEnds = f64(f * 6), featureBasis = u8(f);
  const termStart = i32(f * 2 + 1), termPoint = f64(termCount * 3);
  const termWorld = f64(termCount * 3), termHasWorld = u8(termCount);
  const termWeight = f64(termCount), termEncoding = i32(termCount).fill(-1);
  const supportStart = i32(f + 1), occluderId = i32(n);
  const occluderTriangle = f64(n * 9), occluderFlags = u8(n);
  const planeStart = i32(n + 1), planes = f64(planeCount * 4);
  const occluderWorld = i32(n * 3);
  const ids: string[] = [], idOf = new Map<string, number>();
  const worldVertices: number[] = [], worldOf = new Map<Vec3, number>();
  const encodingOf = new Map<EncodedPoint3, number>(), encodingParts: string[] = [];
  const encodingEnds: number[] = [];
  const intern = (id: string): number => { let k = idOf.get(id); if (k === undefined) { k = ids.length; ids.push(id); idOf.set(id, k); } return k; };
  const write3 = (into: Float64Array, at: number, p: Vec3): void => { into[at] = p[0]; into[at + 1] = p[1]; into[at + 2] = p[2]; };

  for (let j = 0, plane = 0; j < n; j++) {
    const occluder = occluders[j], volume = occluder.volume, triangle = occluder.triangle;
    write3(occluderTriangle, j * 9, triangle[0]); write3(occluderTriangle, j * 9 + 3, triangle[1]); write3(occluderTriangle, j * 9 + 6, triangle[2]);
    occluderId[j] = intern(occluder.id);
    occluderFlags[j] = (volume.triangle ? VOLUME_TRIANGLE : 0) | (volume.perspective ? VOLUME_PERSPECTIVE : 0) | (volume.world ? VOLUME_WORLD : 0);
    planeStart[j] = plane;
    for (const p of volume.planes) { planes[plane * 4] = p[0]; planes[plane * 4 + 1] = p[1]; planes[plane * 4 + 2] = p[2]; planes[plane * 4 + 3] = p[3]; plane++; }
    planeStart[j + 1] = plane;
    if (volume.world) for (let k = 0; k < 3; k++) {
      const position = volume.world.triangle[k];
      let index = worldOf.get(position);
      if (index === undefined) { index = worldVertices.length / 3; worldOf.set(position, index); worldVertices.push(position[0], position[1], position[2]); }
      occluderWorld[j * 3 + k] = index;
    }
  }

  const supportIdList: number[] = [];
  for (let i = 0, term = 0; i < f; i++) {
    const feature = features[i];
    write3(featureEnds, i * 6, feature.a); write3(featureEnds, i * 6 + 3, feature.b);
    supportStart[i] = supportIdList.length;
    // A support id that names no occluder can never match one, so it is left
    // behind rather than interned: `support.includes(occluders[j].id)` reads
    // the same either way.
    for (const id of feature.support) { const k = idOf.get(id); if (k !== undefined) supportIdList.push(k); }
    featureBasis[i] = feature.basis ? 1 : 0;
    for (let e = 0; e < 2; e++) {
      termStart[i * 2 + e] = term;
      for (const t of feature.basis?.[e] ?? []) {
        write3(termPoint, term * 3, t.point);
        if (t.world) { write3(termWorld, term * 3, t.world); termHasWorld[term] = 1; }
        termWeight[term] = t.weight;
        if (t.exactWorld) {
          let index = encodingOf.get(t.exactWorld);
          if (index === undefined) {
            index = encodingEnds.length / 4; encodingOf.set(t.exactWorld, index);
            for (const digits of t.exactWorld) { encodingParts.push(digits); encodingEnds.push(digits.length); }
          }
          termEncoding[term] = index;
        }
        term++;
      }
    }
    termStart[i * 2 + 2] = term;
  }
  supportStart[f] = supportIdList.length;
  const encodingEnd = i32(encodingEnds.length);
  for (let k = 0, at = 0; k < encodingEnds.length; k++) { at += encodingEnds[k]; encodingEnd[k] = at; }
  return {
    frame: source.frame, view,
    featureEnds, featureBasis, termStart, termPoint, termWorld, termHasWorld, termWeight, termEncoding,
    encodingChars: encodingParts.join(''), encodingEnd,
    supportStart, supportIds: fill(i32(supportIdList.length), supportIdList), ids,
    occluderId, occluderTriangle, occluderFlags, planeStart, planes,
    worldVertex: fill(f64(worldVertices.length), worldVertices), occluderWorld,
    occluderBounds: copyF64(source.occluderBounds), occluderNearest: copyF64(source.occluderNearest),
    certified: certified ? copyU8(certified) : null,
  };
}

/** The payload read back as a classifier source. Every value is the number the
 * snapshot held; what is rebuilt rather than copied is the sharing the exact
 * layer's identity caches rely on — one world position per distinct vertex,
 * one interned id string, one frozen encoding per exact point (frozen because
 * `decodePoint` only keeps a decoded point for a frozen encoding), and one
 * object per occluder and per feature, so a `WeakMap` keyed on a volume or a
 * basis still answers on the second visit.
 *
 * What a worker never reaches for, it never builds. A pool of workers splits
 * the features between them, and a worker walks the exact geometry of only
 * the occluders its own features meet; materialising the whole scene in each
 * of them costs the time three times over and, worse, three copies of the
 * same working set in a cache that holds one. Each row below is built on
 * first read and kept from then on. */
class WireOccluder3 {
  private camera?: Triangle3;
  private occlusion?: OcclusionVolume3;
  /** Read straight off the wire: the broad phase asks every walked occluder
   * for its id, before anything decides to look closer. */
  readonly id: string;
  constructor(private readonly wire: ClassifyPayload3, private readonly at: number, private readonly world: readonly Vec3[]) {
    this.id = wire.ids[wire.occluderId[at]];
  }
  get triangle(): Triangle3 {
    return this.camera ??= Object.freeze([read3(this.wire.occluderTriangle, this.at * 9), read3(this.wire.occluderTriangle, this.at * 9 + 3), read3(this.wire.occluderTriangle, this.at * 9 + 6)]) as unknown as Triangle3;
  }
  get volume(): OcclusionVolume3 {
    if (this.occlusion) return this.occlusion;
    const wire = this.wire, at = this.at, flags = wire.occluderFlags[at], faces: Plane3[] = [];
    for (let p = wire.planeStart[at]; p < wire.planeStart[at + 1]; p++) faces.push(Object.freeze([wire.planes[p * 4], wire.planes[p * 4 + 1], wire.planes[p * 4 + 2], wire.planes[p * 4 + 3]]) as unknown as Plane3);
    const world = (flags & VOLUME_WORLD) && wire.view
      ? Object.freeze({ triangle: Object.freeze([this.world[wire.occluderWorld[at * 3]], this.world[wire.occluderWorld[at * 3 + 1]], this.world[wire.occluderWorld[at * 3 + 2]]]) as unknown as Triangle3, view: wire.view })
      : undefined;
    return this.occlusion = Object.freeze({
      planes: Object.freeze(faces), perspective: (flags & VOLUME_PERSPECTIVE) !== 0,
      ...(flags & VOLUME_TRIANGLE ? { triangle: this.triangle } : {}), ...(world ? { world } : {}),
    });
  }
}
class WireFeature3 {
  private ends?: readonly [Vec3, Vec3];
  private terms?: SegmentBasis3;
  private own?: readonly string[];
  constructor(private readonly wire: ClassifyPayload3, private readonly at: number, private readonly encoding: (k: number) => EncodedPoint3) {}
  private get pair(): readonly [Vec3, Vec3] {
    return this.ends ??= [read3(this.wire.featureEnds, this.at * 6), read3(this.wire.featureEnds, this.at * 6 + 3)];
  }
  get a(): Vec3 { return this.pair[0]; }
  get b(): Vec3 { return this.pair[1]; }
  get basis(): SegmentBasis3 | undefined {
    if (!this.wire.featureBasis[this.at]) return undefined;
    if (this.terms) return this.terms;
    const wire = this.wire, end = (e: number): AffinePoint3 => {
      const out: AffinePoint3[number][] = [];
      for (let t = wire.termStart[this.at * 2 + e]; t < wire.termStart[this.at * 2 + e + 1]; t++) out.push(Object.freeze({
        point: read3(wire.termPoint, t * 3),
        ...(wire.termHasWorld[t] ? { world: read3(wire.termWorld, t * 3) } : {}),
        ...(wire.termEncoding[t] >= 0 ? { exactWorld: this.encoding(wire.termEncoding[t]) } : {}),
        weight: wire.termWeight[t],
      }));
      return Object.freeze(out);
    };
    return this.terms = Object.freeze([end(0), end(1)]) as SegmentBasis3;
  }
  get support(): readonly string[] {
    if (this.own) return this.own;
    const out: string[] = [];
    for (let k = this.wire.supportStart[this.at]; k < this.wire.supportStart[this.at + 1]; k++) out.push(this.wire.ids[this.wire.supportIds[k]]);
    return this.own = Object.freeze(out);
  }
}
const read3 = (from: Float64Array, at: number): Vec3 => Object.freeze([from[at], from[at + 1], from[at + 2]]) as Vec3;

export function classifySource3(payload: ClassifyPayload3): ClassifySource3 {
  const f = payload.featureBasis.length, n = payload.occluderId.length;
  // The world vertices are shared by about six triangles each and the exact
  // layer caches a vertex's exact point by the identity of the position it is
  // handed, so these are built once, up front, for everybody.
  const worldVertex: Vec3[] = [];
  for (let k = 0; k < payload.worldVertex.length; k += 3) worldVertex.push(read3(payload.worldVertex, k));
  const encodings: EncodedPoint3[] = new Array(payload.encodingEnd.length / 4);
  const encoding = (k: number): EncodedPoint3 => encodings[k] ??= Object.freeze([
    payload.encodingChars.slice(k === 0 ? 0 : payload.encodingEnd[k * 4 - 1], payload.encodingEnd[k * 4]),
    payload.encodingChars.slice(payload.encodingEnd[k * 4], payload.encodingEnd[k * 4 + 1]),
    payload.encodingChars.slice(payload.encodingEnd[k * 4 + 1], payload.encodingEnd[k * 4 + 2]),
    payload.encodingChars.slice(payload.encodingEnd[k * 4 + 2], payload.encodingEnd[k * 4 + 3]),
  ]) as unknown as EncodedPoint3;
  const occluders: ClassifyOccluder3[] = new Array(n);
  for (let j = 0; j < n; j++) occluders[j] = new WireOccluder3(payload, j, worldVertex);
  const features: ClassifyFeature3[] = new Array(f);
  for (let i = 0; i < f; i++) features[i] = new WireFeature3(payload, i, encoding);
  // The index is the candidate walk's fallback route, built only if a feature
  // leaves the raster — the same bargain the snapshot strikes.
  let index: ProjectedIndex3 | undefined;
  const bounds = payload.occluderBounds;
  return {
    frame: payload.frame, features, occluders,
    occluderBounds: bounds, occluderNearest: payload.occluderNearest,
    get index() {
      return index ??= new ProjectedIndex3(
        Array.from({ length: n }, (_, j): Bounds3 => [bounds[j * 4], bounds[j * 4 + 1], bounds[j * 4 + 2], bounds[j * 4 + 3]]),
        Array.from(payload.occluderNearest),
      );
    },
  };
}

/** How much work a scene must hold before the fan-out pays for itself:
 * features times occluders, which costs nothing to know and bounds the
 * candidate pairs from above. Measured on the bench cases with three workers:
 * the 200-box scene (2376 features x 2376 occluders = 5.6e6) classifies in
 * 367 ms on one thread and 503 ms on three, because the payload, the spawn
 * and three raster builds cost more than the work; the hatch sphere (7.6e8)
 * is the smallest case that wins, 2.63 s against 2.35 s. The line sits an
 * order of magnitude clear of each. It is a scheduling rule, not a capacity
 * cap: above it every worker is used, below it none is. */
const PARALLEL_WORK_3 = 5e7;
export interface ClassifySceneOptions3 extends ClassifyOptions3 {
  readonly signal?: AbortSignal;
  /** Workers to classify with; 1 stays inline, and naming one at all asks for
   * the fan-out whatever the scene's size. `OCCLUDE_WORKERS` says the same in
   * node; with neither, `poolWorkerCount3` decides and the crossover applies. */
  readonly workers?: number;
}
/** The classifier a render drives: a pool of workers when the scene is big
 * enough to pay for the fan-out, the serial generator otherwise and whenever
 * a worker cannot be had. Both arrive at the same intervals — the parallel path runs
 * the same per-feature function over the same numbers and assembles the rows
 * by index, and hands them to the same `finish`. */
export async function classifyScene3(snapshot: FeatureSnapshot3, options: ClassifySceneOptions3 = {}): Promise<ClassifiedScene3> {
  const timing = new PhaseClock3();
  // The pre-pass runs here, once, on this thread: it reads the snapshot's own
  // meshes, which the wire form does not carry, and its answer does not depend
  // on which thread a feature is classified on. Its own cost is reported by
  // `stats.certificates.ms`; `setupMs` stays what it says it is, the payload
  // build that only a fanned-out run pays.
  const certificate = sceneCertificate3(snapshot, options);
  const parallel = await classifyParallel3(snapshot, options, timing, certificate);
  if (parallel) return parallel;
  const job = await runGeometryJobAsync3(classifySceneCpuJob3(snapshot, options, certificate), options.signal);
  timing.merge(job.timings);
  return Object.freeze({ ...job.value, stats: Object.freeze({ ...job.value.stats, timings: timing.finish() }) });
}
async function classifyParallel3(snapshot: FeatureSnapshot3, options: ClassifySceneOptions3, timing: PhaseClock3, certificate: FacingCertificate3 | null): Promise<ClassifiedScene3 | null> {
  // `raster: false` is the oracle's request for the exact classifier alone;
  // it is a diagnosis, not a drawing, and stays on one thread.
  if (options.raster === false) return null;
  const features = snapshot.features.length;
  if (poolWorkerCount3(options.workers) < 2) return null;
  // A caller that names a worker count has asked for the fan-out and gets it
  // whatever the scene's size; the crossover is what decides when nobody asked,
  // which includes every render the tools and the studio drive.
  if (options.workers === undefined && features * snapshot.occluders.length < PARALLEL_WORK_3) return null;
  const start = performance.now();
  const payload = timing.measure('setupMs', () => classifyPayload3(snapshot, certificate?.certified));
  if (!payload) return null;
  const run = await timing.wait('queueMs', () => classifyWithPool3(payload, features, { signal: options.signal, workers: options.workers }));
  if (!run) return null;
  const result = timing.measure('finalizeMs', () => finish(snapshot, run.hidden, { candidates: run.candidates, dispatches: 0, refinements: 0, transferBytes: 0, wallMs: performance.now() - start, ...(certificate ? { certificates: certificate.stats } : {}) }));
  return Object.freeze({ ...result, stats: Object.freeze({ ...result.stats, timings: timing.finish() }) });
}

/**
 * Radial containment: the ink of one shell that lies strictly inside another
 * shell's solid, proved before the classifier tests a single candidate pair.
 *
 * Follow-up report §1.3 and the measured pass in tools/globe-certs/batched.ts,
 * which this is the production reading of. The theorem is short. Let an
 * occluder mesh be a closed, consistently outward-oriented surface that is
 * RADIAL about a point o — every supporting plane strictly separates o
 * (H_T > 0), and one generic ray from o meets exactly one triangle, so the
 * cones {o + cone(T)} tile space and each carries one sheet. Then a point p is
 * inside that solid exactly when, for the cone it lies in, it is strictly on
 * o's side of that cone's face plane. A point strictly inside the solid, with
 * the camera strictly outside it, is hidden: the sight segment leaves the
 * solid at a boundary point strictly in front of p, and that blocker is a
 * triangle of the OTHER object, so it is never among the feature's own
 * supports, which is what makes the certified answer the pairwise answer.
 *
 * The work is batched by SOURCE TRIANGLE, which is what makes it pay:
 *
 *   1. the cones the source triangle's own cone can meet are enumerated once —
 *      seeded by a walk and grown across edges, keeping every neighbour the
 *      two-way cone separation test cannot rule out. That is complete, not a
 *      guess: the occluder's cones tile the sphere about o, the source
 *      triangle's spherical image is connected, and the triangles meeting a
 *      connected region are connected through edges.
 *   2. the three corner values F_T(v_k) are computed once per (source
 *      triangle, cone) and reused by every feature on that triangle. All three
 *      strictly negative for EVERY candidate cone certifies the whole source
 *      triangle at once, features and all, with no value arithmetic.
 *   3. otherwise each feature endpoint is a convex combination of those
 *      corners with the very integer weights the producer built the point
 *      with, so F_T at the endpoint is the affine identity
 *      F_T(p) = (Σ w_k F_T(v_k)) / (Σ w_k), w_k ≥ 0 — the classifier's own
 *      point, not a redefinition of it. All corners strictly inside decides it
 *      by convexity; otherwise an outward-rounded interval sum; and only when
 *      that holds zero, the exact homogeneous descriptor.
 *
 * Every sign is exact or abstains, and an abstention withholds the
 * certificate. `orient3d` is Shewchuk's adaptive predicate on the stored
 * doubles: every mesh vertex is a double, so a plane or cone sign at an
 * ORIGINAL point is exact with no expansion of ours. The centre enters as
 * `orient3d`'s fourth point rather than by translating the mesh, so the
 * predicates stay exact wherever the centre is.
 *
 * Nothing here believes a recorded centre. `radialAbout3` re-proves radiality
 * from the triangles, so a stale or invented centre costs a failed proof and
 * can never grant one.
 */
import { orient3d } from 'robust-predicates';
import { cross, difference, dot3 as dotExact, point, type H, type V } from '../geometry/exact.js';
import type { Feature3, FeatureSnapshot3, OccluderMesh3 } from '../features/snapshot.js';
import { hasWorldTerms3, worldSegment3 } from './worldInterval.js';
import type { Vec3 } from '../math.js';

const signOf = (value: number): number => value > 0 ? 1 : value < 0 ? -1 : 0;
/** `sign det[b − a, c − a, d − a]`, exactly. `robust-predicates` returns its
 * negative, and every caller below wants the determinant's own sign. */
const det4 = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): number =>
  -orient3d(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
/** Is `q` on the positive side of the radial half-plane through the edge
 * `a → b` and the centre? `sign det[a − o, b − o, q − o]`, exactly. */
const coneSide = (a: Vec3, b: Vec3, q: readonly number[], o: Vec3): number =>
  signOf(orient3d(a[0], a[1], a[2], b[0], b[1], b[2], q[0], q[1], q[2], o[0], o[1], o[2]));

const bits = new DataView(new ArrayBuffer(8));
/** The next binary64 away from zero, for an outward nudge. */
function nextUp(x: number): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return Number.MIN_VALUE;
  bits.setFloat64(0, x);
  bits.setBigUint64(0, bits.getBigUint64(0) + (x > 0 ? 1n : -1n));
  return bits.getFloat64(0);
}
/** The next binary64 toward zero and past it. */
function nextDown(x: number): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return -Number.MIN_VALUE;
  bits.setFloat64(0, x);
  bits.setBigUint64(0, bits.getBigUint64(0) + (x > 0 ? -1n : 1n));
  return bits.getFloat64(0);
}

/* -- radiality ------------------------------------------------------------- */

/**
 * Is this mesh star-shaped about `centre`, provably? Two conditions, both
 * exact: every triangle's supporting plane strictly separates the centre
 * (H_T > 0), and one generic ray from the centre meets exactly one triangle's
 * interior — which is what makes the cones a tiling with one sheet apiece. A
 * ray that grazes an edge decides nothing and the next ray of the family is
 * tried; twelve abstentions in a row withhold the certificate.
 *
 * Closed, connected, consistently oriented and outward come from the caller's
 * own shell verdict, which has already proved them.
 */
export function radialAbout3(mesh: OccluderMesh3, centre: Vec3): boolean {
  const p = mesh.positions, triangles = mesh.triangles;
  if (!triangles.length) return false;
  for (const [a, b, c] of triangles) if (det4(centre, p[a], p[b], p[c]) <= 0) return false;
  for (let attempt = 0, t = 1024; attempt < 12; attempt++, t *= 2) {
    // (1, t, t²) from the centre: a deterministic family, not a guess.
    const q: Vec3 = Object.freeze([centre[0] + 1, centre[1] + t, centre[2] + t * t]) as Vec3;
    if (!q.every(Number.isFinite)) return false;
    let hits = 0, degenerate = false;
    for (const [a, b, c] of triangles) {
      const s0 = coneSide(p[a], p[b], q, centre);
      const s1 = s0 === 0 ? 0 : coneSide(p[b], p[c], q, centre);
      const s2 = s1 === 0 ? 0 : coneSide(p[c], p[a], q, centre);
      if (s0 === 0 || s1 === 0 || s2 === 0) { degenerate = true; break; }
      if (s0 > 0 && s1 > 0 && s2 > 0) hits++;
    }
    if (!degenerate) return hits === 1;
  }
  return false;
}

/* -- the cone tiling ------------------------------------------------------- */

/** Edge adjacency of a mesh's triangles: for triangle `t`, the neighbour
 * across corner pair 0 = (a,b), 1 = (b,c), 2 = (c,a), or -1. */
function adjacency(mesh: OccluderMesh3): Int32Array {
  const V = mesh.positions.length, triangles = mesh.triangles;
  const owner = new Map<number, number>();
  const out = new Int32Array(triangles.length * 3).fill(-1);
  const edgeKey = (a: number, b: number) => a < b ? a * V + b : b * V + a;
  triangles.forEach(([a, b, c], t) => {
    ([[a, b], [b, c], [c, a]] as const).forEach(([u, v], e) => {
      const k = edgeKey(u, v), seen = owner.get(k);
      if (seen === undefined) { owner.set(k, t * 3 + e); return; }
      out[t * 3 + e] = (seen / 3) | 0;
      out[seen] = t;
    });
  });
  return out;
}
/** The first strictly violated cone side of `t`, or -1 for a hit. */
function coneMiss(mesh: OccluderMesh3, centre: Vec3, t: number, q: readonly number[]): number {
  const [a, b, c] = mesh.triangles[t], p = mesh.positions;
  if (coneSide(p[a], p[b], q, centre) < 0) return 0;
  if (coneSide(p[b], p[c], q, centre) < 0) return 1;
  if (coneSide(p[c], p[a], q, centre) < 0) return 2;
  return -1;
}
/** Walk across violated cone sides until the cone holding `q` is reached. */
function walkTo(mesh: OccluderMesh3, centre: Vec3, adj: Int32Array, from: number, q: readonly number[], limit: number): number {
  let t = from;
  for (let steps = 0; steps <= limit; steps++) {
    const miss = coneMiss(mesh, centre, t, q);
    if (miss < 0) return t;
    const next = adj[t * 3 + miss];
    if (next < 0) return -1;
    t = next;
  }
  return -1;
}
/** Can the cone of `t` meet the cone spanned by `dirs`? Face-plane separation
 * both ways; a false "they may meet" costs one test, and a false "disjoint" is
 * impossible because every sign is exact. */
function conesDisjoint(mesh: OccluderMesh3, centre: Vec3, t: number, dirs: readonly Vec3[]): boolean {
  const [a, b, c] = mesh.triangles[t], p = mesh.positions;
  for (const [u, v] of [[p[a], p[b]], [p[b], p[c]], [p[c], p[a]]] as const) {
    if (coneSide(u, v, dirs[0], centre) < 0 && coneSide(u, v, dirs[1], centre) < 0 && coneSide(u, v, dirs[2], centre) < 0) return true;
  }
  for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
    if (coneSide(dirs[i], dirs[j], p[a], centre) < 0 && coneSide(dirs[i], dirs[j], p[b], centre) < 0 && coneSide(dirs[i], dirs[j], p[c], centre) < 0) return true;
  }
  return false;
}

/* -- the filtered plane value ---------------------------------------------- */

const U = Number.EPSILON / 2;
/** Shewchuk's static `orient3d` filter constant. */
const ORIENT3D_ERRBOUND = (7 + 56 * U) * U;
/** `det(p1 − p0, p2 − p0, q − p0)` in binary64 with a sound outward bound —
 * exactly the expression `orient3d(p1, p2, q, p0)` filters, so the published
 * constant applies to it. */
function faceValue(p0: Vec3, p1: Vec3, p2: Vec3, q: readonly number[]): { det: number; err: number } {
  const adx = p1[0] - p0[0], ady = p1[1] - p0[1], adz = p1[2] - p0[2];
  const bdx = p2[0] - p0[0], bdy = p2[1] - p0[1], bdz = p2[2] - p0[2];
  const cdx = q[0] - p0[0], cdy = q[1] - p0[1], cdz = q[2] - p0[2];
  const bdxcdy = bdx * cdy, cdxbdy = cdx * bdy;
  const cdxady = cdx * ady, adxcdy = adx * cdy;
  const adxbdy = adx * bdy, bdxady = bdx * ady;
  const det = adz * (bdxcdy - cdxbdy) + bdz * (cdxady - adxcdy) + cdz * (adxbdy - bdxady);
  const permanent = (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * Math.abs(adz)
    + (Math.abs(cdxady) + Math.abs(adxcdy)) * Math.abs(bdz)
    + (Math.abs(adxbdy) + Math.abs(bdxady)) * Math.abs(cdz);
  return { det, err: ORIENT3D_ERRBOUND * permanent };
}
/** The exact sign of that determinant, adaptively. */
const faceSignExact = (p0: Vec3, p1: Vec3, p2: Vec3, q: readonly number[]): number =>
  signOf(orient3d(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], q[0], q[1], q[2], p0[0], p0[1], p0[2]));
/** The same sign at an exact homogeneous point — the classifier's own point,
 * built only when both filters abstain. */
function planeSignExact(mesh: OccluderMesh3, exact: (v: number) => H, t: number, p: H): number {
  const [i0, i1, i2] = mesh.triangles[t];
  const a = exact(i0), b = exact(i1), c = exact(i2);
  const n: V = cross(difference(b, a), difference(c, a));
  const s = dotExact(n, difference(p, a));
  return s > 0n ? 1 : s < 0n ? -1 : 0;
}

/* -- one source triangle's batch ------------------------------------------- */

interface Counters {
  sources: number; pairs: number; wholeSourceCerts: number;
  cornerValues: number; cornerAdaptive: number;
  endpointTests: number; convexDecisions: number; intervalDecisions: number;
  exactFallbacks: number; ties: number; seedFailures: number; visited: number; rejected: number;
}
/** The three corner values of one source triangle against its candidate cones,
 * computed on demand and kept for every feature on that triangle. */
class SourceBatch {
  private readonly det: Float64Array;
  private readonly err: Float64Array;
  private readonly sgn: Int8Array;
  constructor(
    private readonly occluder: OccluderMesh3, readonly cones: Int32Array,
    private readonly corners: readonly Vec3[], private readonly counters: Counters,
  ) {
    this.det = new Float64Array(cones.length * 3);
    this.err = new Float64Array(cones.length * 3);
    this.sgn = new Int8Array(cones.length * 3).fill(2);      // 2 = not yet known
  }
  sign(ci: number, k: number): number {
    const at = ci * 3 + k;
    const known = this.sgn[at];
    if (known !== 2) return known;
    const [a, b, c] = this.occluder.triangles[this.cones[ci]], p = this.occluder.positions;
    const v = faceValue(p[a], p[b], p[c], this.corners[k]);
    this.det[at] = v.det; this.err[at] = v.err;
    this.counters.cornerValues++;
    let s: number;
    if (v.det > v.err) s = 1;
    else if (v.det < -v.err) s = -1;
    else { s = faceSignExact(p[a], p[b], p[c], this.corners[k]); this.counters.cornerAdaptive++; }
    this.sgn[at] = s as -1 | 0 | 1;
    return s;
  }
  value(ci: number, k: number): { det: number; err: number } {
    this.sign(ci, k);
    return { det: this.det[ci * 3 + k], err: this.err[ci * 3 + k] };
  }
}
/** Outward-rounded interval sum of `w_k · F_T(v_k)` over nonnegative weights. */
function intervalSign(batch: SourceBatch, ci: number, weights: readonly number[]): number {
  let lo = 0, hi = 0;
  for (let k = 0; k < 3; k++) {
    const w = weights[k];
    if (w === 0) continue;
    const wlo = nextDown(w), whi = nextUp(w);
    const v = batch.value(ci, k);
    const flo = nextDown(v.det - v.err), fhi = nextUp(v.det + v.err);
    const plo = flo < 0 ? whi * flo : wlo * flo;
    const phi = fhi > 0 ? whi * fhi : wlo * fhi;
    lo = nextDown(lo + nextDown(plo));
    hi = nextUp(hi + nextUp(phi));
  }
  return hi < 0 ? -1 : lo > 0 ? 1 : 0;
}

/* -- the affine descriptors ------------------------------------------------ */

/** One feature as nonnegative weights over the three corners of one source
 * triangle, for each endpoint: the very weights the producer built the point
 * with for a generated curve, the corner indicators for a mesh edge. */
interface Descriptor { readonly triangle: number; readonly wa: readonly number[]; readonly wb: readonly number[] }

/* -- the pass -------------------------------------------------------------- */

export interface ContainmentStats3 {
  readonly ms: number;
  /** Meshes carrying a recorded centre that the radial proof accepted. */
  readonly radialMeshes: number;
  /** Ordered (source, occluder) shell pairs the pass ran. */
  readonly shellPairs: number;
  /** Features it had a descriptor for, and features it had none for. */
  readonly attempted: number;
  readonly noDescriptor: number;
  readonly sources: number;
  readonly conePairs: number;
  readonly wholeSourceCerts: number;
  readonly certifiedFeatures: number;
  readonly cornerValues: number;
  readonly cornerAdaptive: number;
  readonly endpointTests: number;
  readonly convexDecisions: number;
  readonly intervalDecisions: number;
  readonly exactFallbacks: number;
  readonly ties: number;
  readonly seedFailures: number;
}
const NOTHING: ContainmentStats3 = Object.freeze({
  ms: 0, radialMeshes: 0, shellPairs: 0, attempted: 0, noDescriptor: 0, sources: 0, conePairs: 0,
  wholeSourceCerts: 0, certifiedFeatures: 0, cornerValues: 0, cornerAdaptive: 0, endpointTests: 0,
  convexDecisions: 0, intervalDecisions: 0, exactFallbacks: 0, ties: 0, seedFailures: 0,
});
/** The largest squared distance from the centre to a vertex — which shell
 * reaches farther out. A choice of direction, never of verdict: it decides
 * which ordered pair is worth running, and the proof below is the same
 * whichever pair it picks. */
const outerReach = (mesh: OccluderMesh3, centre: Vec3): number => {
  let best = 0;
  for (const q of mesh.positions) {
    const d = (q[0] - centre[0]) ** 2 + (q[1] - centre[1]) ** 2 + (q[2] - centre[2]) ** 2;
    if (d > best) best = d;
  }
  return best;
};

/**
 * Every feature the pass can prove lies inside another shell's solid, written
 * into `certified` beside the facing verdicts the caller already holds.
 *
 * `usable` is the caller's own shell verdict: true only when that mesh is a
 * complete, closed, outward-oriented shell with the camera strictly outside
 * it, which is what an occluder must be here.
 */
export function containmentCertificate3(
  snapshot: FeatureSnapshot3, usable: (mesh: OccluderMesh3) => boolean, certified: Uint8Array,
): { added: number; stats: ContainmentStats3 } {
  const started = performance.now();
  const meshes = (snapshot.occluderMeshes as readonly OccluderMesh3[] | undefined) ?? [];
  // Two shells about one recorded centre, or there is nothing to contain.
  const groups = new Map<string, OccluderMesh3[]>();
  for (const mesh of meshes) {
    const centre = mesh.radialCentre;
    if (!centre || !mesh.complete || !mesh.pointIds) continue;
    const key = `${centre[0]},${centre[1]},${centre[2]}`;
    const row = groups.get(key);
    if (row) row.push(mesh); else groups.set(key, [mesh]);
  }
  for (const [key, row] of groups) if (row.length < 2) groups.delete(key);
  if (!groups.size) return { added: 0, stats: NOTHING };

  const counters: Counters = {
    sources: 0, pairs: 0, wholeSourceCerts: 0, cornerValues: 0, cornerAdaptive: 0, endpointTests: 0,
    convexDecisions: 0, intervalDecisions: 0, exactFallbacks: 0, ties: 0, seedFailures: 0, visited: 0, rejected: 0,
  };
  let radialMeshes = 0, shellPairs = 0, attempted = 0, noDescriptor = 0, added = 0;

  // Which mesh and which triangle an occluder id names, once for the scene.
  const located = new Map<string, { mesh: OccluderMesh3; triangle: number }>();
  for (const mesh of meshes) mesh.triangleIds.forEach((id, t) => { if (!located.has(id)) located.set(id, { mesh, triangle: t }); });
  const vertexIndex = new Map<OccluderMesh3, Map<string, number>>();
  const verticesOf = (mesh: OccluderMesh3): Map<string, number> => {
    let found = vertexIndex.get(mesh);
    if (!found) { found = new Map(); (mesh.pointIds ?? []).forEach((id, i) => found!.set(id, i)); vertexIndex.set(mesh, found); }
    return found;
  };
  const graphs = snapshot.curveGraphs ?? [];
  /** The mesh a feature's own support lies on, when it lies on exactly one. */
  const meshOf = (feature: Feature3): OccluderMesh3 | undefined => {
    let owner: OccluderMesh3 | undefined;
    for (const id of feature.support) {
      const row = located.get(id);
      if (!row) return undefined;
      if (owner && owner !== row.mesh) return undefined;
      owner = row.mesh;
    }
    return owner;
  };
  const descriptorOf = (feature: Feature3, mesh: OccluderMesh3): Descriptor | undefined => {
    // A clipped feature's ends are no longer the points these weights name.
    if (feature.range[0] !== 0 || feature.range[1] !== 1) return undefined;
    if (feature.supportedCurve) {
      // One support and one triangle id: the id IS that support's triangle,
      // and the producer's own integer weights name both endpoints on it.
      const segment = graphs[feature.supportedCurve.graph]?.network.segments[feature.supportedCurve.segment];
      const support = segment?.supports.length === 1 ? segment.supports[0] : undefined;
      if (support && feature.support.length === 1) {
        const row = located.get(feature.support[0]);
        if (row?.mesh === mesh && row.triangle === support.triangle) {
          return { triangle: support.triangle, wa: support.a.map(Number), wb: support.b.map(Number) };
        }
      }
      return undefined;
    }
    const vertices = verticesOf(mesh);
    const ends = feature.endpoints.map(name => {
      const parsed = JSON.parse(name) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== mesh.objectId) return -1;
      return vertices.get(parsed[1] as string) ?? -1;
    });
    if (ends[0] < 0 || ends[1] < 0 || ends[0] === ends[1]) return undefined;
    for (const id of feature.support) {
      const row = located.get(id);
      if (row?.mesh !== mesh) continue;
      const triangle = mesh.triangles[row.triangle];
      if (!triangle.includes(ends[0]) || !triangle.includes(ends[1])) continue;
      return { triangle: row.triangle, wa: triangle.map(v => v === ends[0] ? 1 : 0), wb: triangle.map(v => v === ends[1] ? 1 : 0) };
    }
    return undefined;
  };

  const features = snapshot.features;
  const radial = new Map<OccluderMesh3, boolean>();
  const isRadial = (mesh: OccluderMesh3, centre: Vec3): boolean => {
    let value = radial.get(mesh);
    if (value === undefined) { value = radialAbout3(mesh, centre); radial.set(mesh, value); if (value) radialMeshes++; }
    return value;
  };
  // The features each mesh carries, grouped once.
  const owned = new Map<OccluderMesh3, number[]>();
  for (let i = 0; i < features.length; i++) {
    if (certified[i] || !features[i].support.length) continue;
    const mesh = meshOf(features[i]);
    if (!mesh || !mesh.radialCentre) continue;
    const row = owned.get(mesh);
    if (row) row.push(i); else owned.set(mesh, [i]);
  }

  for (const row of groups.values()) {
    for (const source of row) {
      const residual = owned.get(source);
      if (!residual?.length) continue;
      const centre = source.radialCentre!;
      // One descriptor per residual feature of this shell, read once.
      const descriptors = new Map<number, Descriptor>();
      for (const i of residual) {
        const descriptor = descriptorOf(features[i], source);
        if (descriptor) { descriptors.set(i, descriptor); attempted++; } else noDescriptor++;
      }
      if (!descriptors.size) continue;
      for (const occluder of row) {
        if (occluder === source || !usable(occluder)) continue;
        // Forward containment only: the occluder is the shell that reaches
        // farther out. The reverse pair was measured and does not pay.
        if (outerReach(occluder, centre) <= outerReach(source, centre)) continue;
        if (!isRadial(occluder, centre) || !isRadial(source, centre)) continue;
        shellPairs++;
        const adj = adjacency(occluder);
        const limit = 64 + 4 * Math.ceil(Math.sqrt(occluder.triangles.length));
        const stamp = new Int32Array(occluder.triangles.length).fill(-1);
        let generation = 0;
        // Two meshes with the same triangle list are index-for-index
        // correspondents, which seeds every walk at its own answer.
        const matched = occluder.triangles.length === source.triangles.length
          && occluder.triangles.every((t, i) => t[0] === source.triangles[i][0] && t[1] === source.triangles[i][1] && t[2] === source.triangles[i][2]);
        let seed = 0;
        const bySource = new Map<number, number[]>();
        for (const [i, descriptor] of descriptors) {
          if (certified[i]) continue;
          const list = bySource.get(descriptor.triangle);
          if (list) list.push(i); else bySource.set(descriptor.triangle, [i]);
        }
        const exactVertex = new Map<number, H>();
        const exactOf = (v: number): H => { let q = exactVertex.get(v); if (!q) { q = point(occluder.positions[v]); exactVertex.set(v, q); } return q; };
        for (const [W, list] of bySource) {
          counters.sources++;
          const corners = source.triangles[W].map(v => source.positions[v]);
          const start = matched ? W : seed;
          const located0 = walkTo(occluder, centre, adj, start, corners[0], limit);
          if (located0 < 0) { counters.seedFailures++; continue; }
          seed = located0;
          // Region growing from the seed, keeping every cone the exact
          // separation test cannot rule out.
          const cones: number[] = [];
          const queue = [located0];
          const mark = generation++;
          stamp[located0] = mark;
          while (queue.length) {
            const t = queue.pop()!;
            counters.visited++;
            if (cones.length && conesDisjoint(occluder, centre, t, corners)) { counters.rejected++; continue; }
            cones.push(t);
            for (let e = 0; e < 3; e++) {
              const n = adj[t * 3 + e];
              if (n >= 0 && stamp[n] !== mark) { stamp[n] = mark; queue.push(n); }
            }
          }
          if (!cones.length) continue;
          counters.pairs += cones.length;
          const batch = new SourceBatch(occluder, Int32Array.from(cones), corners, counters);
          const allNegative = new Uint8Array(cones.length);
          let wholeSource = true;
          for (let ci = 0; ci < cones.length; ci++) {
            let negative = true;
            for (let k = 0; k < 3; k++) if (batch.sign(ci, k) >= 0) { negative = false; break; }
            allNegative[ci] = negative ? 1 : 0;
            if (!negative) wholeSource = false;
          }
          if (wholeSource) {
            counters.wholeSourceCerts++;
            for (const i of list) if (!certified[i]) { certified[i] = 1; added++; }
            continue;
          }
          for (const i of list) {
            if (certified[i]) continue;
            const descriptor = descriptors.get(i)!;
            let ends: readonly [H, H] | null = null, asked = false;
            const exactEnd = (side: 0 | 1): H | null => {
              if (!asked) {
                asked = true;
                const basis = features[i].basis;
                if (basis && hasWorldTerms3(basis)) { const segment = worldSegment3(basis); ends = [segment.a.p, segment.b.p]; }
              }
              return ends ? ends[side] : null;
            };
            let ok = true;
            for (let ci = 0; ci < cones.length && ok; ci++) {
              if (allNegative[ci]) continue;
              for (const [weights, side] of [[descriptor.wa, 0], [descriptor.wb, 1]] as const) {
                counters.endpointTests++;
                let inside = true;
                for (let k = 0; k < 3; k++) if (weights[k] !== 0 && batch.sign(ci, k) >= 0) { inside = false; break; }
                if (inside) { counters.convexDecisions++; continue; }
                const s = intervalSign(batch, ci, weights);
                if (s !== 0) { counters.intervalDecisions++; if (s < 0) continue; ok = false; break; }
                counters.exactFallbacks++;
                const p = exactEnd(side);
                if (!p) { ok = false; break; }
                const e = planeSignExact(occluder, exactOf, cones[ci], p);
                if (e === 0) { counters.ties++; ok = false; break; }
                if (e > 0) { ok = false; break; }
              }
            }
            if (ok) { certified[i] = 1; added++; }
          }
        }
      }
    }
  }
  return {
    added,
    stats: Object.freeze({
      ms: performance.now() - started,
      radialMeshes, shellPairs, attempted, noDescriptor,
      sources: counters.sources, conePairs: counters.pairs,
      wholeSourceCerts: counters.wholeSourceCerts, certifiedFeatures: added,
      cornerValues: counters.cornerValues, cornerAdaptive: counters.cornerAdaptive,
      endpointTests: counters.endpointTests, convexDecisions: counters.convexDecisions,
      intervalDecisions: counters.intervalDecisions, exactFallbacks: counters.exactFallbacks,
      ties: counters.ties, seedFailures: counters.seedFailures,
    }),
  };
}

/**
 * The facing certificate: the ink a closed shell hides from itself, proved
 * before a single candidate pair is tested.
 *
 * Theorem 0 of working/certificates-report.md §0. Let an outward-oriented
 * closed embedded surface bound a solid, and let the camera lie outside it. A
 * point in the relative interior of a strictly back-facing face is hidden by
 * its own solid: a short step from it toward the camera enters the solid, and
 * the segment must leave the solid again before it reaches an outside camera,
 * at a boundary point strictly in front. The closed-face corollary extends
 * that to the closed triangle — edges and vertices included — by asking for
 * whole vertex stars: a vertex is safe when EVERY incident face is strictly
 * back-facing, and a triangle whose three vertices are safe is hidden
 * everywhere. A camera inside the solid reverses the rule to strictly
 * front-facing.
 *
 * The exit point is strictly front-facing (a ray leaving a solid crosses the
 * boundary outwards), so it is never one of the feature's own supporting
 * triangles, which are all strictly back-facing. That is what makes a
 * certified feature's answer the pairwise answer: the classifier excludes a
 * feature's own support from its candidates, and the blocker this theorem
 * produces is never in it.
 *
 * Every premise is checked, never assumed:
 *  - closed, connected, consistently oriented, every vertex link one circle,
 *    from the mesh's own triangle adjacency;
 *  - OUTWARD, not merely consistent, from the sign of the enclosed volume —
 *    an inward-oriented shell would certify exactly the visible half;
 *  - every triangle survives near/far clipping whole and carries an occluder,
 *    so the blocker the theorem names is a record the classifier holds;
 *  - camera membership by CROSSING parity (working/events-followup-report.md
 *    §2) on a deterministic generic auxiliary segment, not by a blocker count:
 *    an isolated touch blocks without crossing, and a grazed odd-valence
 *    vertex is one blocker per incident face. The camera on the shell is
 *    BOUNDARY and turns the certificate off for that shell.
 *
 * Every sign is exact or abstains. The perspective facing sign is `orient3d`
 * on the stored doubles, which is the sign of `dot(plane(a,b,c), eye)` — the
 * expression the shadow construction in worldInterval.ts uses. The
 * orthographic one is a certified f64 filter on the same determinant against
 * the view direction; an abstention is read as "not strictly facing", which
 * withholds the certificate and never grants it.
 *
 * Open or non-manifold meshes get no certificate: there is no intrinsic
 * inside/outside for them, and a winding convention invented here need not
 * match the classifier's.
 */
import { orient3d } from 'robust-predicates';
import { cross, difference, dot3 as dotExact, point, type H, type V } from '../geometry/exact.js';
import type { FeatureSnapshot3, OccluderMesh3 } from '../features/snapshot.js';
import type { Vec3 } from '../math.js';

/** Certified counts, and one count per verdict: why each occluder mesh did or
 * did not certify. A verdict that certifies names the camera's side. */
export interface FacingStats3 {
  readonly ms: number;
  readonly meshes: number;
  readonly certifiedMeshes: number;
  readonly triangles: number;
  readonly certifiedTriangles: number;
  readonly features: number;
  readonly certifiedFeatures: number;
  readonly reasons: Readonly<Record<string, number>>;
}
/** One byte per feature of the snapshot: 1 where the whole feature is proved
 * hidden by its own shell. */
export interface FacingCertificate3 { readonly certified: Uint8Array; readonly stats: FacingStats3 }

export type Verdict3 = 'camera outside' | 'camera inside' | 'open or non-manifold' | 'disconnected'
  | 'inconsistent winding' | 'vertex link is not a circle' | 'clipped or degenerate occluders'
  | 'enclosed volume undecided' | 'camera on the shell' | 'membership undecided';
type Verdict = Verdict3;
/** Where the camera is, and where it looks from: an orthographic camera is a
 * point at infinity along `eye − target`, which is the exact direction the
 * shadow construction reads. */
export interface CertificateView3 { readonly perspective: boolean; readonly eye: Vec3; readonly target: Vec3 }
export type Membership3 = 'outside' | 'inside' | 'boundary' | 'undecided';
/** One shell's answer: why it did or did not certify, which side of it the
 * camera is on, and a byte per triangle that is 1 where the closed triangle —
 * edges and vertices included — is hidden by its own solid. */
export interface ShellCertificate3 {
  readonly verdict: Verdict3;
  readonly membership: Membership3 | null;
  readonly certified: Uint8Array;
  readonly safe: Uint8Array;
}

/* -- exact and certified predicates ---------------------------------------- */

/** det[b−a, c−a, d−a], exactly. `robust-predicates` returns its negative. */
const det4 = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): number =>
  -orient3d(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
const signOf = (value: number): number => value > 0 ? 1 : value < 0 ? -1 : 0;
/** The sign of the first nonzero coefficient: the value of a polynomial in a
 * positive infinitesimal. */
function leadingSign(coefficients: readonly bigint[]): number {
  for (const c of coefficients) if (c !== 0n) return c > 0n ? 1 : -1;
  return 0;
}

/* -- topology -------------------------------------------------------------- */

interface Topology { readonly verdict: Verdict | null }
/** Closed, connected, consistently oriented, every vertex link one circle —
 * from the triangle list alone, in one pass per condition. */
function topologyOf(mesh: OccluderMesh3): Topology {
  const triangles = mesh.triangles, V = mesh.positions.length;
  if (!triangles.length || !V) return { verdict: 'open or non-manifold' };
  // Half-edges. A closed, consistently oriented two-manifold has every
  // undirected edge traversed exactly once each way.
  const half = new Map<number, number>();
  const key = (u: number, v: number) => u * V + v;
  for (const [a, b, c] of triangles) {
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      if (u === v) return { verdict: 'open or non-manifold' };
      const k = key(u, v);
      if (half.has(k)) return { verdict: 'inconsistent winding' };
      half.set(k, 1);
    }
  }
  for (const k of half.keys()) {
    const u = Math.floor(k / V), v = k - u * V;
    if (!half.has(key(v, u))) return { verdict: 'open or non-manifold' };
  }
  // Components over vertices joined by triangle corners.
  const parent = new Int32Array(V);
  for (let i = 0; i < V; i++) parent[i] = i;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const used = new Uint8Array(V);
  // Vertex links: the opposite edges around a vertex must chain into exactly
  // one cycle covering every incident corner.
  const next = new Map<number, number>();
  const start = new Int32Array(V).fill(-1), degree = new Int32Array(V);
  for (const [a, b, c] of triangles) {
    for (const [v, u, w] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
      used[v] = 1;
      const k = key(v, u);
      if (next.has(k)) return { verdict: 'vertex link is not a circle' };
      next.set(k, w);
      if (start[v] < 0) start[v] = u;
      degree[v]++;
    }
    const ra = find(a), rb = find(b), rc = find(c);
    if (ra !== rb) parent[ra] = rb;
    const rb2 = find(b), rc2 = find(c);
    if (rb2 !== rc2) parent[rb2] = rc2;
  }
  let root = -1;
  for (let v = 0; v < V; v++) {
    if (!used[v]) continue;
    const r = find(v);
    if (root < 0) root = r; else if (r !== root) return { verdict: 'disconnected' };
    let at = start[v], steps = 0;
    for (;;) {
      const to = next.get(key(v, at));
      if (to === undefined) return { verdict: 'vertex link is not a circle' };
      steps++; at = to;
      if (at === start[v]) break;
      if (steps > degree[v]) return { verdict: 'vertex link is not a circle' };
    }
    if (steps !== degree[v]) return { verdict: 'vertex link is not a circle' };
  }
  return { verdict: null };
}

/* -- orientation ----------------------------------------------------------- */

/** The sign of the enclosed volume, or 0 when f64 cannot certify it.
 *
 * Σ det(v₀,v₁,v₂) is six times the signed volume of a closed surface, and it
 * is translation invariant there, so the sum is taken about the first vertex
 * to keep the cancellation honest for a mesh far from the origin. Every input
 * is a double with relative error at most one unit in the last place, so the
 * accumulated bound below is a proof of the sign, not a tolerance.
 */
function volumeSign(mesh: OccluderMesh3): number {
  const p = mesh.positions, o = p[0], triangles = mesh.triangles;
  let sum = 0, absSum = 0, cubes = 0;
  for (const [i0, i1, i2] of triangles) {
    const q0 = p[i0], q1 = p[i1], q2 = p[i2];
    const ax = q0[0] - o[0], ay = q0[1] - o[1], az = q0[2] - o[2];
    const bx = q1[0] - o[0], by = q1[1] - o[1], bz = q1[2] - o[2];
    const cx = q2[0] - o[0], cy = q2[1] - o[1], cz = q2[2] - o[2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const term = (uy * vz - uz * vy) * ax + (uz * vx - ux * vz) * ay + (ux * vy - uy * vx) * az;
    sum += term; absSum += Math.abs(term);
    const m = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(az), Math.abs(bx), Math.abs(by), Math.abs(bz), Math.abs(cx), Math.abs(cy), Math.abs(cz));
    cubes += m * m * m;
  }
  const limit = 256 * Number.EPSILON * cubes + 4 * triangles.length * Number.EPSILON * absSum;
  if (!Number.isFinite(limit)) return 0;
  return sum > limit ? 1 : sum < -limit ? -1 : 0;
}

/* -- camera membership ----------------------------------------------------- */

type Membership = Membership3;

/** Is the eye a point of the shell's surface? Exact. */
function onSurface(mesh: OccluderMesh3, eye: Vec3): boolean {
  const p = mesh.positions;
  let exactEye: H | null = null;
  for (const [i0, i1, i2] of mesh.triangles) {
    const a = p[i0], b = p[i1], c = p[i2];
    let outside = false;
    for (let k = 0; k < 3 && !outside; k++) {
      if (Math.min(a[k], b[k], c[k]) > eye[k] || Math.max(a[k], b[k], c[k]) < eye[k]) outside = true;
    }
    if (outside || det4(a, b, c, eye) !== 0) continue;
    exactEye ??= point(eye);
    const ea = point(a), eb = point(b), ec = point(c);
    const n = cross(difference(eb, ea), difference(ec, ea));
    let positive = false, negative = false;
    for (const [x, y] of [[ea, eb], [eb, ec], [ec, ea]] as const) {
      const s = dotExact(n, cross(difference(y, x), difference(exactEye, x)));
      if (s > 0n) positive = true; else if (s < 0n) negative = true;
    }
    if (!(positive && negative)) return true;
  }
  return false;
}

/** Camera membership by the parity of transverse face-interior crossings of a
 * generic auxiliary segment (report §2, Theorem 2). The far endpoint carries
 * the symbolic perturbation q(ε) = q + ε e_x + ε² e_y + ε³ e_z, so every
 * predicate is a cubic in a positive infinitesimal decided by the sign of its
 * first nonzero coefficient; no direction is guessed and no tie survives. A
 * predicate that is still zero is an abstention, and the shell loses its
 * certificate rather than taking a coin flip.
 */
function membershipByParity(mesh: OccluderMesh3, eye: Vec3, far: Vec3): Membership {
  const p = mesh.positions;
  if (!far.every(Number.isFinite)) return 'undecided';
  const boxLo = [Math.min(eye[0], far[0]), Math.min(eye[1], far[1]), Math.min(eye[2], far[2])];
  const boxHi = [Math.max(eye[0], far[0]), Math.max(eye[1], far[1]), Math.max(eye[2], far[2])];
  let exactEye: H | null = null, exactFar: H | null = null;
  let crossings = 0;
  for (const [i0, i1, i2] of mesh.triangles) {
    const a = p[i0], b = p[i1], c = p[i2];
    let skip = false;
    for (let k = 0; k < 3 && !skip; k++) {
      if (Math.min(a[k], b[k], c[k]) > boxHi[k] || Math.max(a[k], b[k], c[k]) < boxLo[k]) skip = true;
    }
    if (skip) continue;
    // The face plane at the two ends. The far end carries the perturbation:
    // det[b−a, c−a, q(ε)−a] = n·(q−a) + ε n_x + ε² n_y + ε³ n_z.
    const atEye = signOf(det4(a, b, c, eye));
    if (atEye === 0) continue;                       // the eye is on this plane, and off the triangle
    let atFar = signOf(det4(a, b, c, far));
    if (atFar === 0) {
      const n = cross(difference(point(b), point(a)), difference(point(c), point(a)));
      atFar = leadingSign([0n, n[0], n[1], n[2]]);
    }
    if (atFar === 0 || atFar === atEye) continue;    // a degenerate face, or no transverse crossing
    // Inside the triangle's cone from the eye? Three order tests, each
    // det[q(ε)−eye, x−eye, y−eye] = (q−eye)·m + ε m_x + ε² m_y + ε³ m_z.
    let side = 0, crossing = true;
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      let s = signOf(det4(eye, far, x, y));
      if (s === 0) {
        exactEye ??= point(eye); exactFar ??= point(far);
        const m: V = cross(difference(point(x), exactEye), difference(point(y), exactEye));
        s = leadingSign([dotExact(m, difference(exactFar, exactEye)), m[0], m[1], m[2]]);
        if (s === 0) return 'undecided';
      }
      if (side === 0) side = s; else if (side !== s) { crossing = false; break; }
    }
    if (crossing) crossings++;
  }
  return crossings % 2 === 1 ? 'inside' : 'outside';
}

/** The shell's world box, as `[lo, hi]`. */
function worldBox(mesh: OccluderMesh3): readonly [number[], number[]] {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const q of mesh.positions) for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
  return [lo, hi];
}
/** A point strictly outside the world box, hence outside the solid. */
const exteriorPoint = (lo: readonly number[], hi: readonly number[]): Vec3 => {
  const span = (hi[0] - lo[0]) + (hi[1] - lo[1]) + (hi[2] - lo[2]) + 1;
  return Object.freeze([hi[0] + span, hi[1] + span, hi[2] + span]) as Vec3;
};
/** Which side of a closed shell the camera is on. `far` aims the auxiliary
 * segment — a fixture's door; the certificate's own runs take the exterior
 * corner of the world box. The eye ON the shell is BOUNDARY, and turns the
 * shell's certificate off. */
export function cameraMembership3(mesh: OccluderMesh3, eye: Vec3, far?: Vec3): Membership3 {
  if (onSurface(mesh, eye)) return 'boundary';
  const [lo, hi] = worldBox(mesh);
  return membershipByParity(mesh, eye, far ?? exteriorPoint(lo, hi));
}

/* -- one shell ------------------------------------------------------------- */

const NO_FLAGS = new Uint8Array(0);
const declined = (verdict: Verdict, membership: Membership3 | null = null): ShellCertificate3 =>
  ({ verdict, membership, certified: NO_FLAGS, safe: NO_FLAGS });

/**
 * One occluder mesh's self-occlusion certificate, premises and all. Every
 * decline is named; every certified triangle is closed — its edges and its
 * vertices are hidden too.
 */
export function shellCertificate3(mesh: OccluderMesh3, view: CertificateView3): ShellCertificate3 {
  if (!mesh.complete) return declined('clipped or degenerate occluders');
  const verdict = topologyOf(mesh).verdict;
  if (verdict) return declined(verdict);
  // Consistent is not outward: an inward-oriented shell would certify exactly
  // the half a camera outside it can see.
  const outward = volumeSign(mesh);
  if (outward === 0) return declined('enclosed volume undecided');

  const eye = view.eye;
  let membership: Membership3 = 'outside';
  if (view.perspective) {
    const [lo, hi] = worldBox(mesh);
    // A point outside the world box is outside the solid, which is the
    // ordinary case and spares the whole parity walk.
    if (![0, 1, 2].some((k) => eye[k] < lo[k] || eye[k] > hi[k])) membership = cameraMembership3(mesh, eye);
  }
  if (membership === 'boundary') return declined('camera on the shell', membership);
  if (membership === 'undecided') return declined('membership undecided', membership);

  // `want` is the strict facing sign a safe vertex demands: back-facing from
  // outside, front-facing from inside. An abstaining sign is neither, so it
  // withholds the certificate and never grants it.
  const want = membership === 'outside' ? -outward : outward;
  const p = mesh.positions, triangles = mesh.triangles;
  const dx = eye[0] - view.target[0], dy = eye[1] - view.target[1], dz = eye[2] - view.target[2];
  const safe = new Uint8Array(p.length).fill(1);
  for (const [i0, i1, i2] of triangles) {
    const a = p[i0], b = p[i1], c = p[i2];
    let side: number;
    if (view.perspective) {
      // sign(dot(plane(a,b,c), eye)) = sign(det[b−a, c−a, eye−a]), which is
      // the negative of `orient3d` — exact, adaptively.
      side = -signOf(orient3d(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], eye[0], eye[1], eye[2]));
    } else {
      // sign(dot3(plane(a,b,c), eye − target)), by a certified f64 filter:
      // every input is an exact double or a difference of two, so each is
      // within one unit in the last place of its value.
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const s = (uy * vz - uz * vy) * dx + (uz * vx - ux * vz) * dy + (ux * vy - uy * vx) * dz;
      const limit = 16 * Number.EPSILON * (
        (Math.abs(uy * vz) + Math.abs(uz * vy)) * Math.abs(dx)
        + (Math.abs(uz * vx) + Math.abs(ux * vz)) * Math.abs(dy)
        + (Math.abs(ux * vy) + Math.abs(uy * vx)) * Math.abs(dz));
      side = Number.isFinite(limit) && (s > limit || s < -limit) ? signOf(s) : 0;
    }
    if (side !== want) { safe[i0] = 0; safe[i1] = 0; safe[i2] = 0; }
  }
  const certified = new Uint8Array(triangles.length);
  for (let t = 0; t < triangles.length; t++) {
    const [i0, i1, i2] = triangles[t];
    certified[t] = safe[i0] === 1 && safe[i1] === 1 && safe[i2] === 1 ? 1 : 0;
  }
  return { verdict: membership === 'outside' ? 'camera outside' : 'camera inside', membership, certified, safe };
}

/* -- the pre-pass ---------------------------------------------------------- */

/**
 * Every feature of a snapshot that its own shell certifies hidden, with the
 * counts behind the answer. Null when the snapshot names no occluder mesh at
 * all, which is the ordinary case for wires alone — the caller then classifies
 * exactly as it always did.
 *
 * This runs once, on the main thread, before the features are split across
 * workers: nothing here reads a feature index, and the answer is a property of
 * the scene, not of the thread that asks.
 */
export function facingCertificate3(snapshot: FeatureSnapshot3): FacingCertificate3 | null {
  const started = performance.now();
  // A hand-built source that predates the mesh record carries no meshes and
  // certifies nothing, which is the pairwise answer.
  const meshes = snapshot.occluderMeshes as readonly OccluderMesh3[] | undefined;
  if (!meshes?.length || !snapshot.features.length) return null;
  const camera = snapshot.frame.camera;
  const view: CertificateView3 = { perspective: camera.kind !== 'orthographic', eye: camera.eye, target: camera.target };
  if (!view.perspective && view.eye.every((v, k) => v === view.target[k])) return null;

  const reasons: Record<string, number> = {};
  const flags = new Map<string, boolean>();
  let certifiedMeshes = 0, triangleCount = 0, certifiedTriangles = 0;
  for (const mesh of meshes) {
    triangleCount += mesh.triangles.length;
    const shell = shellCertificate3(mesh, view);
    reasons[shell.verdict] = (reasons[shell.verdict] ?? 0) + 1;
    if (!shell.certified.length) continue;
    certifiedMeshes++;
    for (let t = 0; t < mesh.triangles.length; t++) {
      const ok = shell.certified[t] === 1;
      if (ok) certifiedTriangles++;
      const id = mesh.triangleIds[t], previous = flags.get(id);
      flags.set(id, previous === undefined ? ok : previous && ok);
    }
  }

  // A feature is certified when every triangle of its own support is: the
  // support is what the classifier excludes from its own candidates, and a
  // certified triangle hides every point of itself, its edges included.
  const features = snapshot.features;
  const certified = new Uint8Array(features.length);
  let certifiedFeatures = 0;
  if (certifiedMeshes) for (let i = 0; i < features.length; i++) {
    const support = features[i].support;
    if (!support.length) continue;
    let ok = true;
    for (const id of support) if (flags.get(id) !== true) { ok = false; break; }
    if (ok) { certified[i] = 1; certifiedFeatures++; }
  }
  return {
    certified,
    stats: Object.freeze({
      ms: performance.now() - started,
      meshes: meshes.length, certifiedMeshes,
      triangles: triangleCount, certifiedTriangles,
      features: features.length, certifiedFeatures,
      reasons: Object.freeze({ ...reasons }),
    }),
  };
}

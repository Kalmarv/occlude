/**
 * The self-occlusion certificate in the production classifier
 * (working/survey/specs/26-facing-in-classifier.md).
 *
 * Two claims are under test and they are different claims. The predicates
 * below are pinned on geometry small enough to hold in the head: the crossing
 * parity of a generic auxiliary segment, and the closed-face corollary on the
 * cube of working/certificates-report.md §0. The scene tests then say the only
 * thing that matters for ink — a certified feature is a feature the pairwise
 * classifier also calls wholly hidden, and a drawing is the same drawing with
 * the certificate on and off.
 */
import { describe, expect, it } from 'vitest';
import { cameraMembership3, facingCertificate3, shellCertificate3, type CertificateView3 } from '../src/three/visibility/facing.js';
import type { OccluderMesh3 } from '../src/three/features/snapshot.js';
import { featureSnapshot3 } from '../src/three/features/snapshot.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { surface3 } from '../src/three/geometry/surface.js';
import { sphere } from '../src/three/api/primitives.js';
import { classifyScene3 } from '../src/three/visibility/scene.js';
import { unionIntervals3, type Interval3 } from '../src/three/visibility/interval.js';
import { captureSnapshot, globeScene } from '../tools/globe-certs/scene.js';
import type { Vec3 } from '../src/three/math.js';

const mesh = (
  positions: readonly (readonly [number, number, number])[],
  triangles: readonly (readonly [number, number, number])[],
  complete = true,
): OccluderMesh3 => ({
  objectId: 'shell',
  positions: positions.map((p) => Object.freeze([...p]) as Vec3),
  triangles,
  triangleIds: triangles.map((_, i) => `t${i}`),
  complete,
});
const v = (x: number, y: number, z: number): Vec3 => Object.freeze([x, y, z]) as Vec3;
const looking = (eye: Vec3, target: Vec3, perspective = true): CertificateView3 => ({ perspective, eye, target });

/** The unit tetrahedron, outward oriented — the fixture of
 * tools/events-spike/inside.ts. Its vertices have valence three, an ODD
 * number of incident faces, which is what separates crossing parity from
 * blocker parity at a grazed vertex. */
const tetrahedron = () => mesh(
  [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
);

/** The cube of certificates-report §0: x, y in [-1, 1], z in [1, 2], seen
 * from a camera at the origin. Faces in the order -x, +x, -y, +y, -z (near),
 * +z (far), each as two outward-wound triangles. */
function cube() {
  const c: [number, number, number][] = [
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    [-1, -1, 2], [1, -1, 2], [1, 1, 2], [-1, 1, 2],
  ];
  const quads: [number, number, number, number][] = [
    [0, 4, 7, 3],   // x = -1
    [1, 2, 6, 5],   // x = +1
    [0, 1, 5, 4],   // y = -1
    [3, 7, 6, 2],   // y = +1
    [0, 3, 2, 1],   // z = 1, the near face
    [4, 5, 6, 7],   // z = 2, the far face
  ];
  const triangles = quads.flatMap(([a, b, d, e]): [number, number, number][] => [[a, b, d], [a, d, e]]);
  return { shell: mesh(c, triangles), face: (i: number) => [i * 2, i * 2 + 1] as const };
}

describe('camera membership is the parity of crossings', () => {
  const tetra = tetrahedron();

  it('separates the interior from the exterior', () => {
    expect(cameraMembership3(tetra, v(0.1, 0.1, 0.1))).toBe('inside');
    expect(cameraMembership3(tetra, v(2, 2, 2))).toBe('outside');
    expect(cameraMembership3(tetra, v(-3, 0.2, 0.2))).toBe('outside');
  });

  it('is right where the auxiliary segment grazes a vertex, which blocker parity is not', () => {
    // The line through D = (0,0,1) in the direction (1,1,0) meets the solid
    // only at D. Three faces meet there — an odd blocker count, and the wrong
    // answer for a test that counts blockers instead of crossings.
    expect(cameraMembership3(tetra, v(-1, -1, 1), v(2, 2, 1))).toBe('outside');
  });

  it('is right where the auxiliary segment grazes an edge', () => {
    expect(cameraMembership3(tetra, v(0.5, 1, 0.5), v(0.5, -1, 0.5))).toBe('outside');
  });

  it('is right where the auxiliary segment passes through a vertex of the solid', () => {
    expect(cameraMembership3(tetra, v(0.7, 0.0625, 0.0625), v(3, -0.4375, -0.4375))).toBe('inside');
  });

  it('is right where the auxiliary segment lies in the plane of a face', () => {
    // Both ends in x = 0, the plane of face ACD: the segment overlaps that
    // face in a whole interval, which no finite hit count can read.
    expect(cameraMembership3(tetra, v(0, -1, 0.25), v(0, 2, 0.25))).toBe('outside');
  });

  it('calls a camera on the shell BOUNDARY, and turns the certificate off', () => {
    for (const eye of [v(0.25, 0.25, 0.5), v(0, 0, 1), v(0.5, 0, 0.5)]) {
      expect(cameraMembership3(tetra, eye)).toBe('boundary');
      const shell = shellCertificate3(tetra, looking(eye, v(0.25, 0.25, 0.25)));
      expect([shell.verdict, shell.certified.length]).toEqual(['camera on the shell', 0]);
    }
  });
});

describe('the closed-face corollary on the cube of certificates-report §0', () => {
  const { shell, face } = cube();
  const origin = looking(v(0, 0, 0), v(0, 0, 1.5));

  it('certifies the far face as a closed triangle and refuses the side face', () => {
    const result = shellCertificate3(shell, origin);
    expect([result.verdict, result.membership]).toEqual(['camera outside', 'outside']);
    // The far face z = 2: every vertex of it lies only on strictly
    // back-facing faces, so the closed triangle is hidden, edges included.
    for (const t of face(5)) expect(result.certified[t]).toBe(1);
    // The side face y = 1 IS strictly back-facing, and its interior IS hidden
    // — but (0, 1, 1) on its near edge is visible, so the vertex-star rule
    // keeps the whole face for the exact path.
    for (const t of face(3)) expect(result.certified[t]).toBe(0);
    for (const t of [...face(0), ...face(1), ...face(2), ...face(4)]) expect(result.certified[t]).toBe(0);
  });

  it('reverses the rule for a camera inside, which sees every wall of a box', () => {
    const inside = shellCertificate3(shell, looking(v(0, 0, 1.5), v(0, 0, 2)));
    expect([inside.verdict, inside.membership]).toEqual(['camera inside', 'inside']);
    expect([...inside.certified]).toEqual(shell.triangles.map(() => 0));
  });

  it('reads an inward-wound shell as the same solid, not as its complement', () => {
    const flipped = mesh(shell.positions as readonly Vec3[], shell.triangles.map(([a, b, c]) => [a, c, b] as const));
    const result = shellCertificate3(flipped, origin);
    expect(result.verdict).toBe('camera outside');
    expect([...result.certified]).toEqual([...shellCertificate3(shell, origin).certified]);
  });

  it('certifies nothing without its premises', () => {
    const open = mesh(shell.positions as readonly Vec3[], shell.triangles.slice(0, 10));
    expect(shellCertificate3(open, origin).verdict).toBe('open or non-manifold');
    const inconsistent = mesh(shell.positions as readonly Vec3[], shell.triangles.map((t, i) => i === 0 ? [t[0], t[2], t[1]] as const : t));
    expect(shellCertificate3(inconsistent, origin).verdict).toBe('inconsistent winding');
    const clipped = mesh(shell.positions as readonly Vec3[], shell.triangles, false);
    expect(shellCertificate3(clipped, origin).verdict).toBe('clipped or degenerate occluders');
    // Two disjoint tetrahedra in one mesh: each is closed, the pair is not
    // connected, and a shell is certified one at a time or not at all.
    const far = tetrahedron().positions.map((p) => v(p[0] + 8, p[1], p[2]));
    const both = mesh(
      [...tetrahedron().positions, ...far] as readonly Vec3[],
      [...tetrahedron().triangles, ...tetrahedron().triangles.map((t) => t.map((i) => i + 4) as unknown as readonly [number, number, number])],
    );
    expect(shellCertificate3(both, origin).verdict).toBe('disconnected');
  });
});

describe('the pre-pass reads the snapshot the classifier holds', () => {
  const camera = { kind: 'orthographic' as const, span: 6, eye: v(4, -6, 4), target: v(0, 0, 0), near: 0.1, far: 100 };
  const frame = cameraFrame3(camera, { x: 0, y: 0, width: 100, height: 100 });
  // A tetrahedron is too coarse to certify anything — every one of its four
  // vertices touches a front-facing face. A sphere is the shape the rule is
  // for, and the orthographic camera is the bench's own.
  const solid = sphere(1.2, { segments: 24, rings: 12 }).surface;
  const tetra = surface3([[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]], [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);

  it('records one complete mesh per occluding object and none for a pass-through one', () => {
    const snapshot = featureSnapshot3([{ id: 'solid', surface: tetra }], [], frame);
    expect(snapshot.occluderMeshes.map((m) => [m.objectId, m.triangles.length, m.complete])).toEqual([['solid', 4, true]]);
    expect(featureSnapshot3([{ id: 'solid', surface: tetra, occluder: false }], [], frame).occluderMeshes).toEqual([]);
  });

  it('certifies the far half of a closed shell under an orthographic camera', () => {
    const snapshot = featureSnapshot3([{ id: 'solid', surface: solid }], [], frame);
    const certificate = facingCertificate3(snapshot)!;
    const stats = certificate.stats;
    expect(stats.reasons).toEqual({ 'camera outside': 1 });
    expect(stats.certifiedTriangles).toBeGreaterThan(stats.triangles / 4);
    expect(stats.certifiedTriangles).toBeLessThan(stats.triangles / 2);
    // A tetrahedron certifies nothing: every vertex touches a front-facing
    // face, which is the vertex-star rule doing its job, not a failure.
    expect(facingCertificate3(featureSnapshot3([{ id: 'solid', surface: tetra }], [], frame))!.stats.certifiedTriangles).toBe(0);
  });

  it('is off for `certificates: false` and for the exact-classifier oracle', async () => {
    const snapshot = featureSnapshot3([{ id: 'solid', surface: solid }], [], frame);
    expect((await classifyScene3(snapshot, {})).stats.certificates).toBeDefined();
    expect((await classifyScene3(snapshot, { certificates: false })).stats.certificates).toBeUndefined();
    expect((await classifyScene3(snapshot, { raster: false })).stats.certificates).toBeUndefined();
  });

  it('draws the same sphere with the certificate on and off', async () => {
    const snapshot = featureSnapshot3([{ id: 'solid', surface: solid }], [], frame);
    const on = await classifyScene3(snapshot, {});
    const off = await classifyScene3(snapshot, { certificates: false });
    expect(on.features.map((r) => r.visible)).toEqual(off.features.map((r) => r.visible));
    expect(on.stats.certificates!.certifiedFeatures).toBeGreaterThan(0);
  });
});

describe('the certificate changes work, never ink', () => {
  const whole = (rows: readonly Interval3[]): boolean => {
    const union = unionIntervals3([...rows]);
    return union.length === 1 && union[0][0] <= 0 && union[0][1] >= 1;
  };

  it('agrees with the pairwise classifier on the two-shell globe', { timeout: 300_000 }, async () => {
    // The bench's own globe at a frequency small enough for a test: two
    // near-coincident Goldberg shells, isolines on both and their
    // intersection curve — the population the certificate is for.
    const globe = await globeScene({ frequency: 10 });
    const snapshot = captureSnapshot(globe.exec, globe.scene, globe.scene.objects);
    const certificate = facingCertificate3(snapshot)!;
    expect(certificate.stats.certifiedMeshes).toBe(2);
    expect(certificate.stats.certifiedFeatures).toBeGreaterThan(snapshot.features.length / 4);

    const off = await classifyScene3(snapshot, { certificates: false });
    const on = await classifyScene3(snapshot, {});
    let falseCertifications = 0, differing = 0;
    for (let i = 0; i < off.features.length; i++) {
      // Every certified feature is one the pairwise path calls wholly hidden.
      if (certificate.certified[i] && !whole(off.features[i].hidden)) falseCertifications++;
      const a = JSON.stringify(unionIntervals3([...off.features[i].hidden]));
      const b = JSON.stringify(unionIntervals3([...on.features[i].hidden]));
      if (a !== b) differing++;
    }
    expect({ falseCertifications, differing }).toEqual({ falseCertifications: 0, differing: 0 });
  });
});

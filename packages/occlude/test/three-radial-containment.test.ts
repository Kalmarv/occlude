/**
 * The radial provenance and what the containment certificate does with it.
 *
 * The centre is provenance, not a claim: the generators mint it, the edits
 * that keep a star-shaped solid star-shaped carry it, and everything else
 * drops it. The certificate then re-proves radiality from the triangles, so
 * the tests below check both halves — that the right operations keep it, and
 * that a shell which is NOT radial about its recorded centre certifies
 * nothing.
 */
import { describe, expect, it } from 'vitest';
import { geodesic, isolines, perspective, plane, sphere, torus, view } from '../src/three/api/index.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { featureSnapshot3 } from '../src/three/features/snapshot.js';
import { facingCertificate3 } from '../src/three/visibility/facing.js';
import { radialAbout3 } from '../src/three/visibility/containment.js';
import { classifySceneCpuJob3 } from '../src/three/visibility/scene.js';
import { runGeometryJob3 } from '../src/three/geometry/job.js';
import type { Vec3 } from '../src/three/math.js';
import { unionIntervals3, type Interval3 } from '../src/three/visibility/interval.js';

const whole = (rows: readonly Interval3[]) => { const u = unionIntervals3([...rows]); return u.length === 1 && u[0][0] <= 0 && u[0][1] >= 1; };

describe('radial provenance', () => {
  it('is minted by the radial generators and by nothing else', () => {
    expect(geodesic(1, { frequency: 3 }).radialCentre).toEqual([0, 0, 0]);
    expect(sphere(1).radialCentre).toEqual([0, 0, 0]);
    expect(geodesic(1, { frequency: 3 }).dual().radialCentre).toEqual([0, 0, 0]);
    // The flat solid is not built by pushing points out from a centre, so it
    // claims nothing.
    expect(geodesic(1, { frequency: 3, project: false }).radialCentre).toBeUndefined();
    expect(plane(2).radialCentre).toBeUndefined();
  });

  it('moves with translate, rotate and scale, and is kept by displace and style', () => {
    const ball = geodesic(1, { frequency: 3 });
    expect(ball.translate([1, 2, 3]).radialCentre).toEqual([1, 2, 3]);
    expect(ball.scale(0.5).radialCentre).toEqual([0, 0, 0]);
    expect(ball.translate([2, 0, 0]).scale(0.5, [0, 0, 0]).radialCentre).toEqual([1, 0, 0]);
    expect(ball.translate([2, 0, 0]).rotate([0, 0, 180], [0, 0, 0]).radialCentre![0]).toBeCloseTo(-2, 12);
    // A displacement in any direction keeps the record, because radiality is
    // re-proved from the triangles and never assumed.
    expect(ball.displace(() => [0.1, 0, 0]).radialCentre).toEqual([0, 0, 0]);
    expect(ball.style({ creaseAngle: 180 }).radialCentre).toEqual([0, 0, 0]);
    expect(ball.withKey('ball').radialCentre).toEqual([0, 0, 0]);
  });

  it('is dropped by an edit that can move the shell off its centre', () => {
    const ball = geodesic(1, { frequency: 3 });
    expect(ball.subdivide(1).radialCentre).toBeUndefined();
    expect(ball.steps(1, { move: () => [0, 0, 0] as Vec3 }).radialCentre).toBeUndefined();
  });

  it('re-proves radiality from the triangles, whatever the record says', () => {
    const scene = view([geodesic(1, { frequency: 4 }).dual()], { camera: perspective({ eye: [5, 0, 0], target: [0, 0, 0] }), stroke: 'ink' }).scene;
    const snapshot = featureSnapshot3(scene.objects, scene.wires, cameraFrame3(scene.camera, { x: 5, y: 5, width: 190, height: 190 }), undefined, scene.curves);
    const mesh = snapshot.occluderMeshes[0];
    expect(mesh.radialCentre).toEqual([0, 0, 0]);
    expect(radialAbout3(mesh, mesh.radialCentre!)).toBe(true);
    // A centre outside the shell is no centre of it: every proof fails, and
    // the certificate is withheld rather than taken on trust.
    expect(radialAbout3(mesh, Object.freeze([5, 0, 0]) as unknown as Vec3)).toBe(false);
    // A ring is star-shaped about no point at all: the planes of the inner
    // wall face the wrong way, and the proof says so.
    const ring = view([torus(1, 0.35, { segments: 16, tubeSegments: 8 })], { camera: perspective({ eye: [5, 0, 0], target: [0, 0, 0] }), stroke: 'ink' }).scene;
    const ringSnapshot = featureSnapshot3(ring.objects, ring.wires, cameraFrame3(ring.camera, { x: 5, y: 5, width: 190, height: 190 }), undefined, ring.curves);
    expect(radialAbout3(ringSnapshot.occluderMeshes[0], Object.freeze([0, 0, 0]) as unknown as Vec3)).toBe(false);
  });
});

describe('the containment certificate', () => {
  /** The globe's two shells about one centre, at a frequency a test affords. */
  const globe = () => {
    const base = geodesic(1, { frequency: [5, 5] }).dual();
    const water = base.scale(0.99);
    const terrain = base.displace((p) => (Math.sin(p.x * 3) * Math.cos(p.y * 4) + Math.sin(p.z * 5)) * 0.04).style({ creaseAngle: 180 });
    const levels = isolines(terrain, (p) => Math.hypot(p.x, p.y, p.z), { count: 20 });
    return view([water, terrain, levels], {
      camera: perspective({ eye: [8.59782, -0.703966, -1.55822], target: [0, 0, 0], fovDegrees: 19.5622 }),
      stroke: 'ink', creaseAngle: 180,
    }).scene;
  };

  it('certifies water ink inside the terrain, and certifies nothing false', () => {
    const scene = globe();
    const snapshot = featureSnapshot3(scene.objects, scene.wires, cameraFrame3(scene.camera, { x: 5, y: 5, width: 190, height: 190 }), undefined, scene.curves);
    const certificate = facingCertificate3(snapshot)!;
    const containment = certificate.stats.containment!;
    expect(containment.radialMeshes).toBe(2);
    // Forward only: the outer shell occludes, and the reverse pair — measured
    // and rejected — is never run.
    expect(containment.shellPairs).toBe(1);
    expect(containment.certifiedFeatures).toBeGreaterThan(0);
    expect(containment.wholeSourceCerts).toBeGreaterThan(0);
    expect(containment.ties).toBe(0);
    expect(containment.seedFailures).toBe(0);
    // Every certified feature must be hidden over its whole length in the
    // pairwise answer, and every uncertified one must classify the same way
    // either side of the certificate.
    const proved = runGeometryJob3(classifySceneCpuJob3(snapshot, {}, certificate)).value;
    const pairwise = runGeometryJob3(classifySceneCpuJob3(snapshot, { certificates: false }, null)).value;
    let falseCertifications = 0, differences = 0;
    for (let i = 0; i < snapshot.features.length; i++) {
      if (certificate.certified[i]) { if (!whole(pairwise.features[i].hidden)) falseCertifications++; continue; }
      const a = unionIntervals3([...proved.features[i].visible]).join('|');
      const b = unionIntervals3([...pairwise.features[i].visible]).join('|');
      if (a !== b) differences++;
    }
    expect(falseCertifications).toBe(0);
    expect(differences).toBe(0);
  }, 120_000);

  it('says nothing about a scene with one shell', () => {
    const scene = view([sphere(1, { segments: 16, rings: 8 })], { camera: perspective({ eye: [5, 0, 0], target: [0, 0, 0] }), stroke: 'ink' }).scene;
    const snapshot = featureSnapshot3(scene.objects, scene.wires, cameraFrame3(scene.camera, { x: 5, y: 5, width: 190, height: 190 }), undefined, scene.curves);
    expect(facingCertificate3(snapshot)!.stats.containment).toBeUndefined();
  });
});

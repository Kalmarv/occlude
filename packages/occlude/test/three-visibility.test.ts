import { describe, expect, it } from 'vitest';
import { cameraFrame3, clipSegment3, clipTriangle3, projectCamera3, toCamera3, toPaper3 } from '../src/three/camera.js';
import { cross3, dot3, lerp3, sub3, type Triangle3, type Vec3 } from '../src/three/math.js';
import { hiddenInterval3, occlusionVolume3, unionIntervals3, visibleIntervals3 } from '../src/three/visibility/interval.js';

const triangle: Triangle3 = [[-1, -1, -2], [1, -1, -2], [0, 1, -2]];
const paper = { x: 10, y: 20, width: 200, height: 100 };

describe('3D cameras and clipping', () => {
  for (const projection of [{ kind: 'orthographic' as const, span: 4 }, { kind: 'perspective' as const, fovDegrees: 90 }]) {
    it(`${projection.kind} uses WebGPU depth, explicit framing and y-down paper`, () => {
      const frame = cameraFrame3({ ...projection, eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], near: 1, far: 10 }, paper);
      expect(toCamera3(frame, [0, 0, 0])).toEqual([0, 0, -5]);
      expect(projectCamera3(frame, [0, 0, -1])[2]).toBeCloseTo(0, 14);
      expect(projectCamera3(frame, [0, 0, -10])[2]).toBeCloseTo(1, 14);
      expect(toPaper3(frame, [0, 0, -2])).toEqual([110, 70]);
      expect(toPaper3(frame, [0, 1, -2])[1]).toBeCloseTo(45);
      expect(() => projectCamera3(frame, [0, 0, 1])).toThrow(/behind the eye/);
    });
  }
  it('validates camera degeneracies and owns inputs', () => {
    const eye: [number, number, number] = [0, -5, 2];
    const camera = { kind: 'orthographic' as const, span: 4, eye, target: [0, 0, 0] as Vec3, near: 1, far: 10 };
    const frame = cameraFrame3(camera, paper); eye[0] = 20;
    expect(frame.camera.eye[0]).toBe(0);
    expect(() => cameraFrame3({ ...camera, near: 0 }, paper)).toThrow();
    expect(() => cameraFrame3({ ...camera, target: eye }, paper)).toThrow();
    expect(() => cameraFrame3({ ...camera, span: Infinity }, paper)).toThrow();
    expect(() => cameraFrame3({ ...camera, up: [0, 0, 0] }, paper)).toThrow();
  });
  it('clips through the eye and preserves original segment parameters', () => {
    expect(clipSegment3([0, 0, 1], [0, 0, -5], 1, 4)).toEqual([1 / 3, 5 / 6]);
    expect(clipSegment3([0, 0, 1], [0, 0, 2], 1, 4)).toBeNull();
    expect(clipSegment3([0, 0, -1], [0, 0, -4], 1, 4)).toEqual([0, 1]);
    const clipped = clipTriangle3([[-1, 0, 0], [1, -1, -2], [1, 1, -2]], 1, 4);
    expect(clipped).toHaveLength(2);
    expect(clipped.flat().every(p => -p[2] >= 1 && -p[2] <= 4)).toBe(true);
  });
});

/** Independent Möller–Trumbore ray oracle. Tests interval interiors using a
 * ray/triangle hit, not the shadow-volume implementation under test. */
function rayHidden(p: Vec3, tri: Triangle3, perspective: boolean): boolean {
  const origin: Vec3 = perspective ? [0, 0, 0] : [p[0], p[1], 0];
  const direction = sub3(p, origin), e1 = sub3(tri[1], tri[0]), e2 = sub3(tri[2], tri[0]);
  const h = cross3(direction, e2), det = dot3(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const s = sub3(origin, tri[0]), u = dot3(s, h) / det;
  const q = cross3(s, e1), v = dot3(direction, q) / det, t = dot3(e2, q) / det;
  return u >= 0 && v >= 0 && u + v <= 1 && t > 0 && t < 1;
}

describe('geometric hidden intervals', () => {
  it('returns analytically known partial intervals without sampling', () => {
    const a: Vec3 = [-2, 0, -4], b: Vec3 = [2, 0, -4];
    const ortho = hiddenInterval3(a, b, occlusionVolume3(triangle, false)!)!;
    expect(ortho[0]).toBeCloseTo(0.375, 14); expect(ortho[1]).toBeCloseTo(0.625, 14);
    const perspective = hiddenInterval3(a, b, occlusionVolume3(triangle, true)!)!;
    expect(perspective[0]).toBeCloseTo(0.25, 14); expect(perspective[1]).toBeCloseTo(0.75, 14);
  });
  for (const perspective of [false, true]) {
    it(`matches independent rays with ${perspective ? 'perspective foreshortening' : 'orthographic projection'}`, () => {
      const volume = occlusionVolume3(triangle, perspective)!;
      // Sloping and depth-crossing segments, deterministic generated coverage.
      for (let j = 0; j < 80; j++) {
        const a: Vec3 = [-3, Math.sin(j) * 2, -0.5 - (j % 4)];
        const b: Vec3 = [3, Math.cos(j) * 2, -3 - j / 3];
        const interval = hiddenInterval3(a, b, volume);
        for (let i = 0; i < 23; i++) {
          const t = (i + 0.37) / 23;
          expect(interval !== null && t > interval[0] && t < interval[1]).toBe(rayHidden(lerp3(a, b, t), triangle, perspective));
        }
      }
    });
    it(`handles winding, full visibility, own plane and degeneracy (${perspective})`, () => {
      const volume = occlusionVolume3(triangle, perspective)!;
      expect(hiddenInterval3([-0.1, 0, -4], [0.1, 0, -4], volume)).toEqual([0, 1]);
      expect(hiddenInterval3([-0.1, 0, -1], [0.1, 0, -1], volume)).toBeNull();
      expect(hiddenInterval3([-0.1, 0, -2], [0.1, 0, -2], volume)).toBeNull();
      expect(hiddenInterval3([5, 0, -4], [6, 0, -4], volume)).toBeNull();
      expect(hiddenInterval3([-2, 0, -4], [2, 0, -4], volume)).toEqual(hiddenInterval3([-2, 0, -4], [2, 0, -4], occlusionVolume3([triangle[2], triangle[1], triangle[0]], perspective)!));
      expect(occlusionVolume3([[0, 0, -2], [0, 0, -2], [0, 0, -2]], perspective)).toBeNull();
    });
  }
  it('unions overlap without closing a positive gap', () => {
    expect(unionIntervals3([[0.2, 0.4], [0.3, 0.5], [0.8, 1]])).toEqual([[0.2, 0.5], [0.8, 1]]);
    expect(visibleIntervals3([[0.2, 0.5], [0.50000000001, 0.8]])).toEqual([[0, 0.2], [0.5, 0.50000000001], [0.8, 1]]);
    expect(visibleIntervals3([])).toEqual([[0, 1]]);
    expect(visibleIntervals3([[0, 1]])).toEqual([]);
  });
});

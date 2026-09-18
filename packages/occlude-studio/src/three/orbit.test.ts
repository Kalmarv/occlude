import { expect, it } from 'vitest';
import { cameraFrame3, toCamera3, type Camera3 } from 'occlude/src/three/camera.js';
import { orbitCamera3, panCamera3, presetCamera3, fitCamera3, viewHalfHeight3, switchProjection3, sameCamera3, carryExploration3 } from './orbit.js';
const ortho: Camera3 = { kind: 'orthographic', span: 4, eye: [3, -6, 4], target: [0, 0, 1], near: .1, far: 50 };
const persp: Camera3 = { kind: 'perspective', fovDegrees: 40, eye: [3, -6, 4], target: [0, 0, 1], near: .1, far: 50 };
const close = (a: readonly number[], b: readonly number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

it('pans eye and target together in the view plane by fractions of the visible height', () => {
  for (const camera of [ortho, persp]) {
    const moved = panCamera3(camera, .5, 0);
    close(moved.eye.map((v, i) => v - camera.eye[i]), moved.target.map((v, i) => v - camera.target[i]));
    const frame = cameraFrame3(camera, { x: 0, y: 0, width: 1, height: 1 });
    // The point under the screen centre before moving is now half a height to the left.
    const before = toCamera3(frame, camera.target), after = toCamera3(cameraFrame3(moved, { x: 0, y: 0, width: 1, height: 1 }), camera.target);
    expect(after[0] - before[0]).toBeCloseTo(viewHalfHeight3(camera) * 2 * .5, 9);
    expect(after[1]).toBeCloseTo(before[1], 9); expect(after[2]).toBeCloseTo(before[2], 9);
  }
});
it('Blender presets look along world axes, keep distance, target and the world up, and never sit on the pole', () => {
  const d = Math.hypot(3, -6, 3);
  const top = presetCamera3(ortho, 'top');
  expect(top.up).toBeUndefined(); expect(top.eye[2]).toBeCloseTo(1 + d * Math.cos(.001), 9); expect(top.eye[1]).toBeCloseTo(-d * Math.sin(.001), 9);
  // Screen up in the top view is +Y, and a further orbit still turns about Z.
  const frame = cameraFrame3(top, { x: 0, y: 0, width: 1, height: 1 }); expect(frame.up[1]).toBeGreaterThan(.99);
  const turned = orbitCamera3(top, Math.PI / 2, 0); expect(turned.eye[2]).toBeCloseTo(top.eye[2], 9);
  const front = presetCamera3(persp, 'front'); close(front.eye, [0, -d, 1]);
  const right = presetCamera3(persp, 'right'); close(right.eye, [d, 0, 1]);
  const back = presetCamera3(persp, 'back'); close(back.eye, [0, d, 1]);
  expect(presetCamera3(ortho, 'bottom').eye[2]).toBeCloseTo(1 - d * Math.cos(.001), 9);
  expect(() => presetCamera3(ortho, 'sideways' as never)).toThrow('preset');
});
it('frames bounds from the current direction with the sphere inside the clipping range', () => {
  const bounds = { min: [-2, -1, 0] as const, max: [2, 1, 4] as const };
  for (const camera of [ortho, persp]) {
    const fit = fitCamera3(camera, { min: [...bounds.min], max: [...bounds.max] }, 1.5);
    close(fit.target, [0, 0, 2]);
    const radius = Math.hypot(4, 2, 4) / 2, distance = Math.hypot(...fit.eye.map((v, i) => v - fit.target[i]));
    expect(viewHalfHeight3(fit)).toBeGreaterThanOrEqual(radius * 1.1 - 1e-9);
    expect(fit.near).toBeLessThan(distance - radius); expect(fit.far).toBeGreaterThan(distance + radius);
    const direction = camera.eye.map((v, i) => v - camera.target[i]), moved = fit.eye.map((v, i) => v - fit.target[i]);
    close(direction.map(v => v / Math.hypot(...direction)), moved.map(v => v / Math.hypot(...moved)));
  }
  expect(() => fitCamera3(ortho, { min: [0, 0, 0], max: [1, 1, 1] }, 0)).toThrow('aspect');
});
it('keeps orbit and projection switches composable with the new operations', () => {
  const stepped = orbitCamera3(presetCamera3(ortho, 'front'), Math.PI / 12, 0);
  expect(Math.hypot(...stepped.eye.map((v, i) => v - stepped.target[i]))).toBeCloseTo(Math.hypot(3, -6, 3), 9);
  expect(switchProjection3(panCamera3(persp, .1, .1), 'orthographic').kind).toBe('orthographic');
});

it('carries an explored camera across rerenders only while the sketch camera is unchanged', () => {
  const explored = new Map([[0, orbitCamera3(persp, .4, .2)], [1, panCamera3(ortho, .1, 0)], [2, persp]]);
  const moved = { ...persp, eye: [persp.eye[0] + 1, persp.eye[1], persp.eye[2]] as const } as typeof persp;
  const kept = carryExploration3(explored, [persp, ortho, persp], [{ ...persp, eye: [...persp.eye] as unknown as typeof persp.eye }, moved]);
  expect(kept.get(0)).toBe(explored.get(0)); // same sketch camera (by value): the exploration stays
  expect(kept.has(1)).toBe(false);            // the sketch camera changed: adopt the new one
  expect(kept.has(2)).toBe(false);            // the scene is gone
  expect(sameCamera3(persp, { ...persp, fovDegrees: persp.fovDegrees + 1 })).toBe(false);
  expect(sameCamera3(ortho, { ...ortho, up: [0, 0, 1] })).toBe(sameCamera3(ortho, ortho));
  expect(sameCamera3(persp, undefined)).toBe(false);
});

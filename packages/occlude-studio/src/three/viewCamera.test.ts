import { expect, it } from 'vitest';
import type { Camera3 } from 'occlude';
import { viewCameraEdit } from './viewCamera.js';
const ortho: Camera3 = { kind: 'orthographic', span: 4.25, eye: [5, 7, 6], target: [0, 0, 0], near: .1, far: 100 };
const persp: Camera3 = { kind: 'perspective', fovDegrees: 40, eye: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0], near: .1, far: 100 };

it('writes a committed camera into the view call it came from, keyed or by order', async () => {
  const source = `import { sketch } from 'occlude';
import { plane, view, orthographic } from 'occlude/3d';
export default sketch({ seed: 1 }, () => [
  view(plane(2), { key: 'plan', camera: orthographic({ eye: [0, 0, 10], span: 3 }) }),
  view(plane(2), { camera: orthographic({ eye: [5, 7, 6], span: 6 }), stroke: 'ink' }),
]);
`;
  const edit = await viewCameraEdit(source);
  const out = await edit({ plan: ortho, '@1': persp });
  expect(out).toContain(`view(plane(2), { key: 'plan', camera: orthographic({ eye: [5, 7, 6], target: [0, 0, 0], span: 4.25 }) })`);
  expect(out).toContain(`view(plane(2), { camera: perspective({ eye: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0], fovDegrees: 40 }), stroke: 'ink' })`);
  expect(out).toContain(`import { plane, view, orthographic, perspective } from 'occlude/3d';`);
  expect(out).not.toContain('cameras3');
  // A second commit replaces the value rather than growing the source.
  const again = await (await viewCameraEdit(out))({ plan: { ...ortho, span: 8 } });
  expect(again).toContain('span: 8 })'); expect(again.length).toBe(out.length - '4.25'.length + '8'.length);
});
it('adds a camera property when the view had none and respects import aliases', async () => {
  const source = `import { sketch } from 'occlude';
import { box, view as show, perspective as persp } from 'occlude/3d';
export default sketch({}, () => show(box(1), { stroke: 'ink' }));
`;
  const out = await (await viewCameraEdit(source))({ '@1': persp });
  expect(out).toContain(`show(box(1), { stroke: 'ink', camera: persp({ eye: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0], fovDegrees: 40 }) })`);
});
it('falls back to cameras3 configuration for scenes without a view call', async () => {
  const source = `import { sketch, lineArt3, box3 } from 'occlude';
export default sketch({ seed: 2 }, () => lineArt3({ id: 'boxes', objects: [{ id: 'b', surface: box3() }], camera: { kind: 'orthographic', span: 4, eye: [5, 7, 6], target: [0, 0, 0], near: .1, far: 30 }, lineSets: [] }));
`;
  const out = await (await viewCameraEdit(source))({ boxes: ortho });
  expect(out).toContain('cameras3'); expect(out).toContain('"boxes"');
});

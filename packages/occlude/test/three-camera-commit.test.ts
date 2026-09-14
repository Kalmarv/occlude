import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { box3, clip, commitCamera3, compileSketchAsync, constructStrokes3, dash, drawing3, group, initOcclude, label, lineArt3, mask, mm, pen, rect, render, sketch, sketchAsync, type Camera3, type SceneCompute3 } from '../src/index.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';

beforeAll(async () => { await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))); });
const camera: Camera3 = { kind: 'orthographic', span: 4, eye: [4,6,5], target: [0,0,0], near: .1, far: 30 };
const other: Camera3 = { ...camera, eye: [-5,2,3], span: 3 };
const config = { seed: 42, margin: mm(7), pens: { ink: pen({ color: '#18202A', width: mm(.3) }) } };
const scene = () => lineArt3({ camera, objects: [{ id: 'box', surface: box3([2,1,1]) }], lineSets: [{ id: 'v', stroke: 'ink' }] });

it.each(['topLeft', 'center'] as const)('commits a camera without modeling again, preserving %s composition and old output', async origin => {
  let models = 0;
  const source = scene();
  const overlay = rect(18, 20, 8, 14);
  const compose = (value: ReturnType<typeof scene>) => [
    clip(rect(-40, -40, 130, 130), group({ translate: [mm(3), mm(-2)], modifiers: [dash(mm(2), mm(1))] }, value)),
    mask(overlay), label('CAPTURE', 10, 70, 4),
  ];
  const cfg = { ...config, origin, yUp: true };
  const original = await compileSketchAsync(sketch(cfg, t => { models++; t.rnd(); t.plan({ bridge: false }); return compose(source); }));
  const before = render(original).raw;
  const expected = await compileSketchAsync(sketch(cfg, () => compose(lineArt3({ ...source, camera: other }))));
  // Mutating the author's returned 2D values cannot edit retained composition.
  overlay.opts.translate = [1000, 1000];
  const committed = await commitCamera3(original, source, other);
  expect(models).toBe(1);
  expect(render(committed).raw.prims).toEqual(render(expected).raw.prims);
  expect(render(committed).raw.frags).toEqual(render(expected).raw.frags);
  expect(render(original).raw.prims).toEqual(before.prims);
  expect(committed.planOptions).toEqual({ bridge: false });
  const changed = [...committed.scenes3.keys()][0];
  expect(changed.camera.eye).toEqual(other.eye);
  expect(changed.objects).toBe(source.objects);
  const restored = await commitCamera3(committed, changed, camera);
  expect(render(restored).raw.prims).toEqual(before.prims);
});

it('reinterprets styles against the new snapshot and shares unaffected classification', async () => {
  const a = scene(), b = scene(); let calls = 0, models = 0;
  const views: unknown[] = [];
  const compute3: SceneCompute3 = { async classify(snapshot) { calls++; return classifySceneCpu3(snapshot); } };
  const original = await compileSketchAsync(sketch(config, () => {
    models++;
    return [drawing3(a, (view, t) => {
      views.push(view);
      return t.strokes3(constructStrokes3(view, [{ id: 'hidden', stroke: 'ink', visibility: 'hidden' }]));
    }), b];
  }), undefined, { compute3 });
  expect(calls).toBe(2);
  const committed = await commitCamera3(original, a, other, { compute3 });
  expect(calls).toBe(3); expect(models).toBe(1);
  expect(views).toHaveLength(2); expect(views[0]).not.toBe(views[1]);
  expect(committed.scenes3.get(b)).toBe(original.scenes3.get(b));
  expect([...committed.scenes3.keys()][1]).toBe(b);
  expect(original.scenes3.get(a)).toBe(views[0]);
  expect([...committed.scenes3.keys()].find(s => s !== b)?.objects).toBe(a.objects);
});

it('rejects fixed projected strokes instead of rebinding their edits', async () => {
  const source = scene();
  const original = await compileSketchAsync(sketchAsync(config, async t => {
    const view = await t.classify3(source);
    return [source, t.strokes3(constructStrokes3(view, source.lineSets))];
  }));
  await expect(commitCamera3(original, source, other)).rejects.toThrow('fixed strokes');
  await expect(commitCamera3(original, scene(), other)).rejects.toThrow('this retained drawing');
});

it('does not adopt a canceled classification or corrupt the original result', async () => {
  const source = scene();
  const original = await compileSketchAsync(sketch(config, () => source));
  const before = render(original).raw.prims;
  const abort = new AbortController();
  const compute3: SceneCompute3 = { async classify(snapshot) { abort.abort(); return classifySceneCpu3(snapshot); } };
  await expect(commitCamera3(original, source, other, { signal: abort.signal, compute3 })).rejects.toThrow();
  expect(original.scenes3.size).toBe(1);
  expect(render(original).raw.prims).toEqual(before);
  const committed = await commitCamera3(original, source, other);
  expect(render(committed).raw.prims).not.toEqual(before);
});

it('replays explicit camera configuration headlessly without changing the scene value', async () => {
  const source = lineArt3({ ...scene(), id: 'main' });
  const configured = await compileSketchAsync(sketch({ ...config, cameras3: { main: other } }, () => source));
  const expected = await compileSketchAsync(sketch(config, () => lineArt3({ ...source, camera: other })));
  expect(render(configured).raw.prims).toEqual(render(expected).raw.prims);
  expect(source.camera.eye).toEqual(camera.eye);
  const committed = await commitCamera3(configured, source, camera);
  expect(committed.cameras3.main.eye).toEqual(camera.eye);
  const reopened = await compileSketchAsync(sketch({ ...config, cameras3: committed.cameras3 }, () => source));
  expect(render(reopened).raw.prims).toEqual(render(committed).raw.prims);
});

it('keeps numbered camera keys through commits and refuses duplicate explicit IDs', async () => {
  const a = scene(), b = scene();
  const original = await compileSketchAsync(sketch(config, () => [a,b]));
  expect([...original.cameraKeys3.values()]).toEqual(['@1','@2']);
  const committed = await commitCamera3(original,a,other);
  expect([...committed.cameraKeys3.values()]).toEqual(['@1','@2']);
  expect(committed.cameras3['@1'].eye).toEqual(other.eye);
  expect(committed.scenes3.get(b)).toBe(original.scenes3.get(b));
  await expect(compileSketchAsync(sketch(config,()=>[lineArt3({...a,id:'same'}),lineArt3({...b,id:'same'})]))).rejects.toThrow('duplicate 3D scene id');
  const prototypeName = lineArt3({ ...a, id: 'constructor' });
  const run = await compileSketchAsync(sketch(config,()=>prototypeName));
  expect(run.scenes3.get(prototypeName)?.frame.camera.eye).toEqual(camera.eye);
});

it('preserves prototype-like camera configuration keys when committing another scene', async () => {
  const a = lineArt3({ ...scene(), id: '__proto__' }), b = lineArt3({ ...scene(), id: 'main' });
  const cameras3 = Object.fromEntries([['__proto__', other]]);
  const original = await compileSketchAsync(sketch({ ...config, cameras3 }, () => [a,b]));
  const committed = await commitCamera3(original, b, other);
  expect(Object.hasOwn(committed.cameras3, '__proto__')).toBe(true);
  const reopened = await compileSketchAsync(sketch({ ...config, cameras3: committed.cameras3 }, () => [a,b]));
  expect(render(reopened).raw.prims).toEqual(render(committed).raw.prims);
});

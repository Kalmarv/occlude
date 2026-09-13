import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { pen, mm, clip, rect, compileSketch, compileSketchAsync, group, initOcclude, line, lineArt3, render, renderAsync, sketch, type Camera3, type SceneCompute3 } from '../src/index.js';
import { classifySceneCpu3 } from '../src/three/visibility/scene.js';

beforeAll(async () => { await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))); });
const camera: Camera3 = { kind: 'orthographic', span: 2, eye: [0,0,5], target: [0,0,0], up: [0,1,0], near: .1, far: 10 };
const scene = () => lineArt3({ camera, wires: [{ id: 'wire', points: [[-.5,.5,0],[.5,.5,0]] }], lineSets: [{ id: 'visible', stroke: 'black' }] });
const pens = { black: pen({ color: '#000000', width: mm(.3) }) };

describe('deferred 3D scene composition', () => {
  it.each(['topLeft', 'center'] as const)('applies margins once with %s origin and either y direction', async origin => {
    for (const yUp of [false, true]) {
      const config = { origin, yUp, margin: 10, aspect: 'square' as const, pens };
      const y = origin === 'center' ? (yUp ? 25 : -25) : (yUp ? 75 : 25);
      const x = origin === 'center' ? -25 : 25;
      const a = await renderAsync(sketch(config, () => scene()), { paper: { w: 240, h: 180 } });
      const b = render(sketch(config, () => line(x, y, x + 50, y, { stroke: 'black', preserveStroke: true })), { paper: { w: 240, h: 180 } });
      expect(a.raw.prims).toEqual(b.raw.prims);
    }
  });
  it('applies group transforms after projection and reuses one captured visibility result', async () => {
    const value = scene(); let calls = 0;
    const compute3: SceneCompute3 = { async classify(snapshot) { calls++; return classifySceneCpu3(snapshot); } };
    const config = { pens, aspect: 'square' as const };
    const def = sketch(config, () => [value, group({ translate: [10, 0] }, value)]);
    const run = await compileSketchAsync(def, undefined, { compute3 });
    expect(calls).toBe(1); expect(run.scenes3.size).toBe(1);
    const expected = sketch(config, () => [line(25,25,75,25,{stroke:'black',preserveStroke:true}), line(35,25,85,25,{stroke:'black',preserveStroke:true})]);
    expect(render(run).raw.prims).toEqual(render(expected).raw.prims);
    expect(() => compileSketch(def)).toThrow('async rendering required');
  });
  it('captures source geometry and discards cancelled compute results', async () => {
    const points: [number,number,number][] = [[-.5,.5,0],[.5,.5,0]];
    const value = lineArt3({ camera, wires: [{ id: 'wire', points }], lineSets: [{ id: 'visible', stroke: 'black' }] });
    points[0][0] = 100;
    expect(value.wires[0].points[0][0]).toBe(-.5);
    expect(Object.isFrozen(value.wires[0].points[0])).toBe(true);
    const abort = new AbortController();
    const compute3: SceneCompute3 = { async classify(snapshot) { abort.abort(); return classifySceneCpu3(snapshot); } };
    await expect(compileSketchAsync(sketch({ pens }, () => value), undefined, { compute3, signal: abort.signal })).rejects.toThrow();
  });
});

it('projects perspective into an explicit paper viewport before ordinary clipping', async () => {
  const value = lineArt3({
    camera: { ...camera, kind: 'perspective', fovDegrees: 90 },
    viewport: { x: 30, y: 30, width: 100, height: 100 },
    wires: [{ id: 'wire', points: [[-2.5,2.5,0],[2.5,2.5,0]] }],
    lineSets: [{ id: 'visible', stroke: 'black' }],
  });
  const config = { margin: 0, pens };
  const actual = await renderAsync(sketch(config, () => clip(rect(0,0,40,100), value)), { paper: { w: 200, h: 200 } });
  // Projected paper endpoints (55,55) and (105,55); clipping ends at x=80 mm.
  const expected = render(sketch(config, () => clip(rect(0,0,40,100), line(27.5,27.5,52.5,27.5,{stroke:'black',preserveStroke:true}))), { paper: { w: 200, h: 200 } });
  expect(actual.raw.prims).toEqual(expected.raw.prims);
  expect(actual.raw.frags).toEqual(expected.raw.frags);
});

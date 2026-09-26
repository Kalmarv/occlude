import { describe, expect, it } from 'vitest';
import { box3, lineArt3 } from '../src/three/api/advanced.js';
import { gridSurface } from './helpers/surfaces.js';
import { featureSnapshot3, FeatureKind3 } from '../src/three/features/snapshot.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { transformSurface3 } from '../src/three/geometry/model.js';
const camera = { kind: 'orthographic' as const, span: 8, eye: [5,7,6] as const, target: [0,0,0] as const, near: .1, far: 30 };
const frame = cameraFrame3(camera, { x:0,y:0,width:100,height:100 });

describe('explicit stage objects', () => {
  it('flags marked edges as features, from the edge attributes of the surface', () => {
    const surface = gridSurface(2,2,[2,2]);
    for (const e of surface.edges) if (e.faces.length === 1) e.attributes.marked = true;
    expect(featureSnapshot3([{ id:'mesh', surface }],[],frame).features.filter(f => f.flags & FeatureKind3.marked)).toHaveLength(8);
  });
  it('captures shared instance geometry once and applies mirrored transforms before projection', () => {
    const surface = box3(), transform = { translate:[2,0,0] as [number,number,number], rotate:[20,30,10] as const, scale:[-2,1,1] as const };
    const scene = lineArt3({ camera, objects:[{ id:'a',surface },{ id:'b',surface,transform }],lineSets:[{id:'visible',stroke:'black'}] });
    expect(scene.objects[0].surface).toBe(scene.objects[1].surface);
    transform.translate[0] = 99;
    expect(scene.objects[1].transform!.translate![0]).toBe(2);
    const actual = featureSnapshot3([scene.objects[1]],[],frame);
    const expected = featureSnapshot3([{ id:'b',surface:transformSurface3(surface,scene.objects[1].transform!) }],[],frame);
    expect(actual.features).toEqual(expected.features); expect(actual.triangles).toEqual(expected.triangles);
  });
});

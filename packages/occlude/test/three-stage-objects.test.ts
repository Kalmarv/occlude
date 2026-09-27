import { describe, expect, it } from 'vitest';
import { lineArt3 } from '../src/three/api/advanced.js';
import { box } from '../src/three/api/index.js';
import { gridMesh } from './helpers/surfaces.js';
import { featureSnapshot3, FeatureKind3 } from '../src/three/features/snapshot.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { transformPosition3 } from '../src/three/geometry/model.js';
import { mapPositions3 } from '../src/three/geometry/value.js';
import { mesh3 } from '../src/three/geometry/mesh3.js';
const camera = { kind: 'orthographic' as const, span: 8, eye: [5,7,6] as const, target: [0,0,0] as const, near: .1, far: 30 };
const frame = cameraFrame3(camera, { x:0,y:0,width:100,height:100 });

describe('explicit stage objects', () => {
  it('flags marked edges as features, from the edge attributes of the surface', () => {
    const grid = gridMesh(2,2,[2,2]), faces = mesh3(grid).edgeFaces;
    const surface = grid.edges.set('marked', true, e => faces[e.index].length === 1);
    expect(featureSnapshot3([{ id:'mesh', surface }],[],frame).features.filter(f => f.flags & FeatureKind3.marked)).toHaveLength(8);
  });
  it('captures shared instance geometry once and applies mirrored transforms before projection', () => {
    const surface = box(), transform = { translate:[2,0,0] as [number,number,number], rotate:[20,30,10] as const, scale:[-2,1,1] as const };
    const scene = lineArt3({ camera, objects:[{ id:'a',surface },{ id:'b',surface,transform }],lineSets:[{id:'visible',stroke:'black'}] });
    expect(scene.objects[0].surface).toBe(scene.objects[1].surface);
    transform.translate[0] = 99;
    expect(scene.objects[1].transform!.translate![0]).toBe(2);
    const actual = featureSnapshot3([scene.objects[1]],[],frame);
    // The same placement as a value of its own: its points moved and, under
    // a mirror, its faces turned over.
    const placed = mapPositions3(surface, p => transformPosition3(p, scene.objects[1].transform!), 'test', { mirror: true });
    const expected = featureSnapshot3([{ id:'b',surface:placed }],[],frame);
    expect(actual.features).toEqual(expected.features); expect(actual.triangles).toEqual(expected.triangles);
  });
});

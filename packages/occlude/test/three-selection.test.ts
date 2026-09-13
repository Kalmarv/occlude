import { describe, expect, it } from 'vitest';
import { PointSelection3, EdgeSelection3, editPoints3, editEdges3, pointCloud3, grid3, box3, cloneSurface3, lineArt3 } from '../src/index.js';
import { featureSnapshot3, FeatureKind3 } from '../src/three/features/snapshot.js';
import { cameraFrame3 } from '../src/three/camera.js';
import { transformSurface3 } from '../src/three/geometry/model.js';
const camera = { kind: 'orthographic' as const, span: 8, eye: [5,7,6] as const, target: [0,0,0] as const, near: .1, far: 30 };
const frame = cameraFrame3(camera, { x:0,y:0,width:100,height:100 });

describe('3D selection and editing', () => {
  it('captures positions/attributes and derives topology without triangulation diagonals', () => {
    const surface = grid3(2,2,[2,2]), points = new PointSelection3(surface), edges = new EdgeSelection3(surface);
    expect(points.filter(p => p.boundary).length).toBe(8);
    expect(points.filter(p => p.index === 4).adjacent().indices).toEqual([1,3,5,7]);
    expect(edges.length).toBe(12); expect(edges.filter(e => e.boundary).length).toBe(8);
    expect(edges.filter(e => e.boundary).points().indices).toEqual(points.filter(p => p.boundary).indices);
    surface.points[0].position = [100,100,100]; surface.points[0].attributes.tag = 'later';
    expect(points.filter(p => p.position[0] < 0).length).toBe(3);
    expect(points.map(p => p.attributes.tag)[0]).toBeUndefined();
    expect(() => { (points.map(p => p.position)[0] as unknown as number[])[0] = 4; }).toThrow();
    const groups = points.groupBy(p => p.boundary);
    expect(groups.map(g => g.selection.length)).toEqual([8,1]);
    expect(points.filter(p => p.index < 4).union(points.filter(p => p.index >= 4)).length).toBe(9);
    expect(() => points.union(new PointSelection3(surface))).toThrow('different captures');
  });
  it('commits position and edge attribute edits on owned copies and rejects prior-state selections', () => {
    const surface = grid3(2,2,[2,2]), selected = new PointSelection3(surface).filter(p => !p.boundary);
    const moved = editPoints3(surface, selected, p => ({ position: [p.position[0],p.position[1],1], attributes: { raised: true } }));
    expect(surface.points[4].position[2]).toBe(0); expect(moved.points[4].position[2]).toBe(1);
    expect(moved.points.map(p => p.id)).toEqual(surface.points.map(p => p.id));
    expect(moved.triangles).toEqual(surface.triangles);
    expect(() => editPoints3(moved, selected, () => ({}))).toThrow('another surface state');
    const edges = new EdgeSelection3(moved).filter(e => e.boundary);
    const marked = editEdges3(moved, edges, e => ({ ...e.attributes, marked: true, length: e.length }));
    expect(moved.edges.every(e => e.attributes.marked === undefined)).toBe(true);
    expect(featureSnapshot3([{ id:'mesh', surface:marked }],[],frame).features.filter(f => f.flags & FeatureKind3.marked)).toHaveLength(8);
    const before = cloneSurface3(surface);
    expect(() => editPoints3(surface, new PointSelection3(surface), p => { if (p.index === 3) throw new Error('stop'); return { position:[0,0,1] }; })).toThrow('stop');
    expect(surface).toEqual(before);
  });
  it('keeps point clouds editable without inventing edges or faces', () => {
    const cloud = pointCloud3([[0,0,0],[1,2,3]]);
    expect(cloud.faces).toHaveLength(0); expect(cloud.edges).toHaveLength(0);
    const edited = editPoints3(cloud,new PointSelection3(cloud).filter(p => p.position[2] > 0),p => ({ position:[p.position[0],p.position[1],4] }));
    expect(edited.points[1].position[2]).toBe(4); expect(cloud.points[1].position[2]).toBe(3);
    expect(new PointSelection3(cloud).adjacent().length).toBe(0);
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

import {describe,it,expect} from 'vitest';
import {surface3,box3} from '../src/three/geometry/surface.js';
import {subdivideSurface} from '../src/three/api/subdivide.js';
import {measureFaces3} from '../src/three/geometry/model.js';
import {featureSnapshot3,FeatureKind3} from '../src/three/features/snapshot.js';
import {cameraFrame3} from '../src/three/camera.js';
const plane=()=>surface3([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],[[0,1,2,3]]);
const area=(s:ReturnType<typeof plane>)=>measureFaces3(s).reduce((sum,f)=>sum+f.area,0);
describe('generic shape-preserving subdivision',()=>{
 it('produces a shared 32 by 32 quad mesh and rejects growth before allocating',()=>{
  const original=plane(),before=structuredClone(original),refined=subdivideSurface(original,5);
  expect(refined.points.length).toBe(33*33);expect(refined.faces.length).toBe(32*32);
  expect(refined.faces.every(f=>f.vertices.length===4)).toBe(true);
  expect(refined.edges.filter(e=>e.faces.length===1)).toHaveLength(128);
  expect(area(refined)).toBeCloseTo(4);expect(original).toEqual(before);
  expect(()=>subdivideSurface(original,30)).toThrow('exceeds budget');
  expect(subdivideSurface(original,0)).toBe(original);
 });
 it('preserves box shape, watertight edges and crease geometry',()=>{
  const refined=subdivideSurface(box3(),2);
  expect(refined.faces).toHaveLength(96);expect(refined.points).toHaveLength(98);
  expect(refined.edges.every(e=>e.faces.length===2)).toBe(true);
  expect(refined.points.every(p=>Math.max(...p.position.map(Math.abs))===.5)).toBe(true);
  expect(area(refined)).toBeCloseTo(6);
  const frame=cameraFrame3({kind:'orthographic',span:4,eye:[5,7,6],target:[0,0,0],near:.1,far:30},{x:0,y:0,width:100,height:100});
  const features=featureSnapshot3([{id:'box',surface:refined}],[],frame).features;
  expect(features.filter(f=>(f.flags&FeatureKind3.crease)!==0)).toHaveLength(48);
 });
 it('refines concave polygons and mixed faces without cracks or missing area',()=>{
  const mixed=surface3([[0,0,0],[2,0,0],[2,2,0],[1,1,0],[0,2,0],[3,0,0],[3,2,0]],[[0,1,2,3,4],[1,5,6,2]]);
  const refined=subdivideSurface(mixed,2);
  expect(area(refined)).toBeCloseTo(area(mixed));
  expect(new Set(refined.points.map(p=>JSON.stringify(p.position))).size).toBe(refined.points.length);
  // Original shared x=2 edge must remain interior along its entire length.
  expect(refined.edges.filter(e=>e.vertices.every(v=>refined.points[v].position[0]===2)).every(e=>e.faces.length===2)).toBe(true);
 });
 it('preserves folded represented triangles and categorical provenance',()=>{
  const original=plane();original.points[2].position=[1,1,1];
  original.points.forEach((p,i)=>{p.attributes.height=p.position[0];p.attributes.code=i;});
  original.faces[0].attributes.label='roof';original.edges.forEach(e=>e.attributes.marked=true);
  const refined=subdivideSurface(original,1,{}, {code:'nearest'});
  expect(area(refined)).toBeCloseTo(area(original));
  expect(refined.faces).toHaveLength(8);
  expect(refined.faces.every(f=>f.attributes.label==='roof'&&f.provenance?.parents[0]==='f0')).toBe(true);
  expect(refined.points.every(p=>p.attributes.height===p.position[0]&&Number.isInteger(p.attributes.code))).toBe(true);
  expect(refined.edges.filter(e=>e.faces.length===1).every(e=>e.attributes.marked===true&&e.provenance?.parents.length===1)).toBe(true);
  expect(subdivideSurface(original,1,{}, {code:'nearest'})).toEqual(refined);
 });
});

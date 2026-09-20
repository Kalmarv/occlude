import {describe,it,expect} from 'vitest';
import {plane,lamp,environment,axisAngle,v3,type Vec3} from '../src/three/api/index.js';
import {surfaceLocation3} from '../src/three/geometry/location.js';
import type {Mesh} from '../src/three/api/index.js';
import {toneRecipe3,registerToneRecipe3,type ImageRecipe3} from '../src/three/surface/tone.js';

/** The middle of a mesh's first triangle, as a surface location. */
const at=(mesh:Mesh<any,any,any,any>)=>surfaceLocation3(mesh.surface,0,[1/3,1/3,1/3] as unknown as Vec3);
/** A flat sheet facing +Z. */
const sheet=()=>at(plane(2,2));
/** The point a sheet is read at, so a lamp can be put a known way from it. */
const from=(offset:Vec3):Vec3=>v3.add(sheet().position,offset);

describe('lamp',()=>{
 it('is light facing the lamp and dark turned away',()=>{
  const bulb=lamp({position:from([0,0,3]),ambient:.2});
  expect(bulb(sheet())).toBeCloseTo(0,12);
  // The same sheet turned over sees nothing but the ambient light.
  expect(lamp({position:v3.add(at(plane(2,2).rotate([180,0,0])).position,[0,0,3]),ambient:.2})(at(plane(2,2).rotate([180,0,0])))).toBeCloseTo(.8,12);
 });
 it('leans with the angle to the lamp',()=>{
  const bulb=lamp({position:from([4,0,4]),ambient:0});
  // A lamp at 45 degrees above the sheet leaves it about a third dark.
  expect(bulb(sheet())).toBeCloseTo(1-Math.SQRT1_2,12);
 });
 it('falls off with distance',()=>{
  const near=lamp({position:from([0,0,1]),ambient:0,falloff:{radius:4}});
  const far=lamp({position:from([0,0,3]),ambient:0,falloff:{radius:4}});
  expect(near(sheet())).toBeCloseTo(.25,12);
  expect(far(sheet())).toBeCloseTo(.75,12);
  // Beyond the radius the lamp gives nothing at all.
  expect(lamp({position:from([0,0,5]),ambient:0,falloff:{radius:4}})(sheet())).toBeCloseTo(1,12);
  // An ease shapes the fade without changing its ends.
  const eased=lamp({position:from([0,0,2]),ambient:0,falloff:{radius:4,ease:t=>t*t}});
  expect(eased(sheet())).toBeCloseTo(.75,12);
 });
 it('names what it cannot read',()=>{
  expect(()=>lamp({position:[0,0,Number.NaN]})).toThrow('finite');
  expect(()=>lamp(undefined as never)).toThrow('lamp requires');
  expect(()=>lamp({position:[0,0,1],falloff:{radius:1,ease:2 as never}})).toThrow('ease');
  // A radius with no reach lights nothing, rather than failing.
  expect(lamp({position:from([0,0,1]),ambient:0,falloff:{radius:0}})(sheet())).toBe(1);
 });
});

describe('environment',()=>{
 it('is constant for a constant surrounding',()=>{
  const grey=environment(()=>.25);
  expect(grey(sheet())).toBeCloseTo(.75,12);
  expect(grey(at(plane(2,2).rotate([90,0,0])))).toBeCloseTo(.75,12);
 });
 it('lights the faces that look at the bright side',()=>{
  const sky=environment(d=>Math.max(0,d[2]));
  expect(sky(sheet())).toBeCloseTo(0,12);
  expect(sky(at(plane(2,2).rotate([180,0,0])))).toBeCloseTo(1,12);
  expect(sky(at(plane(2,2).rotate([90,0,0])))).toBeCloseTo(1,6);
 });
 it('turns with its orientation',()=>{
  const sky=(orientation?:Vec3)=>environment(d=>Math.max(0,d[2]),orientation?{orientation}:{});
  // Turning the surroundings a quarter over X moves the bright side to -Y,
  // so the sheet facing +Z no longer sees it.
  expect(sky()(sheet())).toBeCloseTo(0,12);
  expect(sky([90,0,0])(sheet())).toBeCloseTo(1,6);
  expect(environment(d=>Math.max(0,d[2]),{orientation:axisAngle('x',90)})(sheet())).toBeCloseTo(1,6);
 });
 it('reads an image sampler by the direction, equirectangularly',()=>{
  // A two-pixel image: dark at the left half of the chart, light at the right.
  const pixels={width:2,height:1,data:new Uint8ClampedArray([0,0,0,255, 255,255,255,255])};
  const recipe:ImageRecipe3={kind:'image',name:'sky',pixels,channel:'lum',origin:'bottom-left',wrap:'repeat',area:0,uvAttribute:'uv'};
  const image=registerToneRecipe3((_s:unknown)=>0,recipe);
  expect(toneRecipe3(image)).toBe(recipe);
  const around=environment(image as never);
  // +X is the middle of the dark pixel, -X the middle of the light one.
  const facingX=at(plane(2,2).rotate([0,90,0]));
  const facingMinusX=at(plane(2,2).rotate([0,-90,0]));
  expect(around(facingX)).toBeGreaterThan(around(facingMinusX));
 });
 it('names what it cannot read',()=>{
  expect(()=>environment(undefined as never)).toThrow('environment requires');
  expect(()=>environment(()=>0,[] as never)).toThrow('options');
  // A sample the surroundings could not give reads as no light.
  expect(environment(()=>Number.NaN)(sheet())).toBe(1);
 });
});

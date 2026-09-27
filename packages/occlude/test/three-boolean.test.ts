import {readFileSync} from 'node:fs';
import {beforeAll,describe,it,expect} from 'vitest';
import { sketch, pen, mm } from '../src/index.js';
import { initOcclude, compileSketchAsync, render } from '../src/host.js';
import {box,sphere,cylinder,view,orthographic} from '../src/three/api/index.js';
import {manifold,volume} from './helpers/surfaces.js';
import {surfaceOf} from '../src/three/geometry/value.js';
import type {Material} from '../src/material.js';

beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));

/** Closed, edge-manifold, consistently wound, and enclosing a positive volume. */
const shape=(m:Material)=>JSON.stringify({points:surfaceOf(m).points.map(p=>[p.id,p.position]),faces:surfaceOf(m).faces.map(f=>[f.id,f.vertices,f.attributes])});

describe('mesh booleans',()=>{
 it('bites one solid out of another and keeps a closed manifold result',()=>{
  const cube=box(2),ball=sphere(1.2,{segments:12,rings:6}).translate([0.9,0.8,0.7]);
  const bitten=cube.subtract(ball);
  manifold(bitten,2);
  expect(volume(bitten)).toBeGreaterThan(0);
  expect(volume(bitten)).toBeCloseTo(8-volume(cube.intersect(ball)),9);
  // The seam is drawable: the faces along it answer `cut`, and they are a ring,
  // not the whole mesh.
  const marked=bitten.faces.filter(f=>f.cut===true);
  expect(marked.length).toBeGreaterThan(0);
  expect(marked.length).toBeLessThan(bitten.faces.length);
  expect(bitten.faces.every(f=>typeof f.cut==='boolean')).toBe(true);
 });
 it('accounts for every bit of both solids',()=>{
  const cube=box(2),ball=sphere(1.2,{segments:12,rings:6}).translate([0.9,0.8,0.7]);
  // union + intersection = the two solids, exactly, for any pair that meets.
  expect(volume(cube.union(ball))+volume(cube.intersect(ball))).toBeCloseTo(8+volume(ball),9);
  expect(volume(cube.subtract(ball))).toBeCloseTo(8-volume(cube.intersect(ball)),9);
 });
 it('unites two overlapping boxes to the sum less the overlap',()=>{
  const a=box(2),b=box(2).translate([1,1,1]);
  manifold(a.union(b),2);manifold(a.intersect(b),2);manifold(a.subtract(b),2);
  expect(volume(a.union(b))).toBeCloseTo(8+8-1,9);
  expect(volume(a.intersect(b))).toBeCloseTo(1,9);
  expect(volume(a.subtract(b))).toBeCloseTo(7,9);
  // The overlap of two axis-aligned boxes is a box: six faces and no more.
  expect(a.intersect(b).faces.length).toBe(12);
 });
 it('cuts a hole right through a solid, which changes its genus',()=>{
  const drilled=box(2).subtract(cylinder(0.6,4,{segments:16}));
  manifold(drilled,0);
  // The bore is the prism of a regular 16-gon, two units of box deep.
  expect(volume(drilled)).toBeCloseTo(8-0.5*16*0.36*Math.sin(2*Math.PI/16)*2,9);
 });
 it('leaves solids that never meet alone',()=>{
  const a=box(2),far=box(1).translate([9,0,0]);
  const both=a.union(far);
  manifold(both,4); // two closed components
  expect(volume(both)).toBeCloseTo(9,9);
  expect(a.intersect(far).faces.length).toBe(0);
  expect(a.intersect(far).points.length).toBe(0);
  expect(volume(a.subtract(far))).toBeCloseTo(8,9);
  expect(a.subtract(far).faces.length).toBe(6);
  // A box inside a box leaves a void: two shells, one solid.
  const hollow=box(2).subtract(box(1));
  manifold(hollow,4);
  expect(volume(hollow)).toBeCloseTo(7,9);
 });
 it('keeps a shared wall out of a union and inside a difference',()=>{
  const flush=box(2).union(box(2).translate([2,0,0]));
  manifold(flush,2);
  expect(volume(flush)).toBeCloseTo(16,9);
  expect(flush.faces.length).toBeLessThan(24); // the wall they share is gone
  expect(volume(box(2).subtract(box(2).translate([2,0,0])))).toBeCloseTo(8,9);
  expect(volume(box(2).union(box([2,1,1]).translate([2,0,0])))).toBeCloseTo(10,9);
  // The same solid twice: the union and the intersection are that solid, and
  // the difference is nothing at all.
  expect(volume(box(2).intersect(box(2)))).toBeCloseTo(8,9);
  expect(box(2).subtract(box(2)).faces.length).toBe(0);
 });
 it('refuses an open shell by name, and a result it cannot close',()=>{
  const shell=cylinder(1,2,{segments:8,caps:false});
  expect(()=>box(2).subtract(shell)).toThrow('subtract: the second mesh is not closed (16 boundary edges)');
  expect(()=>shell.union(box(2))).toThrow('union: the first mesh is not closed');
  expect(()=>(box(2) as Material).intersect({} as Material)).toThrow('intersect: the second value is not a mesh');
  // Two boxes that meet along one edge have no manifold union: the operation
  // says so instead of handing back a surface nothing can draw.
  expect(()=>box(2).union(box(2).translate([2,2,0]))).toThrow('union: the result is not a manifold surface');
 });
 it('carries identity and columns across the cut',()=>{
  const cube=box(2).faces.set('wall',f=>f.index).points.set('h',p=>p.z);
  const ball=sphere(1.2,{segments:12,rings:6}).translate([0.9,0.8,0.7]).faces.set('wall',()=>99);
  const bitten=cube.subtract(ball);
  // An untouched face of the first solid keeps its own identity.
  expect(surfaceOf(bitten).faces.some(f=>f.id==='f0')).toBe(true);
  // Every piece keeps the column of the face it came from, and the pieces of
  // the second solid keep theirs.
  expect(bitten.faces.every(f=>typeof f.wall==='number')).toBe(true);
  expect(bitten.faces.some(f=>f.wall===99)).toBe(true);
  expect(new Set(surfaceOf(bitten).points.map(p=>p.id)).size).toBe(bitten.points.length);
  expect(new Set(surfaceOf(bitten).faces.map(f=>f.id)).size).toBe(bitten.faces.length);
  // A seam point is a new point, with the column blended from the first
  // solid's triangle it was cut on, so a later displacement has a number to
  // read; the second solid's own points keep only the columns they had.
  const seam=bitten.points.filter(p=>surfaceOf(bitten).points[p.index].id.startsWith(`["subtract",0,"cut"`));
  expect(seam.length).toBeGreaterThan(0);
  expect(seam.every(p=>Number.isFinite(p.h)&&Math.abs(p.h-p.z)<1e-9)).toBe(true);
  // `cut` accumulates down a chain: the second bite keeps the first bite's
  // seam marked, so one pen draws every seam of the whole chain.
  const twice=bitten.subtract(sphere(0.9,{segments:12,rings:6}).translate([-0.9,-0.8,-0.7]));
  manifold(twice,2);
  expect(twice.faces.filter(f=>f.cut===true).length).toBeGreaterThan(bitten.faces.filter(f=>f.cut===true).length);
 });
 it('gives the same mesh for the same solids',()=>{
  const make=()=>box(2).subtract(sphere(1.2,{segments:12,rings:6}).translate([0.9,0.8,0.7]));
  expect(shape(make())).toBe(shape(make()));
  expect(shape(box(2).union(box(2).translate([1,1,1])))).toBe(shape(box(2).union(box(2).translate([1,1,1]))));
 });
 it('draws through a view with hidden lines',async()=>{
  const bitten=box(2).subtract(sphere(1.2,{segments:12,rings:6}).translate([0.9,0.8,0.7]));
  let visible=0,hidden=0;
  const drawing=view(bitten,{camera:orthographic({eye:[5,7,6],span:6}),pen:'ink',creaseAngle:20},lines=>{visible=lines.visible.length;hidden=lines.hidden.length;return undefined;});
  const config={seed:42,margin:0,pens:{ink:pen({width:mm(0.25),color:'#112233'})}};
  const execution=await compileSketchAsync(sketch(config,()=>view(bitten,{camera:orthographic({eye:[5,7,6],span:6}),pen:'ink',creaseAngle:20})));
  expect(render(execution).raw.frags.length).toBeGreaterThan(0);
  await compileSketchAsync(sketch(config,()=>drawing));
  expect(visible).toBeGreaterThan(0);
  expect(hidden).toBeGreaterThan(0);
 });
});

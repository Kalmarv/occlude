import {describe,expect,it} from 'vitest';
import {box,instanceOnPoints,intersections,mesh,pointCloud} from 'occlude/3d';
import {compileSketch,sketch} from '../src/index.js';
import {SurfaceCurves} from '../src/three/api/advanced.js';
import {sampleSurfaceCurves} from '../src/three/api/curveSampling.js';
import {point,type H} from '../src/three/geometry/exact.js';
import {surfaceBinding3,surfaceCurveNetwork3} from '../src/three/curves/network.js';
import {surfaceLocation3,rebindSurfaceLocation3} from '../src/three/geometry/location.js';

const source=()=>mesh([[0,0,0],[10,0,0],[0,10,0]],[[0,1,2]]);
const binding=()=>surfaceBinding3(source().surface);
const graph=(nodes:readonly {id:string;point:H}[],segments:readonly {id:string;a:string;b:string;chainId?:string;range?:readonly [number,number]}[],sources=[{id:'surface',binding:binding()}])=>new SurfaceCurves(surfaceCurveNetwork3({sources,nodes:nodes.map(n=>({...n,supports:[{source:0,triangle:0}]})),segments:segments.map(s=>({...s,kind:'trace' as const,supports:[{source:0,triangle:0}],chainId:s.chainId??'chain',range:s.range??[0,1] as const}))}));

describe('surface curve sampling',()=>{
 it('samples open chains at endpoints and uniform arc length',()=>{
  const curves=graph([{id:'a',point:point([0,0,0])},{id:'b',point:point([3,0,0])},{id:'c',point:point([3,4,0])}], [
   {id:'ab',a:'a',b:'b',range:[0,.5]}, {id:'bc',a:'b',b:'c',range:[.5,1]},
  ]);
  const samples=sampleSurfaceCurves(curves,{count:5});
  expect(samples.points.map(p=>[p.x,p.y])).toEqual([[0,0],[1.75,0],[3,0.5],[3,2.25],[3,4]]);
  const rows=[...samples.points];
  expect(rows[0].sample.parameter).toBe(0);
  expect(rows.at(-1)!.sample.parameter).toBe(1);
  expect(samples.points.every(p=>p.sample.tangent.every(Number.isFinite))).toBe(true);
 });

 it('keeps closed rings seam-free and splits gaps into contiguous chains',()=>{
  const ring=graph([{id:'a',point:point([0,0,0])},{id:'b',point:point([2,0,0])},{id:'c',point:point([2,2,0])},{id:'d',point:point([0,2,0])}], [
   {id:'ab',a:'a',b:'b',range:[0,.25]}, {id:'bc',a:'b',b:'c',range:[.25,.5]}, {id:'cd',a:'c',b:'d',range:[.5,.75]}, {id:'da',a:'d',b:'a',range:[.75,1]},
  ]);
  const closed=sampleSurfaceCurves(ring,{count:4});
  expect(closed.points.length).toBe(4);expect(closed.points.map(p=>[p.x,p.y])).toEqual([[0,0],[2,0],[2,2],[0,2]]);
  const gapped=graph([{id:'a',point:point([0,0,0])},{id:'b',point:point([2,0,0])},{id:'c',point:point([4,0,0])},{id:'d',point:point([6,0,0])}], [
   {id:'ab',a:'a',b:'b',range:[0,.25]}, {id:'bc',a:'b',b:'c',range:[.5,.75]}, {id:'cd',a:'c',b:'d',range:[.75,1]},
  ]);
  expect(sampleSurfaceCurves(gapped,{count:2}).points.length).toBe(4);
 });

 it('retains exact multi-source incidence, rational weights, tangent, and ownership lookup',()=>{
  const a=source(),b=source();
  const p=[1n,1n,0n,3n] as H,q=[2n,1n,0n,3n] as H;
  const multi=new SurfaceCurves(surfaceCurveNetwork3({sources:[{id:'a',binding:surfaceBinding3(a.surface)},{id:'b',binding:surfaceBinding3(b.surface)}],nodes:[
   {id:'p',point:p,supports:[{source:0,triangle:0},{source:1,triangle:0}]},{id:'q',point:q,supports:[{source:0,triangle:0},{source:1,triangle:0}]},
  ],segments:[{id:'edge',kind:'trace',a:'p',b:'q',supports:[{source:0,triangle:0},{source:1,triangle:0}]}]}));
  const row=[...sampleSurfaceCurves(multi,{count:3}).points][1],locations=row.sample.locations;
  expect(locations).toHaveLength(2);expect(locations[0].exact).toBeDefined();expect(locations[0].barycentric[0]).toBeCloseTo(11/12);expect(locations[0].barycentric[1]).toBeCloseTo(1/20);expect(locations[0].barycentric[2]).toBeCloseTo(1/30);
  expect(row.sample.tangent).toEqual([1,0,0]);expect(row.sample.on(a)).toHaveLength(1);expect(row.sample.on(b)).toHaveLength(1);
 });

 it('preserves sample provenance through edits, selection, extraction, attributes, and steps',()=>{
  const curves=graph([{id:'a',point:point([0,0,0])},{id:'b',point:point([4,0,0])}],[{id:'edge',a:'a',b:'b'}]);
  const samples=sampleSurfaceCurves(curves,{count:3}),rows=[...samples.points];
  expect([...samples.translate([1,2,0]).points][1].sample.exact).toEqual(rows[1].sample.exact);
  expect([...samples.attribute('mark',p=>p.index).points][1].sample.edgeId).toBe(rows[1].sample.edgeId);
  expect(samples.points.filter(p=>p.index>0).extract().points).toHaveLength(2);
  const stepped=samples.attribute('mark','initial').steps(1,(current,edit)=>edit.set(current.points.at(0)!,()=>({mark:'step'})));
  expect([...stepped.points][0].sample.locations).toHaveLength(1);
 });

 it('requires shared construction lineage for explicit rebind and honors budgets',()=>{
  const model=source(),curves=new SurfaceCurves(surfaceCurveNetwork3({sources:[{id:'surface',binding:surfaceBinding3(model.surface)}],nodes:[{id:'a',point:point([0,0,0]),supports:[{source:0,triangle:0}]},{id:'b',point:point([4,0,0]),supports:[{source:0,triangle:0}]}],segments:[{id:'edge',kind:'trace',a:'a',b:'b',supports:[{source:0,triangle:0}]}]}));
  const samples=sampleSurfaceCurves(curves,{count:3});
  const rebound=curves.rebind(model);expect([...samples.rebind(rebound).points][1].sample.locations).toHaveLength(1);
  const unrelated=graph([{id:'a',point:point([0,0,0])},{id:'b',point:point([4,0,0])}],[{id:'edge',a:'a',b:'b'}]);
  expect(()=>samples.rebind(unrelated)).toThrow('regenerate');
  expect(()=>sampleSurfaceCurves(curves,{count:4,maxPoints:3})).toThrow('point budget');
  expect(()=>sampleSurfaceCurves(curves,{count:3,maxSupports:2})).toThrow('support budget');
 });

 it('reorders exact rational weights when rebinding a mirrored triangle',()=>{
  const model=source(),location=surfaceLocation3(model.surface,0,[.2,.3,.5],{exactWeights:[2n,3n,5n]});
  const mirrored=model.scale([-1,1,1]),rebound=rebindSurfaceLocation3(location,mirrored.surface);
  expect(rebound.exact).toBeDefined();
  expect(rebound.position).toEqual([-3,5,0]);
  expect(rebound.barycentric).toEqual([.2,.5,.3]);
 });

 it('works through t.sample and instance ownership on an intersection seam',()=>{
  const [a,b]=[box(2),box(2).translate([1,0,0])],curves=intersections(a,b),sites=pointCloud([[0,0,0]]),instances=instanceOnPoints(a,sites.points);
  let sampled!:ReturnType<typeof sampleSurfaceCurves>;
  compileSketch(sketch({},t=>{sampled=t.sample(curves,{count:2});return null;}));
  expect(sampled.points.length).toBeGreaterThan(0);
  const seam=sampled.points.find(p=>p.sample.locations.length>1);expect(seam).toBeDefined();
  expect(seam!.sample.on(a).length+seam!.sample.on(b).length).toBeGreaterThan(0);
  expect(seam!.sample.on(instances)).toHaveLength(0);
 });
});

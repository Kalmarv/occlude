import {describe,it,expect} from 'vitest';
import {mesh} from 'occlude/3d';
import {point,type H} from '../src/three/geometry/exact.js';
import {surfaceBinding3,bindingPoint3,bindingTriangle3,bindingWorld3,surfaceCurveNetwork3,selectSurfaceCurveNetwork3,validateSurfaceCurveNetwork3} from '../src/three/curves/network.js';
const planes=()=>[
 surfaceBinding3(mesh([[1,0,0],[0,1,0],[0,0,1]],[[0,1,2]]).surface),
 surfaceBinding3(mesh([[0,0,0],[1,1,0],[0,0,1]],[[0,1,2]]).surface),
];
function seam(){const [a,b]=planes();return {
 sources:[{id:'a',binding:a},{id:'b',binding:b}],
 nodes:[{id:'p',point:[1n,1n,1n,3n] as H},{id:'q',point:[2n,2n,1n,5n] as H}],
 segments:[{id:'seam',kind:'intersection' as const,a:'p',b:'q',supports:[{source:0,triangle:0},{source:1,triangle:0}],chainId:'contact',range:[.2,.8] as const}],
};}
describe('canonical supported curve graph',()=>{
 it('keeps exact incidence and endpoint contexts on both surfaces',()=>{
  const network=surfaceCurveNetwork3(seam()),segment=network.segments[0];
  expect(segment.supports.length).toBe(2);expect(network.nodes.every(p=>p.supports.length===2)).toBe(true);
  expect(segment.supports[0].a).toEqual(['1','1','1']);expect(segment.supports[1].b).toEqual(['2','2','1']);
  expect(segment.range).toEqual([.2,.8]);expect(segment.chainId).toBe('contact');expect(segment.length).toBeGreaterThan(0);
  expect(Object.isFrozen(network.nodes[0].supports)).toBe(true);expect(()=>JSON.stringify(network)).not.toThrow();
  expect(()=>validateSurfaceCurveNetwork3({...network})).toThrow('owned validated graph');
 });
 it('rejects labels and rounded near-incidence as substitutes for support',()=>{
  const input=seam();input.nodes[0].point=point([1/3,1/3,1/3]);
  expect(()=>surfaceCurveNetwork3(input)).toThrow('not incident');
  const forged=seam();forged.sources[1].binding={...forged.sources[1].binding};
  expect(()=>surfaceCurveNetwork3(forged)).toThrow('owned surface binding');
  const wrong=seam();wrong.sources[1].binding=surfaceBinding3(mesh([[0,0,2],[1,0,2],[0,1,2]],[[0,1,2]]).surface);
  expect(()=>surfaceCurveNetwork3(wrong)).toThrow('not incident');
 });
 it('retains branches and the full source reference when selecting segments',()=>{
  const binding=surfaceBinding3(mesh([[0,0,0],[2,0,0],[0,2,0]],[[0,1,2]]).surface);
  const network=surfaceCurveNetwork3({sources:[{id:'sheet',binding}],nodes:[
   {id:'o',point:point([.2,.2,0])},{id:'a',point:point([.8,.2,0])},{id:'b',point:point([.2,.8,0])},{id:'c',point:point([.1,.1,0])},
  ],segments:['a','b','c'].map(id=>({id,kind:'trace',a:'o',b:id,supports:[{source:0,triangle:0}]}))});
  expect(network.segments.filter(e=>e.a===0||e.b===0).length).toBe(3);
  const selected=selectSurfaceCurveNetwork3(network,[2,0]);expect(selected.segments.map(s=>s.id)).toEqual(['a','c']);expect(selected.reference).toBe(network);
  expect(selectSurfaceCurveNetwork3(selected,[0]).reference).toBe(network);
 });
 it('retains isolated tangent contacts as attributed point data',()=>{
  const [a,b]=planes(),network=surfaceCurveNetwork3({sources:[{id:'a',binding:a},{id:'b',binding:b}],nodes:[{id:'touch',point:point([0,0,1]),supports:[{source:0,triangle:0},{source:1,triangle:0}],attributes:{contact:'tangent'}}],segments:[]});
  expect(network.segments).toEqual([]);expect(network.nodes[0].supports.length).toBe(2);
  const input=seam();input.nodes[1].point=input.nodes[0].point;expect(()=>surfaceCurveNetwork3(input)).toThrow('zero-length');
 });
 it('does not weld an exact positive separation that rounds to the same position',()=>{
  const binding=surfaceBinding3(mesh([[0,0,0],[1,0,0],[0,1,0]],[[0,1,2]]).surface);
  const network=surfaceCurveNetwork3({sources:[{id:'sheet',binding}],nodes:[{id:'a',point:point([0,0,0])},{id:'b',point:[1n,0n,0n,1n<<1100n]}],segments:[{id:'tiny',kind:'intersection',a:'a',b:'b',supports:[{source:0,triangle:0}]}]});
  expect(network.nodes[0].position).toEqual(network.nodes[1].position);expect(network.nodes[0].exact).not.toEqual(network.nodes[1].exact);
  expect(network.segments.length).toBe(1);expect(network.segments[0].a).not.toBe(network.segments[0].b);
 });
 it('validates budgets and source parameter ownership before publishing a graph',()=>{
  expect(()=>surfaceCurveNetwork3(seam(),{maxNodes:1})).toThrow('budget');expect(()=>surfaceCurveNetwork3(seam(),{maxSources:1})).toThrow('budget');
  expect(()=>surfaceCurveNetwork3(seam(),{maxSupports:1})).toThrow('budget');expect(()=>surfaceCurveNetwork3(seam(),{maxExactBytes:1})).toThrow('budget');
  const input=seam();input.segments.push({...input.segments[0],id:'duplicate phase'});expect(()=>surfaceCurveNetwork3(input)).toThrow('overlapping');
 });
 it('shares prototype bindings while keeping distinct placement inputs separate',()=>{
  const model=mesh([[0,0,0],[3,0,0],[0,3,0]],[[0,1,2]]),place={id:'placed',transform:{translate:[1e16,0,0] as const}};
  const binding=surfaceBinding3(model.surface,place);expect(surfaceBinding3(model.surface,place)).toBe(binding);
  expect(surfaceBinding3(model.surface,structuredClone(place))).not.toBe(binding);
  expect(bindingTriangle3(binding,0)).toBe(bindingTriangle3(binding,0));
  const world=bindingWorld3(binding);expect(world.points[1].position[0]).toBe(1e16+4);
  const p=bindingPoint3(binding,0,[.05,.9,.05]);expect(p[0]).toBeGreaterThan(p[3]*10000000000000000n);
 });
});

import {describe,expect,it} from 'vitest';
import {box,mesh} from 'occlude/3d';
import {grid3} from '../src/three/geometry/model.js';
import {point,type H} from '../src/three/geometry/exact.js';
import {runGeometryJob3} from '../src/three/geometry/job.js';
import {surfaceBinding3,surfaceCurveNetwork3} from '../src/three/curves/network.js';
import {intersectionContacts3} from '../src/three/curves/intersectionContacts.js';
import {intersectionAtomsJob3,type IntersectionAtom3} from '../src/three/curves/intersectionAtoms.js';
import {intersectionGraphInputJob3} from '../src/three/curves/intersectionGraph.js';
import {intersections3,intersectionsAsync3} from '../src/three/curves/intersections.js';

const support={source:0,triangle:0};
const sheet=()=>surfaceBinding3(mesh([[0,0,0],[4,0,0],[0,4,0]],[[0,1,2]]).surface);
const p=(x:number,y:number):H=>point([x,y,0]);
const atom=(a:H,b:H):IntersectionAtom3=>({a,b,partition:'synthetic',contact:'transverse',supports:[support]});
const build=(segments:readonly IntersectionAtom3[],points:readonly {point:H;partition:string;supports:readonly {source:number;triangle:number}[]}[]=[])=>{
 const a=sheet(),b=sheet();
 return runGeometryJob3(intersectionGraphInputJob3([a,b],segments,points)).value;
};
const coords=(input:ReturnType<typeof build>)=>new Map(input.nodes.map(n=>[n.id,n.point.join(',')]));
const geometry=(input:ReturnType<typeof build>)=>input.segments.map(s=>{
 const c=coords(input);return [c.get(s.a),c.get(s.b)].sort().join('|');
}).sort();

describe('intersection graph assembly',()=>{
 it('assembles open chains and ignores a collinear support split for chain identity',()=>{
  const direct=build([atom(p(0,0),p(2,0))]);
  const split=build([atom(p(0,0),p(1,0)),atom(p(1,0),p(2,0))]);
  expect(split.segments).toHaveLength(2);
  expect(new Set(split.segments.map(s=>s.chainId)).size).toBe(1);
  expect(split.segments[0].chainId).toBe(direct.segments[0].chainId);
 });

 it('closes loops and preserves branches as separate chains',()=>{
  const loop=build([
   atom(p(0,0),p(1,0)),atom(p(1,0),p(1,1)),atom(p(1,1),p(0,1)),atom(p(0,1),p(0,0)),
  ]);
  expect(loop.segments).toHaveLength(4);
  expect(new Set(loop.segments.map(s=>s.chainId)).size).toBe(1);
  const branch=build([atom(p(0,0),p(1,0)),atom(p(0,0),p(0,1)),atom(p(0,0),p(.5,.5))]);
  expect(branch.segments).toHaveLength(3);
  expect(new Set(branch.segments.map(s=>s.chainId)).size).toBe(3);
 });

 it('is invariant to input edge order and direction',()=>{
  const source=[atom(p(0,0),p(1,0)),atom(p(1,0),p(1,1)),atom(p(1,1),p(0,1)),atom(p(0,1),p(0,0))];
  const reversed=source.slice().reverse().map(s=>({...s,a:s.b,b:s.a}));
  const left=build(source),right=build(reversed);
  expect(geometry(left)).toEqual(geometry(right));
  expect(left.segments.map(s=>s.chainId)).toEqual(right.segments.map(s=>s.chainId));
  expect(left.segments.map(s=>s.id)).toEqual(right.segments.map(s=>s.id));
 });

 it('retains isolated contacts as supported point nodes',()=>{
  const input=build([], [{point:p(.5,.5),partition:'synthetic',supports:[support]}]);
  expect(input.segments).toEqual([]);
  expect(input.nodes).toHaveLength(1);
  expect(input.nodes[0].supports).toEqual([support]);
  expect(()=>surfaceCurveNetwork3(input)).not.toThrow();
 });

 it('builds a validated graph from actual cube contacts',()=>{
  const a=surfaceBinding3(box().surface),b=surfaceBinding3(box().translate([.3,.4,.2]).surface);
  const contacts=intersectionContacts3(a,b).value;
  const atoms=runGeometryJob3(intersectionAtomsJob3(contacts)).value;
  const input=runGeometryJob3(intersectionGraphInputJob3([a,b],atoms.segments,atoms.points)).value;
  const network=surfaceCurveNetwork3(input);
  expect(network.segments.length).toBeGreaterThan(0);
  expect(network.segments.every(s=>s.kind==='intersection'&&s.supports.length>0)).toBe(true);
  expect(network.nodes.every(n=>n.supports.length>0)).toBe(true);
 });

 it('keeps synchronous and asynchronous complete intersections equivalent',async()=>{
  const a=surfaceBinding3(box().surface),b=surfaceBinding3(box().translate([.3,.4,.2]).surface);
  const sync=intersections3(a,b).value,asyncResult=await intersectionsAsync3(a,b);
  expect(asyncResult.value.network.segments.map(s=>s.id)).toEqual(sync.network.segments.map(s=>s.id));
  expect(asyncResult.value.network.nodes.map(n=>n.exact)).toEqual(sync.network.nodes.map(n=>n.exact));
  expect(asyncResult.value.stats.outputSegments).toBe(sync.stats.outputSegments);
  const ca=surfaceBinding3(grid3(40,40,[4,4])),cb=surfaceBinding3(grid3(40,40,[4,4]));
  const controller=new AbortController();
  const pending=intersectionsAsync3(ca,cb,{},controller.signal);
  setTimeout(()=>controller.abort(new Error('cancel intersections')),0);
  await expect(pending).rejects.toThrow('cancel intersections');
 });
});

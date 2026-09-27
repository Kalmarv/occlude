import {describe,it,expect} from 'vitest';
import {box,curve,plane,pointCloud,instanceOnPoints,orthographic} from '../src/three/api/index.js';
import {projectedLines} from '../src/three/api/advanced.js';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {classifySceneCpu3} from '../src/three/visibility/scene.js';
import {cameraFrame3} from '../src/three/camera.js';
import type {Material,Edge} from '../src/material.js';

/** An edge column declared with each policy: `len` an extensive quantity
 * (its length, distributed), `pen` a category (copied). */
const marked=<M extends Material>(m:M):Material=>m
 .edges.set('len',(e:Edge)=>e.length,{transfer:'distribute'})
 .edges.set('pen',(e:Edge)=>e.index%3);
type Row=Edge&{len:number;pen:number};
const rows=(m:Material)=>[...m.edges] as Row[];
const sum=(values:readonly number[])=>values.reduce((a,b)=>a+b,0);
/** Every edge of `out` whose source is an edge of `m`, grouped by it. */
const bySource=(m:Material,out:Material)=>{
 const groups=new Map<Row,Row[]>();
 for(const e of rows(out)){const s=e.source as Row|undefined;if(s===undefined||!m.edges.some(x=>x===s))continue;const list=groups.get(s)??[];list.push(e);groups.set(s,list);}
 return groups;
};

describe('every 3D derivation carries the edge policies',()=>{
 it('subdivide: a split edge\'s halves hold half of a distributed column each, the category whole',()=>{
  const m=marked(box(2));
  for(const levels of [1,2]){
   const out=m.subdivide(levels);
   expect(out.edgeTransfers).toEqual({len:'distribute'});
   const groups=bySource(m,out);
   expect(groups.size).toBe(m.edges.length);
   for(const [s,pieces] of groups){
    expect(pieces.length).toBe(2**levels);
    for(const e of pieces){expect(e.len).toBeCloseTo(e.length,12);expect(e.pen).toBe(s.pen);}
    expect(sum(pieces.map(e=>e.len))).toBeCloseTo(s.len,12);
   }
   // A made edge across a face holds none of any edge.
   for(const e of rows(out))if(e.source===undefined)expect([e.len,e.pen]).toEqual([0,0]);
  }
 });
 it('displace and smooth keep the policies and the values',()=>{
  const m=marked(plane(2,2).subdivide(1)).faces.set('h',f=>f.index);
  const moved=m.displace(0.1);
  expect(moved.edgeTransfers).toEqual({len:'distribute'});
  expect(rows(moved).map(e=>e.len)).toEqual(rows(m).map(e=>e.len));
  const smoothed=m.smooth('h');
  expect(smoothed.edgeTransfers).toEqual({len:'distribute'});
  expect(rows(smoothed).map(e=>[e.len,e.pen])).toEqual(rows(m).map(e=>[e.len,e.pen]));
 });
 it('dual: an edge of the dual crosses one edge and keeps its columns whole',()=>{
  const m=marked(box(2)),out=m.dual();
  expect(out.edgeTransfers).toEqual({len:'distribute'});
  expect(out.edges.length).toBe(m.edges.length);
  const crossed=new Set<Row>();
  for(const e of rows(out)){
   const s=e.source as Row;
   expect(m.edges.some(x=>x===s)).toBe(true);
   expect([e.len,e.pen]).toEqual([s.len,s.pen]);
   crossed.add(s);
  }
  expect(crossed.size).toBe(m.edges.length);
 });
 it('extrude: a cap edge is its edge moved, whole; a wall\'s rising edge copies the category and holds none of the quantity',()=>{
  const m=marked(plane(2,2).subdivide(1));
  const out=m.extrude(m.faces,1);
  expect(out.edgeTransfers).toEqual({len:'distribute'});
  const z=(e:Edge)=>[(e.a as unknown as {z:number}).z,(e.b as unknown as {z:number}).z];
  let caps=0,rising=0,below=0;
  for(const e of rows(out)){
   const s=e.source as Row;
   expect(m.edges.some(x=>x===s)).toBe(true);
   const [za,zb]=z(e);
   if(za===1&&zb===1){expect(e.length).toBeCloseTo(s.length,12);expect([e.len,e.pen]).toEqual([s.len,s.pen]);caps++;}
   else if(za===0&&zb===0){expect([e.len,e.pen]).toEqual([s.len,s.pen]);below++;}
   else{expect(e.len).toBe(0);expect(e.pen).toBe(s.pen);rising++;}
  }
  // Every edge of the plane moves with the cap, the ones inside it too; the
  // rim stays below as well, and a wall rises from each rim point.
  expect(caps).toBe(m.edges.length);expect(below).toBe(8);expect(rising).toBe(8);
 });
 it('along and resample: the plane\'s rules — the edge under a place, the shares of the run it covers',()=>{
  const path=marked(curve([[0,0,0],[2,0,0],[2,3,0],[0,3,1]]));
  const total=sum(rows(path).map(e=>e.len));
  const at=path.along({count:7});
  const points=[...at.points] as unknown as {len:number;pen:number;source:Row}[];
  expect(sum(points.map(p=>p.len))).toBeCloseTo(total,12);
  // A copied column is the edge the point lies on (the next one at a
  // vertex; none of these seven stands on one but the ends).
  const corners=[2,5];
  for(const p of points as unknown as {s:number;pen:number;source:Row}[])if(!corners.some(c=>Math.abs(p.s-c)<1e-9))expect(p.pen).toBe(p.source.pen);
  expect(points.map(p=>p.pen)).toEqual(points.map(p=>p.source.pen));
  const again=path.resample({count:9});
  expect(again.edgeTransfers).toEqual({len:'distribute'});
  expect(sum(rows(again).map(e=>e.len))).toBeCloseTo(total,12);
  // A straight run of one edge holds its length.
  const first=rows(again)[0];
  expect(first.len).toBeCloseTo(first.length,12);expect(first.pen).toBe((path.edges.at(0) as Row).pen);
 });
 it('realize: every copy keeps the prototype\'s edge columns and their policy',()=>{
  const prototype=marked(box(1));
  const out=instanceOnPoints(prototype,pointCloud([[0,0,0],[3,0,0]]).points).realize();
  expect(out.edgeTransfers).toEqual({len:'distribute'});
  const own=rows(prototype);
  expect(rows(out).map(e=>[e.len,e.pen])).toEqual([...own,...own].map(e=>[e.len,e.pen]));
 });
 it('the visibility stage: a line over part of an edge holds that part of a distributed column',()=>{
  const m=marked(box(2));
  // A small box in front hides part of the marked box's edges.
  const frame=cameraFrame3(orthographic({eye:[0,0,10],up:[0,1,0],span:5}),{x:0,y:0,width:100,height:100});
  const snapshot=featureSnapshot3([{id:'box',surface:m},{id:'front',surface:box(1).translate([1,-1,3])}],[],frame);
  type Line={len:number;pen:number;range:readonly [number,number];feature:{distribute?:readonly string[];attributes:{len:number;pen:number};range:readonly [number,number]}};
  const lines=projectedLines(classifySceneCpu3(snapshot));
  // The lines along an edge (a diagonal of a face carries no edge columns).
  const all=([...lines.visible,...lines.hidden] as unknown as Line[]).filter(line=>line.feature.distribute!==undefined);
  expect(all.length).toBeGreaterThan(12);
  const shares=new Map<Line['feature'],number>();
  let parts=0;
  for(const line of all){
   expect(line.feature.distribute).toEqual(['len']);
   const whole=line.feature.attributes.len,part=(line.range[1]-line.range[0])*(line.feature.range[1]-line.feature.range[0]);
   expect(line.len).toBeCloseTo(whole*part,12);expect(line.pen).toBe(line.feature.attributes.pen);
   if(part<1-1e-12)parts++;
   shares.set(line.feature,(shares.get(line.feature)??0)+line.len);
  }
  // Some edge is part hidden; visible and hidden, the lines of each edge
  // share out its whole value.
  expect(parts).toBeGreaterThan(0);
  for(const [feature,got] of shares)expect(got).toBeCloseTo(feature.attributes.len,9);
 });
});

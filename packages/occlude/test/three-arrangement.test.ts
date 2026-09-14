import {describe,it,expect} from 'vitest';
import {point} from '../src/three/geometry/exact.js';
import {exactPointKey3} from '../src/three/curves/contact.js';
import {runGeometryJob3,runGeometryJobAsync3} from '../src/three/geometry/job.js';
import {arrangementJob3,exactLineKey3,exactSegmentCrossing3,type ArrangementSegment3} from '../src/three/curves/arrangement.js';

const p=(x:number,y:number,z:number=0)=>point([x,y,z]);
const segment=(a:ReturnType<typeof p>,b:ReturnType<typeof p>,partition='a'):ArrangementSegment3=>({a,b,partition});
const key=(x:number,y:number,z:number=0)=>p(x,y,z).join(',');

describe('exact segment arrangement',()=>{
 it('canonicalizes line keys while keeping distinct partitions separate',()=>{
  const a=p(0,0),b=p(2,0),c=p(1,0),d=p(3,0);
  expect(exactLineKey3(a,b)).toBe(exactLineKey3(d,c));
  const result=runGeometryJob3(arrangementJob3([segment(a,b),segment(c,d,'b')])).value;
  expect(result.atoms).toHaveLength(2);
  expect(result.atoms.every(row=>row.records.length>0)).toBe(true);
  expect(result.atoms.map(row=>row.partition)).toEqual(['a','b']);
 });

 it('partitions overlaps and transverse crossings with exact endpoints',()=>{
  const horizontal=segment(p(0,0),p(3,0)),overlap=segment(p(1,0),p(2,0)),vertical=segment(p(1,-1),p(1,1));
  const result=runGeometryJob3(arrangementJob3([horizontal,overlap,vertical])).value;
  expect(result.atoms.map(row=>[exactPointKey3(row.a),exactPointKey3(row.b),row.records])).toEqual([
   [key(0,0),key(1,0),[0]],
   [key(1,0),key(2,0),[0,1]],
   [key(2,0),key(3,0),[0]],
   [key(1,-1),key(1,0),[2]],
   [key(1,0),key(1,1),[2]],
  ]);
  expect(exactSegmentCrossing3(p(0,0),p(2,0),p(1,-1),p(1,1))).toEqual(p(1,0));
  expect(exactSegmentCrossing3(p(0,0,0),p(1,0,0),p(0,1,1),p(1,1,2))).toBeNull();
 });

 it('keeps tiny exact coordinates distinct and sweeps source membership',()=>{
  const tiny=Number.MIN_VALUE;
  const result=runGeometryJob3(arrangementJob3([
   segment(p(0,0),p(4,0)),segment(p(1,0),p(2,0)),segment(p(2,0),p(3,0)),
   segment(p(0,tiny),p(4,tiny)),
  ],[{point:p(3,0),partition:'a'}])).value;
  expect(result.atoms.filter(row=>row.partition==='a').map(row=>row.records)).toEqual([[0],[0,1],[0,2],[0],[3]]);
  expect(result.atoms.some(row=>row.a[1]!==0n&&row.b[1]!==0n)).toBe(true);
  expect(result.events).toBeGreaterThan(4);
 });

 it('enforces limits and cancellation before publishing partial output',async()=>{
  const input=Array.from({length:20},(_,i)=>segment(p(i,0),p(i+1,0)));
  expect(()=>runGeometryJob3(arrangementJob3(input,[],{maxSegments:1}))).toThrow('input budget');
  expect(()=>runGeometryJob3(arrangementJob3([segment(p(0,0),p(3,0)),segment(p(1,0),p(2,0))],[],{maxAtoms:1}))).toThrow('atom/membership budget');
  const controller=new AbortController();const pending=runGeometryJobAsync3(arrangementJob3(input),controller.signal);
  controller.abort(new Error('cancel arrangement'));await expect(pending).rejects.toThrow('cancel arrangement');
 });
});

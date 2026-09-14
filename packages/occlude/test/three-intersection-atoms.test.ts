import {describe,it,expect} from 'vitest';
import {box,mesh,plane} from 'occlude/3d';
import {surfaceBinding3} from '../src/three/curves/network.js';
import {intersectionContacts3} from '../src/three/curves/intersectionContacts.js';
import {intersectionAtomsJob3,triangleSideOccupancy3} from '../src/three/curves/intersectionAtoms.js';
import {runGeometryJob3,runGeometryJobAsync3} from '../src/three/geometry/job.js';
import {point,type H} from '../src/three/geometry/exact.js';

const atoms=(a:any,b:any,options:any={})=>{
 const contacts=intersectionContacts3(surfaceBinding3(a.surface),surfaceBinding3(b.surface)).value;
 return runGeometryJob3(intersectionAtomsJob3(contacts,options)).value;
};
const atomsFromSurfaces=(a:any,b:any,options:any={})=>runGeometryJob3(intersectionAtomsJob3(
 intersectionContacts3(surfaceBinding3(a),surfaceBinding3(b)).value,options)).value;
const square=(x:number,y:number,w:number,h:number)=>mesh([[x,y,0],[x+w,y,0],[x+w,y+h,0],[x,y+h,0]],[[0,1,2,3]]);
const p=(x:number,y:number,z:number=0)=>point([x,y,z]);
describe('intersection atomic seams',()=>{
 it('emits only the outer boundary for coincident and offset coplanar squares',()=>{
  const same=atoms(square(0,0,2,2),square(0,0,2,2));
  expect(same.segments).toHaveLength(4);expect(same.segments.every(s=>s.contact==='coplanar-boundary')).toBe(true);
  const offset=atoms(square(0,0,2,2),square(1,0,2,2));
  expect(offset.segments).toHaveLength(6);expect(offset.segments.every(s=>s.contact==='coplanar-boundary')).toBe(true);
  const coverage=(rows:readonly {readonly a:H;readonly b:H}[])=>{
   const lines=new Map<string,[number,number][]>();
   for(const row of rows){const a=row.a,b=row.b,vertical=a[0]*b[3]===b[0]*a[3],axis=vertical?'x':'y',value=vertical?Number(a[0])/Number(a[3]):Number(a[1])/Number(a[3]),lo=vertical?Math.min(Number(a[1])/Number(a[3]),Number(b[1])/Number(b[3])):Math.min(Number(a[0])/Number(a[3]),Number(b[0])/Number(b[3])),hi=vertical?Math.max(Number(a[1])/Number(a[3]),Number(b[1])/Number(b[3])):Math.max(Number(a[0])/Number(a[3]),Number(b[0])/Number(b[3]));(lines.get(`${axis}=${value}`)??(lines.set(`${axis}=${value}`,[]),lines.get(`${axis}=${value}`)!)).push([lo,hi]);}
   return [...lines].map(([line,parts])=>[line,parts.sort((a,b)=>a[0]-b[0]).reduce((out,part)=>{const last=out.at(-1);if(last&&part[0]<=last[1])last[1]=Math.max(last[1],part[1]);else out.push([...part]);return out},[] as number[][])]).sort();
  };
  expect(coverage(offset.segments)).toEqual([['x=1',[[0,2]]],['x=2',[[0,2]]],['y=0',[[1,2]]],['y=2',[[1,2]]]]);
 });
 it('retains isolated tangent points and shared-edge seams',()=>{
  const tangent=atoms(box(),box().translate([1,1,1]));
  expect(tangent.segments).toHaveLength(0);expect(tangent.points.length).toBeGreaterThan(0);
  const edge=atoms(box(),box().translate([1,1,0]));
  expect(edge.points).toHaveLength(0);expect(edge.segments.length).toBeGreaterThan(0);expect(edge.segments.every(s=>s.contact==='shared-edge')).toBe(true);
 });
 it('records both source supports on transverse box seams',()=>{
  const result=atoms(box(),box().translate([.3,.4,.2]));
  expect(result.segments.length).toBeGreaterThan(0);
  expect(result.segments.every(s=>s.contact==='transverse'&&s.supports.some(x=>x.source===0)&&s.supports.some(x=>x.source===1))).toBe(true);
  const degree=new Map<string,number>();for(const s of result.segments)for(const p of [s.a,s.b]){const k=p.join(',');degree.set(k,(degree.get(k)??0)+1);}
  expect([...degree.values()].every(n=>n===2)).toBe(true);
 });
 it('preserves geometric coverage under source input order swaps',()=>{
  const a=box(),b=box().translate([.3,.4,.2]);
  const left=atoms(a,b),right=atoms(b,a);
  const geometry=(rows:readonly {readonly a:H;readonly b:H}[])=>rows.map(s=>[s.a.join(','),s.b.join(',')].sort().join('|')).sort();
  expect(geometry(left.segments)).toEqual(geometry(right.segments));
 });
 it('keeps disconnected coincident sheets in distinct partitions',()=>{
  const a=mesh([[0,0,0],[2,0,0],[2,2,0],[0,2,0],[0,0,0],[2,0,0],[2,2,0],[0,2,0]],[[0,1,2,3],[4,5,6,7]]);
  const result=atoms(a,square(0,0,2,2));
  expect(new Set(result.segments.map(s=>s.partition)).size).toBe(2);
  expect(result.segments).toHaveLength(8);
 });
 it('preserves coverage when triangle order is permuted',()=>{
  const a=square(0,0,2,2).surface,b=square(1,0,2,2).surface;
  const permuted={...a,triangles:Object.freeze([...a.triangles].reverse())};
  const first=atomsFromSurfaces(a,b),second=atomsFromSurfaces(permuted,b);
  const geometry=(rows:readonly {readonly a:H;readonly b:H}[])=>rows.map(s=>[s.a.join(','),s.b.join(',')].sort().join('|')).sort();
  expect(geometry(first.segments)).toEqual(geometry(second.segments));
 });
 it('uses exact side occupancy and enforces assembly budgets/cancellation',async()=>{
  const tri=[p(0,0),p(2,0),p(0,2)] as unknown as [H,H,H], n=[0n,0n,1n,0n] as H;
  expect(triangleSideOccupancy3(tri,p(1,0),p(0,0),p(2,0),n)).toEqual([true,false]);
  const contacts=intersectionContacts3(surfaceBinding3(plane(2,2).surface),surfaceBinding3(plane(2,2).surface)).value;
  expect(()=>runGeometryJob3(intersectionAtomsJob3(contacts,{maxSegments:0}))).toThrow('raw segment budget');
  expect(()=>runGeometryJob3(intersectionAtomsJob3(contacts,{maxSupportCandidates:0}))).toThrow('support candidate budget');
  const controller=new AbortController(),pending=runGeometryJobAsync3(intersectionAtomsJob3(contacts),controller.signal);controller.abort(new Error('cancel atoms'));
  await expect(pending).rejects.toThrow('cancel atoms');
 });
});

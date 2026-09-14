import {abs,canonicalPoint,cross,difference,dot3,gcd,orientPoint,pointNumber,sign,type H,type V} from '../geometry/exact.js';
import {WorldIndex3,worldBounds3,type WorldBounds3} from '../geometry/bounds.js';
import {collinearExact3,compareExactPoints3,exactCrossing3,exactPointKey3} from './contact.js';

export interface ArrangementSegment3 {
 readonly a:H;readonly b:H;
 /** Independent source component pairs must never be welded by coordinates. */
 readonly partition:string;
}
export interface ArrangementPoint3 {readonly point:H;readonly partition:string}
export interface ArrangementAtom3 extends ArrangementSegment3 {
 /** All original segments covering this complete open interval. */
 readonly records:readonly number[];
}
export interface ArrangementBudget3 {
 readonly maxSegments?:number;readonly maxPoints?:number;readonly maxCandidates?:number;
 readonly maxEvents?:number;readonly maxAtoms?:number;readonly maxMemberships?:number;
 readonly maxExactBytes?:number;readonly maxCoordinateBits?:number;
}
interface Event {point:H;starts:number[];ends:number[]}
interface Line {partition:string;events:Map<string,Event>}

/** Primitive Pluecker coordinates: direction and moment have the same
 * homogeneous denominator, so one common reduction identifies the line. */
export function exactLineKey3(a:H,b:H):string {
 const d=difference(b,a),m=cross(a.slice(0,3) as unknown as V,b.slice(0,3) as unknown as V),values=[...d,...m];
 const first=d.find(n=>n!==0n);if(first===undefined)throw new Error('arrangement requires nonzero segments');
 const divisor=values.reduce(gcd,0n)*sign(first);
 return values.map(n=>n/divisor).join(',');
}
export function pointOnExactSegment3(p:H,a:H,b:H):boolean {
 return collinearExact3(a,b,p)&&compareExactPoints3(p,a)>=0&&compareExactPoints3(p,b)<=0;
}
/** Noncollinear 3D segments: reject skew lines before the exact planar test.
 * Inputs are canonical finite points; collinear overlaps use the line sweep. */
export function exactSegmentCrossing3(a:H,b:H,c:H,d:H):H|null {
 const normal=cross(difference(b,a),difference(d,c));
 if(normal.every(n=>n===0n)||dot3(normal,difference(c,a))!==0n)return null;
 let drop=0;for(let k=1;k<3;k++)if(abs(normal[k])>abs(normal[drop]))drop=k;
 const da=orientPoint(c,d,a,drop),db=orientPoint(c,d,b,drop),dc=orientPoint(a,b,c,drop),dd=orientPoint(a,b,d,drop);
 if(sign(da)*sign(db)>0n||sign(dc)*sign(dd)>0n)return null;
 if(da===0n)return a;if(db===0n)return b;
 return exactCrossing3(a,b,da,db);
}

/** Split supported linework at overlaps, crossings and isolated contacts.
 * No epsilon, raster snapping or floating-length rejection is involved.
 * Coplanar union occupancy and contact policy are applied to these atoms by
 * the intersection assembler, not inferred from edge multiplicity. */
export function* arrangementJob3(input:readonly ArrangementSegment3[],points:readonly ArrangementPoint3[]=[],options:ArrangementBudget3={}):Generator<void,{
 readonly atoms:readonly ArrangementAtom3[];readonly candidates:number;readonly events:number;readonly memberships:number;
}> {
 const limits={maxSegments:options.maxSegments??250000,maxPoints:options.maxPoints??250000,maxCandidates:options.maxCandidates??1000000,maxEvents:options.maxEvents??1000000,maxAtoms:options.maxAtoms??250000,maxMemberships:options.maxMemberships??1000000,maxExactBytes:options.maxExactBytes??64000000,maxCoordinateBits:options.maxCoordinateBits??32768};
 for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<0)throw new Error('arrangement budgets must be nonnegative integers');
 if(input.length>limits.maxSegments||points.length>limits.maxPoints)throw new Error('arrangement exceeds input budget');
 const segments:ArrangementSegment3[]=[],bounds:WorldBounds3[]=[],lines:Line[]=[],lineIds:number[]=[],lineMap=new Map<string,number>();
 let eventCount=0,exactBytes=0,candidates=0,memberships=0;
 function charge(point:H){
  for(const n of point){if(abs(n).toString(2).length>limits.maxCoordinateBits)throw new Error('arrangement exceeds coordinate bit budget');exactBytes+=n.toString().length*2;}
  if(exactBytes>limits.maxExactBytes)throw new Error('arrangement exceeds exact-coordinate byte budget');
 }
 function event(line:Line,p:H):Event {
  const key=exactPointKey3(p),previous=line.events.get(key);if(previous)return previous;
  if(++eventCount>limits.maxEvents)throw new Error('arrangement exceeds event budget');charge(p);
  const row={point:p,starts:[],ends:[]};line.events.set(key,row);return row;
 }
 for(let i=0;i<input.length;i++){
  const source=input[i],p=canonicalPoint(source.a),q=canonicalPoint(source.b),[a,b]=compareExactPoints3(p,q)<0?[p,q]:[q,p];
  charge(a);charge(b);
  const key=JSON.stringify([source.partition,exactLineKey3(a,b)]);let lineId=lineMap.get(key);
  if(lineId===undefined){lineId=lines.length;lineMap.set(key,lineId);lines.push({partition:source.partition,events:new Map()});}
  const line=lines[lineId];event(line,a).starts.push(i);event(line,b).ends.push(i);
  lineIds.push(lineId);segments.push({a,b,partition:source.partition});bounds.push(worldBounds3([pointNumber(a),pointNumber(b)]));
  if((i&127)===127)yield;
 }
 const index=yield*WorldIndex3.build(bounds);
 function candidate(){if(++candidates>limits.maxCandidates)throw new Error('arrangement exceeds candidate budget');}
 for(let i=0;i<segments.length;i++){
  const a=segments[i];
  for(const j of index.query(bounds[i])){
   if(j<=i)continue;candidate();const b=segments[j];
   if(a.partition===b.partition&&lineIds[i]!==lineIds[j]){
    const p=exactSegmentCrossing3(a.a,a.b,b.a,b.b);
    if(p){event(lines[lineIds[i]],p);event(lines[lineIds[j]],p);}
   }
   if((candidates&127)===0)yield;
  }
  if((i&127)===127)yield;
 }
 for(let i=0;i<points.length;i++){
  const point=canonicalPoint(points[i].point);charge(point);const position=pointNumber(point);
  for(const j of index.query(worldBounds3([position]))){
   candidate();const segment=segments[j];
   if(segment.partition===points[i].partition&&pointOnExactSegment3(point,segment.a,segment.b))event(lines[lineIds[j]],point);
   if((candidates&127)===0)yield;
  }
  if((i&127)===127)yield;
 }
 const atoms:ArrangementAtom3[]=[];
 for(const line of lines){
  const ordered=[...line.events.values()].sort((a,b)=>compareExactPoints3(a.point,b.point)),active=new Set<number>();yield;
  for(let i=0;i<ordered.length;i++){
   const e=ordered[i];
   if(i&&active.size){
    if(atoms.length>=limits.maxAtoms||memberships+active.size>limits.maxMemberships)throw new Error('arrangement exceeds atom/membership budget');
    memberships+=active.size;
    atoms.push(Object.freeze({a:ordered[i-1].point,b:e.point,partition:line.partition,records:Object.freeze([...active].sort((a,b)=>a-b))}));
   }
   for(const record of e.ends)active.delete(record);for(const record of e.starts)active.add(record);
   if((i&127)===127)yield;
  }
 }
 return Object.freeze({atoms:Object.freeze(atoms),candidates,events:eventCount,memberships});
}

import {abs,difference,mixPoint,orientPoint,pointNumber,sign,triangleWeights,type H} from '../geometry/exact.js';
import {worldBounds3,WorldIndex3} from '../geometry/bounds.js';
import {bindingTriangle3} from './network.js';
import {arrangementJob3,type ArrangementBudget3,type ArrangementSegment3,type ArrangementPoint3} from './arrangement.js';
import {exactPointKey3,type ExactTriangle3} from './contact.js';
import type {IntersectionContacts3} from './intersectionContacts.js';

export type IntersectionClass3='transverse'|'shared-edge'|'coplanar-boundary';
export interface IntersectionSupport3 {readonly source:number;readonly triangle:number}
export interface IntersectionAtom3 extends ArrangementSegment3 {
 readonly contact:IntersectionClass3;readonly supports:readonly IntersectionSupport3[];
}
export interface IntersectionPoint3 extends ArrangementPoint3 {readonly supports:readonly IntersectionSupport3[]}
export interface IntersectionAtomBudget3 extends ArrangementBudget3 {readonly maxSupportCandidates?:number;readonly maxSupports?:number}

/** Membership at p +/- an infinitesimal projected left normal to the line.
 * Exact signs and first derivatives replace any finite offset tolerance. */
export function triangleSideOccupancy3(triangle:ExactTriangle3,p:H,a:H,b:H,normal:H):readonly [boolean,boolean] {
 let drop=0;for(let k=1;k<3;k++)if(abs(normal[k])>abs(normal[drop]))drop=k;
 const [x,y]=[0,1,2].filter(k=>k!==drop),orientation=sign(orientPoint(...triangle,drop)),direction=difference(b,a);
 let left=true,right=true;
 for(let i=0;i<3;i++){
  const u=triangle[i],v=triangle[(i+1)%3],side=orientPoint(u,v,p,drop)*orientation;
  if(side<0n)return [false,false];
  if(side===0n){
   const edge=difference(v,u),derivative=(edge[x]*direction[x]+edge[y]*direction[y])*orientation;
   if(derivative<0n)left=false;if(derivative>0n)right=false;
  }
 }
 return [left,right];
}
const edgeKey=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;

/** Resolve triangle contacts into supported atomic seams. Area overlaps use
 * union occupancy per source, so repeated/overlapping patches do not produce
 * seams along triangulation diagonals or depend on polygon edge multiplicity. */
export function* intersectionAtomsJob3(input:IntersectionContacts3,options:IntersectionAtomBudget3={}):Generator<void,{
 readonly segments:readonly IntersectionAtom3[];readonly points:readonly IntersectionPoint3[];
 readonly stats:{readonly arrangementCandidates:number;readonly supportCandidates:number;readonly supports:number;readonly atoms:number;readonly discardedInterior:number};
}> {
 const maxSupportCandidates=options.maxSupportCandidates??1000000,maxSupports=options.maxSupports??1000000,maxSegments=options.maxSegments??250000,maxPoints=options.maxPoints??250000;
 if([maxSupportCandidates,maxSupports,maxSegments,maxPoints].some(n=>!Number.isSafeInteger(n)||n<0))throw new Error('intersection assembly budgets must be nonnegative integers');
 const raw:ArrangementSegment3[]=[],records:number[]=[],points:ArrangementPoint3[]=[],pointRecords:number[]=[],areaRecords:number[]=[],partitions:string[]=[];
 let supportCandidates=0,supportCount=0,discardedInterior=0;
 const candidate=()=>{if(++supportCandidates>maxSupportCandidates)throw new Error('intersection assembly exceeds support candidate budget');};
 const chargeSupports=(count:number)=>{supportCount+=count;if(supportCount>maxSupports)throw new Error('intersection assembly exceeds support budget');};
 for(let i=0;i<input.contacts.length;i++){
  const row=input.contacts[i],partition=JSON.stringify([input.sources[0].topology.components[row.a],input.sources[1].topology.components[row.b]]),contact=row.contact;partitions.push(partition);
  if(contact.kind==='point'){
   if(points.length>=maxPoints)throw new Error('intersection assembly exceeds point budget');
   points.push({point:contact.points[0],partition});pointRecords.push(i);
  }else{
   const count=contact.kind==='area'?contact.points.length:1;
   if(raw.length+count>maxSegments)throw new Error('intersection assembly exceeds raw segment budget');
   for(let j=0;j<count;j++){raw.push({a:contact.points[j],b:contact.points[(j+1)%contact.points.length],partition});records.push(i);}
   if(contact.kind==='area')areaRecords.push(i);
  }
  if((i&127)===127)yield;
 }
 const arranged=yield*arrangementJob3(raw,points,options),segments:IntersectionAtom3[]=[],usedPoints=new Set<string>();
 const authorEdges: Set<string>[]=[];
 for(const source of input.sources){
  const edges=new Set<string>();for(let i=0;i<source.binding.source.edges.length;i++){
   const edge=source.binding.source.edges[i];edges.add(edgeKey(...edge.vertices));if((i&1023)===1023)yield;
  }authorEdges.push(edges);
 }
 const pointKey=(partition:string,p:H)=>JSON.stringify([partition,exactPointKey3(p)]);
 for(let atomIndex=0;atomIndex<arranged.atoms.length;atomIndex++){
  const atom=arranged.atoms[atomIndex],midpoint=mixPoint(atom.a,atom.b,[1n,2n]),bounds=worldBounds3([pointNumber(midpoint)]),components=JSON.parse(atom.partition) as [number,number];
  const contacts=[...new Set(atom.records.map(i=>records[i]))],planes=new Map<string,H>();let transverse=false;
  for(const i of contacts){const row=input.contacts[i];if(row.contact.coplanar){const plane=input.sources[0].planes[row.a];planes.set(plane.join(','),plane);}else transverse=true;}
  const occupancy=[new Map<string,[boolean,boolean]>(),new Map<string,[boolean,boolean]>()],supports:IntersectionSupport3[]=[],onAuthorEdge=[false,false];
  for(let s=0;s<2;s++){
   const source=input.sources[s];
   for(const triangleIndex of source.index.query(bounds)){
    candidate();
    if(source.topology.components[triangleIndex]===components[s]){
     const triangle=bindingTriangle3(source.binding,triangleIndex),planeKey=source.planes[triangleIndex].join(','),plane=planes.get(planeKey);
     if(plane){
      const sides=triangleSideOccupancy3(triangle,midpoint,atom.a,atom.b,plane),previous=occupancy[s].get(planeKey)??[false,false];
      occupancy[s].set(planeKey,[previous[0]||sides[0],previous[1]||sides[1]]);
     }
     const wa=triangleWeights(triangle,atom.a),wb=wa&&triangleWeights(triangle,atom.b);
     if(wa&&wb){
      chargeSupports(1);supports.push(Object.freeze({source:s,triangle:triangleIndex}));
      const vertices=source.binding.source.triangles[triangleIndex].vertices;
      for(let k=0;k<3;k++)if(wa[k]===0n&&wb[k]===0n&&authorEdges[s].has(edgeKey(vertices[(k+1)%3],vertices[(k+2)%3])))onAuthorEdge[s]=true;
     }
    }
    if((supportCandidates&127)===0)yield;
   }
  }
  let boundary=false,shared=false;
  for(const key of planes.keys()){
   const a=occupancy[0].get(key)??[false,false],b=occupancy[1].get(key)??[false,false],left=a[0]&&b[0],right=a[1]&&b[1];
   if(left!==right)boundary=true;else if(!left)shared=true;
  }
  if(boundary||transverse||shared){
   const contact:IntersectionClass3=boundary?'coplanar-boundary':shared||onAuthorEdge.every(Boolean)?'shared-edge':'transverse';
   segments.push(Object.freeze({a:atom.a,b:atom.b,partition:atom.partition,contact,supports:Object.freeze(supports)}));
   usedPoints.add(pointKey(atom.partition,atom.a));usedPoints.add(pointKey(atom.partition,atom.b));
  }else discardedInterior++;
  if((atomIndex&127)===127)yield;
 }
 const areaBounds=[];
 for(let i=0;i<areaRecords.length;i++){areaBounds.push(worldBounds3(input.contacts[areaRecords[i]].contact.points.map(pointNumber)));if((i&127)===127)yield;}
 const areas=yield*WorldIndex3.build(areaBounds),isolated=new Map<string,{point:H;partition:string;supports:Map<string,IntersectionSupport3>}>();
 for(let i=0;i<points.length;i++){
  const row=points[i],key=pointKey(row.partition,row.point);
  if(!usedPoints.has(key)){
   let covered=false;
   for(const areaIndex of areas.query(worldBounds3([pointNumber(row.point)]))){
    candidate();const record=areaRecords[areaIndex],contact=input.contacts[record];
    if(partitions[record]===row.partition&&triangleWeights(bindingTriangle3(input.sources[0].binding,contact.a),row.point)&&triangleWeights(bindingTriangle3(input.sources[1].binding,contact.b),row.point)){covered=true;break;}
    if((supportCandidates&127)===0)yield;
   }
   if(!covered){
    let value=isolated.get(key);if(!value){value={...row,supports:new Map()};isolated.set(key,value);}
    const contact=input.contacts[pointRecords[i]];
    for(let s=0;s<2;s++){const triangle=s===0?contact.a:contact.b,supportKey=`${s}:${triangle}`;if(!value.supports.has(supportKey)){chargeSupports(1);value.supports.set(supportKey,Object.freeze({source:s,triangle}));}}
   }
  }
  if((i&127)===127)yield;
 }
 const isolatedPoints:IntersectionPoint3[]=[];
 for(const row of isolated.values()){isolatedPoints.push(Object.freeze({...row,supports:Object.freeze([...row.supports.values()])}));if((isolatedPoints.length&127)===0)yield;}
 return Object.freeze({segments:Object.freeze(segments),points:Object.freeze(isolatedPoints),stats:Object.freeze({arrangementCandidates:arranged.candidates,supportCandidates,supports:supportCount,atoms:arranged.atoms.length,discardedInterior})});
}

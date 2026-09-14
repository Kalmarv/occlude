import {identity} from '../api/identity.js';
import {collinearExact3,compareExactPoints3,exactPointKey3} from './contact.js';
import type {SurfaceBinding3,SurfaceCurveBudget3,SurfaceCurveNetworkInput3} from './network.js';
import type {IntersectionAtom3,IntersectionPoint3} from './intersectionAtoms.js';
import type {H} from '../geometry/exact.js';

interface Node {id:string;point:H;partition:string;edges:number[]}
/** Assemble complete source chains from exact incidence. Degree-three branches
 * stop chains, degree-two support splits do not; closed loops repeat their
 * starting node topologically. IDs use a collinearity-reduced chain skeleton
 * so adding triangle support splits does not reseed an otherwise equal seam. */
export function* intersectionGraphInputJob3(sources:readonly [SurfaceBinding3,SurfaceBinding3],segments:readonly IntersectionAtom3[],points:readonly IntersectionPoint3[],budget:Pick<SurfaceCurveBudget3,'maxNodes'|'maxSegments'>={}):Generator<void,SurfaceCurveNetworkInput3> {
 const maxNodes=budget.maxNodes??Infinity,maxSegments=budget.maxSegments??Infinity;
 if([maxNodes,maxSegments].some(n=>!(n===Infinity||Number.isSafeInteger(n))||n<0))throw new Error('curve budgets must be nonnegative integers');
 if(segments.length>maxSegments)throw new Error('surface curve graph exceeds node/segment budget');
 const nodes:Node[]=[],nodeIndices=new Map<string,number>(),ids=new Set<string>();
 const unique=(id:string)=>{if(ids.has(id))throw new Error('intersection geometry identity collision');ids.add(id);return id;};
 function node(point:H,partition:string):number {
  const key=JSON.stringify([partition,exactPointKey3(point)]),previous=nodeIndices.get(key);if(previous!==undefined)return previous;
  if(nodes.length>=maxNodes)throw new Error('surface curve graph exceeds node/segment budget');
  const index=nodes.length;nodes.push({id:unique(identity('intersection-point',key)),point,partition,edges:[]});nodeIndices.set(key,index);return index;
 }
 const edgeEnds: [number,number][]=[];
 for(let i=0;i<segments.length;i++){
  const s=segments[i],a=node(s.a,s.partition),b=node(s.b,s.partition);edgeEnds.push([a,b]);nodes[a].edges.push(i);nodes[b].edges.push(i);
  if((i&127)===127)yield;
 }
 const compareNodes=(a:number,b:number)=>compareExactPoints3(nodes[a].point,nodes[b].point)||(nodes[a].partition<nodes[b].partition?-1:nodes[a].partition>nodes[b].partition?1:0);
 const other=(edge:number,vertex:number)=>edgeEnds[edge][0]===vertex?edgeEnds[edge][1]:edgeEnds[edge][0];
 for(let i=0;i<nodes.length;i++){nodes[i].edges.sort((a,b)=>compareNodes(other(a,i),other(b,i)));if((i&127)===127)yield;}
 const ordered=nodes.map((_,i)=>i).sort(compareNodes),visited=new Set<number>(),output:SurfaceCurveNetworkInput3['segments'][number][]=[];yield;
 function* walk(start:number,first:number):Generator<void,void>{
  const path=[start],edges:number[]=[];let vertex=start,edge=first;
  while(!visited.has(edge)){
   visited.add(edge);edges.push(edge);vertex=other(edge,vertex);path.push(vertex);
   if(vertex===start||nodes[vertex].edges.length!==2)break;
   edge=nodes[vertex].edges.find(e=>e!==edge)!;
   if((edges.length&127)===0)yield;
  }
  const closed=path.at(-1)===start,skeleton:number[]=[],count=closed?path.length-1:path.length;
  for(let i=0;i<count;i++){
   if(!closed&&(i===0||i===count-1)||!collinearExact3(nodes[path[(i+count-1)%count]].point,nodes[path[i]].point,nodes[path[(i+1)%count]].point))skeleton.push(path[i]);
   if((i&127)===127)yield;
  }
  // Bound each hashing slice instead of serializing a whole large chain.
  let digest=identity('intersection-chain',nodes[start].partition,closed);
  for(let i=0;i<skeleton.length;i++){digest=identity('intersection-chain',digest,exactPointKey3(nodes[skeleton[i]].point));if((i&127)===127)yield;}
  const chainId=unique(digest);
  for(let i=0;i<edges.length;i++){
   const source=segments[edges[i]],a=nodes[path[i]].id,b=nodes[path[i+1]].id;
   output.push({id:unique(identity('intersection-edge',a,b)),kind:'intersection',a,b,supports:source.supports,chainId,
    // This is an ordered construction parameter, not approximate arc length.
    // Exact endpoints and support weights remain the geometric authority.
    range:[i/edges.length,(i+1)/edges.length],attributes:{contact:source.contact}});
   if((i&127)===127)yield;
  }
 }
 for(let i=0;i<ordered.length;i++){
  const index=ordered[i];if(nodes[index].edges.length!==2)for(const edge of nodes[index].edges)if(!visited.has(edge))yield*walk(index,edge);
  if((i&127)===127)yield;
 }
 for(let i=0;i<ordered.length;i++){
  const index=ordered[i];for(const edge of nodes[index].edges)if(!visited.has(edge))yield*walk(index,edge);
  if((i&127)===127)yield;
 }
 const outputNodes:SurfaceCurveNetworkInput3['nodes'][number][]=[];
 for(let i=0;i<nodes.length;i++){outputNodes.push({id:nodes[i].id,point:nodes[i].point});if((i&127)===127)yield;}
 for(let i=0;i<points.length;i++){
  const p=points[i],index=node(p.point,p.partition);
  if(index<outputNodes.length)throw new Error('isolated intersection contact duplicates a seam node');
  outputNodes.push({id:nodes[index].id,point:p.point,supports:p.supports,attributes:{contact:'tangent-point'}});
  if((i&127)===127)yield;
 }
 return {sources:sources.map((binding,i)=>({id:i===0?'a':'b',binding})),nodes:outputNodes,segments:output};
}

import {mesh3,type Mesh3} from '../geometry/mesh3.js';
import {Material} from '../../material.js';
export interface CurvePath {readonly points:readonly number[];readonly edges:readonly number[];readonly closed:boolean}
/** Order a single unbranched component, preserving its first edge's direction.
 * Shared by operations consuming a path rather than an arbitrary edge graph. */
export function curvePath(curve:Material):CurvePath {
  if(!(curve instanceof Material))throw new Error('construction requires curve geometry');
  return meshPath(mesh3(curve));
}
/** `curvePath` of a value read: its edges walked as one path. */
export function meshPath(mesh:Mesh3):CurvePath {
  const {x,y,z}=mesh,list=mesh.edges;
  const ends=(i:number):readonly [number,number]=>[list[2*i],list[2*i+1]];
  // A zero-length edge is no step along the path: drop it and order what is
  // left. Nothing left is an empty path, and every construction over it is an
  // empty mesh rather than a failed sketch.
  const kept:number[]=[];
  for(let i=0;i<mesh.edgeCount;i++){const [a,b]=ends(i);if(Math.hypot(x[a]-x[b],y[a]-y[b],z[a]-z[b])!==0)kept.push(i);}
  if(!kept.length)return {points:[],edges:[],closed:false};
  const first=kept[0],adjacency=Array.from({length:mesh.n},()=>[] as number[]);
  for(const i of kept){const [a,b]=ends(i);adjacency[a].push(i);adjacency[b].push(i);}
  if(adjacency.some(row=>row.length>2))throw new Error('construction requires an unbranched curve path');
  const tips=adjacency.flatMap((row,i)=>row.length===1?[i]:[]),closed=tips.length===0;
  if(!closed&&tips.length!==2)throw new Error('construction requires one connected curve path');
  const ordered:number[]=[],orderedEdges:number[]=[],used=new Set<number>();
  let current=closed?ends(first)[0]:tips[0];
  for(;;){
    ordered.push(current);
    const edge=adjacency[current].find(i=>!used.has(i));
    if(edge===undefined)break;
    used.add(edge);orderedEdges.push(edge);
    const [a,b]=ends(edge);current=a===current?b:a;
    if(closed&&current===ordered[0])break;
  }
  if(used.size!==kept.length)throw new Error('construction requires one connected curve path');
  if(!closed){
    const at=orderedEdges.indexOf(first);
    if(ordered[at]!==ends(first)[0]){ordered.reverse();orderedEdges.reverse();}
  }
  return {points:ordered,edges:orderedEdges,closed};
}
export interface ConstructionBudget {readonly maxPoints?:number;readonly maxFaces?:number;readonly maxCapPoints?:number}
export function constructionBudget(points:number,faces:number,options:ConstructionBudget):void {
  for(const [name,count,limit] of [['points',points,options.maxPoints??Infinity],['faces',faces,options.maxFaces??Infinity]] as const){
    if(!(limit===Infinity||Number.isSafeInteger(limit))||limit<1)throw new Error(`construction ${name} budget must be a positive integer or Infinity`);
    if(!Number.isSafeInteger(count)||count>limit)throw new Error(`construction exceeds ${name} budget`);
  }
}

/** Ear clipping a general cap is quadratic; bound its contour separately. */
export function constructionCapBudget(count:number,options:ConstructionBudget):void {
  const limit=options.maxCapPoints??2048;
  if(!Number.isSafeInteger(limit)||limit<3)throw new Error('construction cap point budget must be an integer >= 3');
  if(count>limit)throw new Error('construction exceeds cap point budget');
}

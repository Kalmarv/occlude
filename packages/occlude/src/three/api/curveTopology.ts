import {CurveGeometry,type EdgeAttributes} from './mesh.js';
import type {Attributes3} from '../geometry/surface.js';
import {sub3} from '../math.js';
export interface CurvePath {readonly points:readonly number[];readonly edges:readonly number[];readonly closed:boolean}
/** Order a single unbranched component, preserving its first edge's direction.
 * Shared by operations consuming a path rather than an arbitrary edge graph. */
export function curvePath<P extends Attributes3,E extends EdgeAttributes>(curve:CurveGeometry<P,E>):CurvePath {
  if(!(curve instanceof CurveGeometry))throw new Error('construction requires curve geometry');
  const {points,edges}=curve.surface;
  if(!edges.length)throw new Error('construction requires a nonempty curve path');
  const adjacency=points.map(()=>[] as number[]);
  edges.forEach((edge,i)=>{
    const [a,b]=edge.vertices;
    if(Math.hypot(...sub3(points[a].position,points[b].position))===0)throw new Error('construction path has a zero-length edge');
    adjacency[a].push(i);adjacency[b].push(i);
  });
  if(adjacency.some(row=>row.length>2))throw new Error('construction requires an unbranched curve path');
  const ends=adjacency.flatMap((row,i)=>row.length===1?[i]:[]),closed=ends.length===0;
  if(!closed&&ends.length!==2)throw new Error('construction requires one connected curve path');
  const ordered:number[]=[],orderedEdges:number[]=[],used=new Set<number>();
  let current=closed?edges[0].vertices[0]:ends[0];
  for(;;){
    ordered.push(current);
    const edge=adjacency[current].find(i=>!used.has(i));
    if(edge===undefined)break;
    used.add(edge);orderedEdges.push(edge);
    const [a,b]=edges[edge].vertices;current=a===current?b:a;
    if(closed&&current===ordered[0])break;
  }
  if(used.size!==edges.length)throw new Error('construction requires one connected curve path');
  if(!closed){
    const first=orderedEdges.indexOf(0);
    if(ordered[first]!==edges[0].vertices[0]){ordered.reverse();orderedEdges.reverse();}
  }
  return {points:ordered,edges:orderedEdges,closed};
}
export interface ConstructionBudget {readonly maxPoints?:number;readonly maxFaces?:number;readonly maxCapPoints?:number}
export function constructionBudget(points:number,faces:number,options:ConstructionBudget):void {
  for(const [name,count,limit] of [['points',points,options.maxPoints??500_000],['faces',faces,options.maxFaces??250_000]] as const){
    if(!Number.isSafeInteger(limit)||limit<1)throw new Error(`construction ${name} budget must be a positive integer`);
    if(!Number.isSafeInteger(count)||count>limit)throw new Error(`construction exceeds ${name} budget`);
  }
}

/** Ear clipping a general cap is quadratic; bound its contour separately. */
export function constructionCapBudget(count:number,options:ConstructionBudget):void {
  const limit=options.maxCapPoints??2048;
  if(!Number.isSafeInteger(limit)||limit<3)throw new Error('construction cap point budget must be an integer >= 3');
  if(count>limit)throw new Error('construction exceeds cap point budget');
}

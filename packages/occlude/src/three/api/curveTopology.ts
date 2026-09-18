import {CurveGeometry,type EdgeAttributes} from './mesh.js';
import type {Attributes3} from '../geometry/surface.js';
import {sub3} from '../math.js';
export interface CurvePath {readonly points:readonly number[];readonly edges:readonly number[];readonly closed:boolean}
/** Order a single unbranched component, preserving its first edge's direction.
 * Shared by operations consuming a path rather than an arbitrary edge graph. */
export function curvePath<P extends Attributes3,E extends EdgeAttributes>(curve:CurveGeometry<P,E>):CurvePath {
  if(!(curve instanceof CurveGeometry))throw new Error('construction requires curve geometry');
  const {points,edges}=curve.surface;
  // A zero-length edge is no step along the path: drop it and order what is
  // left. Nothing left is an empty path, and every construction over it is an
  // empty mesh rather than a failed sketch.
  const kept=edges.flatMap((edge,i)=>Math.hypot(...sub3(points[edge.vertices[0]].position,points[edge.vertices[1]].position))===0?[]:[i]);
  if(!kept.length)return {points:[],edges:[],closed:false};
  const first=kept[0],adjacency=points.map(()=>[] as number[]);
  for(const i of kept){const [a,b]=edges[i].vertices;adjacency[a].push(i);adjacency[b].push(i);}
  if(adjacency.some(row=>row.length>2))throw new Error('construction requires an unbranched curve path');
  const ends=adjacency.flatMap((row,i)=>row.length===1?[i]:[]),closed=ends.length===0;
  if(!closed&&ends.length!==2)throw new Error('construction requires one connected curve path');
  const ordered:number[]=[],orderedEdges:number[]=[],used=new Set<number>();
  let current=closed?edges[first].vertices[0]:ends[0];
  for(;;){
    ordered.push(current);
    const edge=adjacency[current].find(i=>!used.has(i));
    if(edge===undefined)break;
    used.add(edge);orderedEdges.push(edge);
    const [a,b]=edges[edge].vertices;current=a===current?b:a;
    if(closed&&current===ordered[0])break;
  }
  if(used.size!==kept.length)throw new Error('construction requires one connected curve path');
  if(!closed){
    const at=orderedEdges.indexOf(first);
    if(ordered[at]!==edges[first].vertices[0]){ordered.reverse();orderedEdges.reverse();}
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

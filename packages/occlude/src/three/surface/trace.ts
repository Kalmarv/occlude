import type {Surface3} from '../geometry/surface.js';
import {surfaceLocation3,type SurfaceLocation3,type SurfacePlacement3} from '../geometry/location.js';
import {triangulation3,type SurfaceTriangulation3} from '../geometry/triangulation.js';
import {bindingPosition3,type SurfaceBinding3} from '../curves/network.js';
import {add3,sub3,mul3,dot3,cross3,type Vec3} from '../math.js';
import type {DirectionField} from './fields.js';

/**
 * Generic surface tracer. A trace walks across the represented triangles of
 * one bound surface: inside a triangle the path is straight, at an edge it
 * crosses to the actual adjacent triangle (never a nearest-point search), and
 * the direction is transported across the fold before the field is read again
 * with that direction as `previous`. Every emitted node is a triangle plus
 * barycentric weights, so its exact point is incident to its support.
 */
export interface TraceOptions3 {
  /** Longest straight advance between field reads, model/world units. */
  readonly step:number;
  readonly maxLength:number;
  readonly maxSteps:number;
  /** Stop when crossing an edge sharper than this fold angle; 180 never stops. */
  readonly creaseDegrees:number;
  /** Detect a return to the start within this distance and close the trace. */
  readonly loopDistance:number;
  readonly uvAttribute?:string;readonly chartAttribute?:string;
}
export type TraceStop3='maxLength'|'maxSteps'|'boundary'|'crease'|'degenerate'|'field'|'occupied'|'loop'|'budget'|'start';
/** `degenerate` covers no tangent direction, a degenerate triangle and a
 * trace that has converged onto a vertex. */
export interface TraceNode3 {
  readonly triangle:number;readonly weights:Vec3;
  readonly position:Vec3;readonly normal:Vec3;
  /** Arclength from the trace start, world units. */
  readonly distance:number;
  /** A crossing node's coordinates on the triangle it left (the segment
   * before it lies there), so a consumer has both representations. */
  readonly left?:{readonly triangle:number;readonly weights:Vec3};
}
export interface Trace3 {
  readonly nodes:readonly TraceNode3[];
  /** Triangle in which segment i (nodes[i] to nodes[i+1]) was traced. A
   * crossing node is expressed on the triangle it enters, but its exact point
   * lies on the shared edge, so it is incident to both. */
  readonly supports:readonly number[];
  readonly stop:TraceStop3;
  /** The last node is the start node again: the loop closes exactly. */
  readonly closed:boolean;
  readonly length:number;readonly steps:number;
}
export interface TraceEnvironment3 {
  readonly surface:Surface3;readonly binding:SurfaceBinding3;readonly placement?:SurfacePlacement3;
  readonly topology:SurfaceTriangulation3;
  readonly world:readonly Vec3[];readonly normals:readonly Vec3[];
}
export interface TraceHooks3 {
  /** Called at every emitted node after the first; true stops the trace. */
  readonly occupied?:(node:TraceNode3)=>boolean;
  /** Shared step budget across many traces; false stops with 'budget'. */
  readonly budget?:()=>boolean;
  /** The direction field never reads its location (a transported walk):
   * skip building surface locations, which dominate a walk's cost. */
  readonly blind?:boolean;
}
export function traceEnvironment3(surface:Surface3,binding:SurfaceBinding3):TraceEnvironment3 {
  const topology=triangulation3(surface),world=surface.points.map((_,i)=>bindingPosition3(binding,i));
  const normals=surface.triangles.map(t=>{const [a,b,c]=t.vertices.map(v=>world[v]);const n=cross3(sub3(b,a),sub3(c,a)),l=Math.hypot(...n);return l>0?mul3(n,1/l):[0,0,0] as Vec3;});
  return {surface,binding,placement:binding.placement,topology,world,normals};
}
const unit=(v:Vec3):Vec3|null=>{const l=Math.hypot(...v);return l>0&&Number.isFinite(l)?mul3(v,1/l):null;};
function position(env:TraceEnvironment3,triangle:number,w:Vec3):Vec3 {
  const [a,b,c]=env.surface.triangles[triangle].vertices.map(v=>env.world[v]);
  return [0,1,2].map(k=>a[k]*w[0]+b[k]*w[1]+c[k]*w[2]) as unknown as Vec3;
}
function normalize(w:Vec3):Vec3 {
  const clamped=w.map(n=>n<0?0:n) as unknown as Vec3,sum=clamped[0]+clamped[1]+clamped[2];
  if(!(sum>0))throw new Error('trace lost its barycentric attachment');
  return mul3(clamped,1/sum);
}
const locationOptions=new WeakMap<TraceEnvironment3,Map<string,{placement?:SurfacePlacement3;uvAttribute?:string;chartAttribute?:string}>>();
/** One shared options object per environment and column pair, so locations
 * retain a shared frozen copy instead of cloning options per step. */
function locationOptionsFor(env:TraceEnvironment3,options:Pick<TraceOptions3,'uvAttribute'|'chartAttribute'>){
  let table=locationOptions.get(env);if(!table){table=new Map();locationOptions.set(env,table);}
  const key=`${options.uvAttribute??''}\u0000${options.chartAttribute??''}`;let value=table.get(key);
  if(!value){value={placement:env.placement,uvAttribute:options.uvAttribute,chartAttribute:options.chartAttribute};table.set(key,value);}
  return value;
}
export function traceLocation3(env:TraceEnvironment3,triangle:number,weights:Vec3,options:Pick<TraceOptions3,'uvAttribute'|'chartAttribute'>):SurfaceLocation3 {
  return surfaceLocation3(env.surface,triangle,weights,locationOptionsFor(env,options));
}
const noLocation=Object.freeze({}) as unknown as SurfaceLocation3;
/** One directional walk. The first node is the start; `direction` is read at
 * every node. Returns at least the start node; a trace of one node has no
 * segment. `startDirection` seeds the sign for unoriented fields. */
export function traceSurface3(env:TraceEnvironment3,start:{triangle:number;weights:Vec3},direction:DirectionField,options:TraceOptions3,hooks:TraceHooks3={},startDirection?:Vec3):Trace3 {
  const {step,maxLength,maxSteps}=options;
  if(!(maxSteps===Infinity||Number.isSafeInteger(maxSteps))||maxSteps<0)throw new Error('trace requires positive step and length and a nonnegative step budget');
  // No step and no length are no walk: the trace is its start node alone.
  const walks=step>0&&Number.isFinite(step)&&maxLength>0;
  const cosCrease=Math.cos(Math.min(180,Math.max(0,options.creaseDegrees))*Math.PI/180);
  let triangle=start.triangle,weights=normalize(start.weights),previous=startDirection;
  const nodes:TraceNode3[]=[{triangle,weights,position:position(env,triangle,weights),normal:env.normals[triangle],distance:0}];
  const supports:number[]=[];
  let length=0,steps=0,stop:TraceStop3=walks?'maxSteps':'degenerate',closed=false,stalled=0;
  const startPosition=nodes[0].position;
  while(walks){
    if(steps>=maxSteps){stop='maxSteps';break;}
    if(hooks.budget&&!hooks.budget()){stop='budget';break;}
    const n=env.normals[triangle];if(!n.some(v=>v!==0)){stop='degenerate';break;}
    const location=hooks.blind?noLocation:traceLocation3(env,triangle,weights,options);
    const wanted=direction(location,previous);
    if(!wanted){stop='field';break;}
    // A vector the field could not answer is no direction at all.
    if(wanted.length!==3||!wanted.every(Number.isFinite)){stop='field';break;}
    const inPlane=unit(sub3(wanted,mul3(n,dot3(wanted,n))));
    if(!inPlane){stop='degenerate';break;}
    const u=inPlane;
    const [a,b,c]=env.surface.triangles[triangle].vertices.map(v=>env.world[v]),e1=sub3(b,a),e2=sub3(c,a);
    const g11=dot3(e1,e1),g12=dot3(e1,e2),g22=dot3(e2,e2),det=g11*g22-g12*g12;
    if(!(det>0)){stop='degenerate';break;}
    const r1=dot3(u,e1),r2=dot3(u,e2),alpha=(r1*g22-r2*g12)/det,beta=(r2*g11-r1*g12)/det;
    const db:Vec3=[-(alpha+beta),alpha,beta];
    let exit=-1,tExit=Infinity;
    for(let i=0;i<3;i++)if(db[i]<0){const t=-weights[i]/db[i];if(t<tExit){tExit=t;exit=i;}}
    const remaining=maxLength-length;
    const advance=Math.min(step,tExit,remaining);
    if(!(advance>=0)){stop='degenerate';break;}
    // A direction pointing into a vertex (a pole, a sink of a gradient field)
    // makes consecutive zero-length exits across the fan: the trace has
    // converged and stops instead of spending its step budget in place.
    if(advance<=step*1e-12){if(++stalled>=3){stop='degenerate';break;}}else stalled=0;
    let next=add3(weights,mul3(db,advance)) as Vec3;
    const crossing=advance===tExit&&advance<step&&advance<remaining||advance===tExit&&tExit<=step&&tExit<=remaining;
    if(crossing){const w=[...next];w[exit]=0;next=normalize(w as unknown as Vec3);}else next=normalize(next);
    length+=advance;steps++;
    const node:TraceNode3={triangle,weights:next,position:position(env,triangle,next),normal:n,distance:length};
    const from=nodes[nodes.length-1].position;
    nodes.push(node);supports.push(triangle);previous=u;
    // Returning to the start: the closest approach of this segment to the
    // start position within loopDistance closes the loop. Inside the start
    // triangle the trace snaps onto its first node exactly.
    if(steps>2&&length>2*options.loopDistance&&options.loopDistance>0){
      const seg=sub3(node.position,from),ss=dot3(seg,seg),t=ss>0?Math.min(1,Math.max(0,dot3(sub3(startPosition,from),seg)/ss)):0;
      const closest=add3(from,mul3(seg,t));
      if(Math.hypot(...sub3(closest,startPosition))<=options.loopDistance){
        if(triangle===start.triangle){
          length-=advance*(1-t);
          nodes[nodes.length-1]={...nodes[0],distance:length};closed=true;
        }
        stop='loop';break;
      }
    }
    if(hooks.occupied?.(node)){stop='occupied';break;}
    if(length>=maxLength){stop='maxLength';break;}
    if(crossing){
      const edge=(exit+1)%3,neighbor=env.topology.neighbors[triangle][edge];
      if(neighbor<0){stop='boundary';break;}
      const nn=env.normals[neighbor];
      if(dot3(n,nn)<cosCrease){stop='crease';break;}
      const vertices=env.surface.triangles[triangle].vertices,va=vertices[(exit+1)%3],vb=vertices[(exit+2)%3];
      const along=unit(sub3(env.world[vb],env.world[va]));if(!along){stop='degenerate';break;}
      const tangential=dot3(u,along),perpendicular=sub3(u,mul3(along,tangential)),magnitude=Math.hypot(...perpendicular);
      const neighborVertices=env.surface.triangles[neighbor].vertices,ia=neighborVertices.indexOf(va),ib=neighborVertices.indexOf(vb);
      if(ia<0||ib<0){stop='degenerate';break;}
      const opposite=env.world[neighborVertices[3-ia-ib]],mid=mul3(add3(env.world[va],env.world[vb]),.5);
      let inward=cross3(nn,along);if(dot3(inward,sub3(opposite,mid))<0)inward=mul3(inward,-1);
      const transported=unit(add3(mul3(along,tangential),mul3(inward,magnitude)));
      if(!transported){stop='degenerate';break;}
      const w=[0,0,0];w[ia]=next[(exit+1)%3];w[ib]=next[(exit+2)%3];
      triangle=neighbor;weights=normalize(w as unknown as Vec3);previous=transported;
      // Re-express the crossing node on the neighbour so the next segment's
      // support is the triangle it actually lies in.
      nodes[nodes.length-1]={...node,triangle,weights,left:{triangle:node.triangle,weights:node.weights}};
    }else weights=next;
  }
  return {nodes,supports,stop,closed,length,steps};
}
/** Trace both ways from a seed and join the halves. An unoriented field gets
 * the seed's own direction as its sign on both sides. A forward loop skips the
 * backward half. */
export function traceBoth3(env:TraceEnvironment3,start:{triangle:number;weights:Vec3},direction:DirectionField,options:TraceOptions3,hooks:TraceHooks3={}):Trace3 {
  const forward=traceSurface3(env,start,direction,options,hooks);
  if(forward.closed||forward.stop==='budget')return forward;
  const seedDirection=forward.nodes.length>1?unit(sub3(forward.nodes[1].position,forward.nodes[0].position)):undefined;
  const backward=traceSurface3(env,start,(s,previous)=>{const d=direction(s,previous&&mul3(previous,-1));return d&&mul3(d,-1);},options,hooks,seedDirection?mul3(seedDirection,-1):undefined);
  const back=[...backward.nodes].reverse();
  const nodes=[...back.map(n=>({...n,distance:backward.length-n.distance})),...forward.nodes.slice(1).map(n=>({...n,distance:backward.length+n.distance}))];
  const supports=[...[...backward.supports].reverse(),...forward.supports];
  return {nodes,supports,stop:forward.stop,closed:false,length:backward.length+forward.length,steps:backward.steps+forward.steps};
}

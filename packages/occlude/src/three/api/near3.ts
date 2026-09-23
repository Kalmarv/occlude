import type {Surface3} from '../geometry/surface.js';
import {vector3,type Vector3} from '../rotation.js';
import type {Vec3} from '../math.js';

/** Distance questions on one revision: `points.near` and `edges.near`, the
 * words 2D says. A grid of cells one radius wide is built once per revision
 * and radius and kept beside the surface; a radius that changes from query
 * to query builds a grid for each value, so round it first (2D does the
 * same, and keeps the same eight). */
type Grid=ReadonlyMap<string,readonly number[]>;
const grids=new WeakMap<Surface3,{points:Map<number,Grid>;edges:Map<number,Grid>}>();
const cell=(x:number,y:number,z:number)=>`${x},${y},${z}`;

function checkedRadius(radius:unknown,what:string):number {
  if(typeof radius!=='number'||!(radius>0)||!Number.isFinite(radius))throw new Error(`${what}.near: radius must be a positive finite distance`);
  return radius;
}
function cached(surface:Surface3,kind:'points'|'edges',radius:number,build:()=>Grid):Grid {
  let entry=grids.get(surface);if(!entry){entry={points:new Map(),edges:new Map()};grids.set(surface,entry);}
  const byRadius=entry[kind];let grid=byRadius.get(radius);
  if(!grid){
    grid=build();
    if(byRadius.size>=8)byRadius.delete(byRadius.keys().next().value as number);
    byRadius.set(radius,grid);
  }
  return grid;
}
function add(grid:Map<string,number[]>,key:string,row:number):void{const list=grid.get(key);if(list)list.push(row);else grid.set(key,[row]);}
/** Every row in the 27 cells around `p`: the candidates within one radius. */
function candidates(grid:Grid,p:Vec3,radius:number):number[] {
  const cx=Math.floor(p[0]/radius),cy=Math.floor(p[1]/radius),cz=Math.floor(p[2]/radius),out=new Set<number>();
  for(let x=cx-1;x<=cx+1;x++)for(let y=cy-1;y<=cy+1;y++)for(let z=cz-1;z<=cz+1;z++)for(const row of grid.get(cell(x,y,z))??[])out.add(row);
  return [...out].sort((a,b)=>a-b);
}
/** A place as the question takes it: a row, a triple or `{x, y, z}`. */
export function place3(p:Vector3,what:string):Vec3 {
  if(!p||typeof p!=='object')throw new Error(`${what}.near: expected a point — a row, a triple or {x, y, z}`);
  const v=vector3(p);
  if(!v.every(Number.isFinite))throw new Error(`${what}.near: the point has no finite position`);
  return v;
}
/** The point rows strictly closer than `radius` to `p`. */
export function pointsNear3(surface:Surface3,p:Vec3,radius:number):number[] {
  radius=checkedRadius(radius,'points');
  const grid=cached(surface,'points',radius,()=>{
    const g=new Map<string,number[]>();
    surface.points.forEach((q,i)=>{const [x,y,z]=q.position;add(g,cell(Math.floor(x/radius),Math.floor(y/radius),Math.floor(z/radius)),i);});
    return g;
  });
  return candidates(grid,p,radius).filter(i=>{const q=surface.points[i].position;return Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2])<radius;});
}
/** Distance from `p` to the segment `a`–`b`. */
function segmentDistance(p:Vec3,a:Vec3,b:Vec3):number {
  const d=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],w=[p[0]-a[0],p[1]-a[1],p[2]-a[2]],l=d[0]*d[0]+d[1]*d[1]+d[2]*d[2];
  const t=l>0?Math.max(0,Math.min(1,(w[0]*d[0]+w[1]*d[1]+w[2]*d[2])/l)):0;
  return Math.hypot(w[0]-t*d[0],w[1]-t*d[1],w[2]-t*d[2]);
}
/** The edge rows strictly closer than `radius` to `p`, by the true distance
 * to the segment, so a long edge passing near is near from either end. */
export function edgesNear3(surface:Surface3,p:Vec3,radius:number):number[] {
  radius=checkedRadius(radius,'edges');
  const grid=cached(surface,'edges',radius,()=>{
    const g=new Map<string,number[]>();
    surface.edges.forEach((e,i)=>{
      const a=surface.points[e.vertices[0]].position,b=surface.points[e.vertices[1]].position;
      const lo=[0,1,2].map(k=>Math.floor(Math.min(a[k],b[k])/radius)),hi=[0,1,2].map(k=>Math.floor(Math.max(a[k],b[k])/radius));
      for(let x=lo[0];x<=hi[0];x++)for(let y=lo[1];y<=hi[1];y++)for(let z=lo[2];z<=hi[2];z++)add(g,cell(x,y,z),i);
    });
    return g;
  });
  return candidates(grid,p,radius).filter(i=>{const e=surface.edges[i];return segmentDistance(p,surface.points[e.vertices[0]].position,surface.points[e.vertices[1]].position)<radius;});
}

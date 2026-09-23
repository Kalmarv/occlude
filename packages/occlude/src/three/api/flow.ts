import {add3,mul3,sub3,type Vec3} from '../math.js';
import {emptySize} from '../degenerate.js';
import {Mesh,type GeometryOptions} from './mesh.js';
import {CurveGeometry} from './mesh.js';
import {curve} from './curves.js';
import {query,type PreparedQuery} from './query.js';
import {checkedField3,type VectorField3} from './vec.js';

/** Where the lines start: the points themselves, or a count thrown into a
 * closed mesh — `{ count: 40, within: sphere(2) }`. */
export type Seeds3=readonly Vec3[]|{readonly count:number;readonly within:Mesh<any,any,any,any>};
export interface Streamlines3Options extends GeometryOptions {
  readonly seeds:Seeds3;
  /** Closest another line may come, in world units. Lines stop half of it from
   * ink already laid, and a seed nearer than that is dropped. Unset: no
   * separation rule, so every seed gets its line. */
  readonly spacing?:number;
  /** Integration step; a quarter of the spacing, or a two-hundredth of the
   * seeded extent when there is no spacing. */
  readonly step?:number;
  /** How far a line may reach in each direction from its seed, in world
   * units; eight times the seeded extent by default. */
  readonly maxLength?:number;
  /** A closed mesh the lines are cut to: only the runs inside it are kept,
   * with the crossing point interpolated. An open mesh has no inside, so
   * nothing comes back. */
  readonly within?:Mesh<any,any,any,any>;
}
export interface Streamlines3Env {readonly rnd:()=>number}
const unit=(v:Vec3):Vec3|null=>{
  const m=Math.hypot(...v);
  return m>1e-12&&Number.isFinite(m)?[v[0]/m,v[1]/m,v[2]/m]:null;
};
function direction(field:VectorField3,p:Vec3):Vec3|null {
  const value=field(p[0],p[1],p[2]);
  if(!Array.isArray(value)||value.length!==3||!value.every(n=>typeof n==='number'&&Number.isFinite(n)))return null;
  return unit(value as Vec3);
}
/** One RK4 step of length `h` along the unit field; null where the field has
 * no direction, which is where a line ends. */
function rk4(field:VectorField3,p:Vec3,h:number):Vec3|null {
  const k1=direction(field,p);if(!k1)return null;
  const k2=direction(field,add3(p,mul3(k1,h/2)));if(!k2)return null;
  const k3=direction(field,add3(p,mul3(k2,h/2)));if(!k3)return null;
  const k4=direction(field,add3(p,mul3(k3,h)));if(!k4)return null;
  // Keep the four samples pointing the same way: an unoriented field must not
  // reverse inside one step.
  const align=(k:Vec3):Vec3=>k[0]*k1[0]+k[1]*k1[1]+k[2]*k1[2]<0?mul3(k,-1):k;
  const [a,b,c]=[align(k2),align(k3),align(k4)];
  return [0,1,2].map(i=>p[i]+h/6*(k1[i]+2*a[i]+2*b[i]+c[i])) as unknown as Vec3;
}
/** Separation grid: the 3D lift of the 2D streamline rule (Jobard & Lefer,
 * ideas only). Points are kept in buckets one spacing wide, so a distance test
 * looks at 27 cells and no further. */
class Separation3 {
  private readonly cells=new Map<string,number[]>();
  private readonly x:number[]=[];private readonly y:number[]=[];private readonly z:number[]=[];
  constructor(private readonly cell:number){}
  get length():number{return this.x.length;}
  private key(p:Vec3,d:readonly number[]):string{return `${Math.floor(p[0]/this.cell)+d[0]},${Math.floor(p[1]/this.cell)+d[1]},${Math.floor(p[2]/this.cell)+d[2]}`;}
  add(p:Vec3):void {
    const i=this.x.length;this.x.push(p[0]);this.y.push(p[1]);this.z.push(p[2]);
    const key=this.key(p,[0,0,0]),bucket=this.cells.get(key);
    if(bucket)bucket.push(i);else this.cells.set(key,[i]);
  }
  /** Is any point stored before `skipFrom` within `d`? */
  near(p:Vec3,d:number,skipFrom:number):boolean {
    const r=Math.ceil(d/this.cell),d2=d*d;
    for(let i=-r;i<=r;i++)for(let j=-r;j<=r;j++)for(let k=-r;k<=r;k++)
      for(const n of this.cells.get(this.key(p,[i,j,k]))??[]){
        if(n>=skipFrom)continue;
        const dx=this.x[n]-p[0],dy=this.y[n]-p[1],dz=this.z[n]-p[2];
        if(dx*dx+dy*dy+dz*dz<d2)return true;
      }
    return false;
  }
}
const closed=(mesh:Mesh<any,any,any,any>):boolean=>mesh.surface.faces.length>0&&mesh.surface.edges.every(e=>e.faces.length===2);
function bounds(points:readonly Vec3[]):{low:Vec3;high:Vec3;extent:number} {
  const low:number[]=[Infinity,Infinity,Infinity],high:number[]=[-Infinity,-Infinity,-Infinity];
  for(const p of points)for(let k=0;k<3;k++){low[k]=Math.min(low[k],p[k]);high[k]=Math.max(high[k],p[k]);}
  return {low:low as unknown as Vec3,high:high as unknown as Vec3,extent:Math.hypot(...high.map((h,k)=>h-low[k]))};
}
/** Parity along a ray no face is likely to be edge-on to: an odd direction,
 * and each hit stepped over before the next is asked for. */
function insideMesh(prepared:PreparedQuery,p:Vec3,scale:number):boolean {
  const ray:Vec3=[0.5773502691896258,0.3313708498984761,0.7461373249584261];
  let origin=p,crossings=0;
  for(let i=0;i<64;i++){
    const hit=prepared.ray(origin,ray);
    if(!hit)break;
    crossings++;
    origin=add3(hit.position,mul3(ray,Math.max(1e-9,scale*1e-9)));
  }
  return crossings%2===1;
}
/** The runs of a path that lie inside a closed mesh, with the crossings
 * interpolated: a line is cut where it goes through the wall. */
function cutInside(prepared:PreparedQuery,path:readonly Vec3[],scale:number):Vec3[][] {
  const runs:Vec3[][]=[];
  let inside=insideMesh(prepared,path[0],scale),run:Vec3[]=inside?[path[0]]:[];
  for(let i=1;i<path.length;i++){
    const a=path[i-1],b=path[i];
    let from=a;
    for(let guard=0;guard<16;guard++){
      const hit=prepared.segment(from,b);
      if(!hit)break;
      const crossing=hit.position;
      if(inside){run.push(crossing);if(run.length>1)runs.push(run);run=[];}
      else run=[crossing];
      inside=!inside;
      const advance=sub3(b,from),length=Math.hypot(...advance);
      if(!(length>0))break;
      from=add3(crossing,mul3(advance,Math.max(1e-9,scale*1e-9)/length));
    }
    if(inside)run.push(b);
  }
  if(run.length>1)runs.push(run);
  return runs;
}
/** Evenly spaced streamlines of a 3D vector field as open curves — `view()`
 * occludes them like any other geometry.
 *
 * Each seed is traced both ways with RK4 until the field has no direction
 * there, until the line reaches `maxLength`, or until it comes within half a
 * spacing of ink already laid. Seeds are taken in the order given, so the
 * result is a pure function of the field, the options and the seeded points.
 * A count of seeds is thrown into its mesh with the sketch's seeded stream.
 *
 * A field with no direction, a spacing that is not positive, or an open
 * `within` mesh draws nothing for that piece. */
export function streamlines3(field:VectorField3,options:Streamlines3Options,env:Streamlines3Env):CurveGeometry[] {
  checkedField3(field,'t.streamlines3');
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('streamlines3 requires its options');
  if(options.spacing!==undefined&&emptySize(options.spacing))return [];
  if(options.step!==undefined&&emptySize(options.step))return [];
  if(options.maxLength!==undefined&&emptySize(options.maxLength))return [];
  const bound=options.within;
  if(bound!==undefined&&!(bound instanceof Mesh))throw new Error('streamlines3 within requires a closed mesh');
  if(bound&&!closed(bound))return [];
  const seeds=seedPoints(options.seeds,env);
  if(!seeds.length)return [];
  const region=bound?bounds(bound.surface.points.map(p=>p.position)):undefined;
  const spread=Math.max(bounds(seeds).extent,region?.extent??0);
  const extent=spread>0?spread:1;
  const spacing=options.spacing;
  const step=options.step??(spacing!==undefined?spacing/4:extent/200);
  const maxLength=options.maxLength??8*extent;
  const maxSteps=Math.min(1e6,Math.max(2,Math.ceil(maxLength/step)));
  const grid=spacing!==undefined?new Separation3(spacing):undefined;
  const clip=bound?query(bound):undefined;
  const half=(from:Vec3,sign:number,skipFrom:number):Vec3[]=>{
    const out:Vec3[]=[];let p=from;
    for(let i=0;i<maxSteps;i++){
      const next=rk4(field,p,sign*step);
      if(!next||!next.every(Number.isFinite))break;
      if(grid&&spacing!==undefined){
        // The line's own recent points are never a collision; past the first
        // turn only the last few are ignored, so a line closing on itself
        // stops like any other.
        const window=Math.ceil(spacing/step*1.5);
        const own=i<window?skipFrom:Math.max(skipFrom,grid.length-window);
        if(grid.near(next,spacing/2,own))break;
        grid.add(next);
      }
      out.push(next);p=next;
    }
    return out;
  };
  const curves:CurveGeometry[]=[];
  const {key,seeds:_seeds,spacing:_spacing,step:_step,maxLength:_max,within:_within,...style}=options;
  for(const seed of seeds){
    if(!seed.every(Number.isFinite)||!direction(field,seed))continue;
    if(grid&&spacing!==undefined&&grid.near(seed,spacing*0.9,Infinity))continue;
    const mark=grid?.length??0;
    grid?.add(seed);
    const forward=half(seed,1,mark),back=half(seed,-1,mark);
    const path=[...back.reverse(),seed,...forward];
    if(path.length<2)continue;
    for(const run of clip?cutInside(clip,path,extent):[path])
      if(run.length>1)curves.push(curve(run,{...style,...(key?{key:`${key}:${curves.length}`}:{})}));
  }
  return curves;
}
function seedPoints(seeds:Seeds3,env:Streamlines3Env):Vec3[] {
  if(Array.isArray(seeds))return (seeds as readonly Vec3[]).map(p=>[...p] as Vec3);
  const request=seeds as {count:number;within:Mesh<any,any,any,any>};
  if(!request||typeof request!=='object'||!(request.within instanceof Mesh))throw new Error('streamlines3 seeds require a list of points, or { count, within }');
  if(!Number.isSafeInteger(request.count)||request.count<0)throw new Error('streamlines3 seed count must be a nonnegative integer');
  if(!closed(request.within))return [];
  const box=bounds(request.within.surface.points.map(p=>p.position));
  if(!(box.extent>0))return [];
  const prepared=query(request.within),out:Vec3[]=[];
  // Rejection sampling in the mesh's own box: the points are where the shape
  // is, and the stream decides them, so the same sketch and seed give the
  // same lines.
  for(let attempt=0;attempt<request.count*200&&out.length<request.count;attempt++){
    const p=[0,1,2].map(k=>box.low[k]+(box.high[k]-box.low[k])*env.rnd()) as unknown as Vec3;
    if(insideMesh(prepared,p,box.extent))out.push(p);
  }
  return out;
}

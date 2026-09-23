import {surface3} from '../geometry/surface.js';
import {chartSurface3,type SurfaceUV,type SurfaceChart} from '../geometry/coordinates.js';
import {Mesh,emptyMesh,type GeometryOptions} from './mesh.js';
import {emptyCount,emptySize} from '../degenerate.js';
import {ownSurface3} from '../geometry/model.js';
import {add3,sub3,mul3,dot3,cross3,type Vec3} from '../math.js';
import {convexHull3} from '../geometry/hull.js';

export interface SphereOptions extends GeometryOptions {readonly segments?:number;readonly rings?:number}
export interface RadialOptions extends GeometryOptions {readonly segments?:number;readonly caps?:boolean}
export interface TorusOptions extends GeometryOptions {readonly segments?:number;readonly tubeSegments?:number}
const TAU=2*Math.PI;
/** Where the radial generators put their centre. */
const ORIGIN=Object.freeze([0,0,0]) as unknown as Vec3;
/** The golden ratio: the icosahedron's own number. */
const PHI=(1+Math.sqrt(5))/2;
/** The three triangular Platonic solids, wound outward, at unit circumradius
 * after scaling: the bases a geodesic polyhedron divides. */
const SOLIDS:Record<'icosahedron'|'octahedron'|'tetrahedron',{points:readonly Vec3[];faces:readonly (readonly [number,number,number])[]}>={
  icosahedron:{
    points:[[-1,PHI,0],[1,PHI,0],[-1,-PHI,0],[1,-PHI,0],[0,-1,PHI],[0,1,PHI],[0,-1,-PHI],[0,1,-PHI],[PHI,0,-1],[PHI,0,1],[-PHI,0,-1],[-PHI,0,1]],
    faces:[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]],
  },
  octahedron:{
    points:[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],
    faces:[[0,2,4],[2,1,4],[1,3,4],[3,0,4],[2,0,5],[1,2,5],[3,1,5],[0,3,5]],
  },
  tetrahedron:{
    points:[[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]],
    faces:[[0,1,2],[0,3,1],[0,2,3],[1,3,2]],
  },
};
/** A primitive with no extent, or with too few segments to close a surface, is
 * an empty mesh: the same nothing-to-draw `box3` returns for a zero size. The
 * budget below is a real limit and still throws, as does a non-integer count. */
const empty=(sizes:readonly number[],counts:readonly (readonly [number,number,string])[]):boolean=>
  emptySize(...sizes)||counts.some(([n,min,name])=>emptyCount(n,min,name));
function budget(points:number,faces:number):void{if(points>500000||faces>250000)throw new Error('primitive exceeds budget (500000 points / 250000 faces)');}
function optionsObject(options:unknown):void{if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('primitive options must be an object');}

/** Shared latitude rings and single poles; +Z is the polar axis. */
export function sphere(radius=1,options:SphereOptions={}):Mesh<{},{},SurfaceChart,SurfaceUV> {
  optionsObject(options);
  const n=options.segments??32,r=options.rings??16;
  if(empty([radius],[[n,3,'sphere segments'],[r,2,'sphere rings']]))return emptyMesh(options);
  budget(2+n*(r-1),n*r);
  const points:Vec3[]=[[0,0,-radius]],faces:number[][]=[];
  for(let j=1;j<r;j++){const a=-Math.PI/2+Math.PI*j/r,z=radius*Math.sin(a),radial=radius*Math.cos(a);for(let i=0;i<n;i++){const u=TAU*i/n;points.push([radial*Math.cos(u),radial*Math.sin(u),z]);}}
  const top=points.length;points.push([0,0,radius]);
  for(let i=0;i<n;i++){
    const next=(i+1)%n;faces.push([0,1+next,1+i]);
    for(let j=0;j<r-2;j++){const low=1+j*n,high=low+n;faces.push([low+i,low+next,high+next,high+i]);}
    const last=1+(r-2)*n;faces.push([last+i,last+next,top]);
  }
  return new Mesh(ownSurface3(chartSurface3(surface3(points,faces),(f,c)=>{
    const sector=Math.floor(f/r),band=f%r,u=sector/n,next=(sector+1)/n;
    const uv:readonly (readonly [number,number])[]=band===0
      ? [[(u+next)/2,0],[next,1/r],[u,1/r]]
      : band===r-1 ? [[u,(r-1)/r],[next,(r-1)/r],[(u+next)/2,1]]
      : [[u,band/r],[next,band/r],[next,(band+1)/r],[u,(band+1)/r]];
    return {uv:uv[c],chart:'sphere'};
  })),{...options,radialCentre:ORIGIN});
}

export type GeodesicBase='icosahedron'|'octahedron'|'tetrahedron';
/** Whole steps a side: `m` is the class I pair `[m, 0]`. */
export type GeodesicFrequency=number|readonly [number,number];
export interface GeodesicOptions extends GeometryOptions {readonly frequency?:GeodesicFrequency;readonly base?:GeodesicBase;
  /** Push every lattice point out to `radius` (the default). `false` keeps the
   * flat solid, its faces divided the same way. */
  readonly project?:boolean}
/** A geodesic polyhedron: the dome's mesh. Every triangle of the base solid
 * carries a triangular lattice, and every point is pushed out to `radius`.
 * Triangles only, no poles and no seam — `sphere()` is a latitude grid, so its
 * quads crowd at the poles and it carries a seam ring, while this one has
 * nearly equal triangles everywhere, which is what surface hatch, scatter and
 * `mapSurface` want. `.dual()` gives the Goldberg polyhedron.
 *
 * `frequency` is the Goldberg-Coxeter pair `[m, n]`: how many lattice steps
 * along, then how many turned 60 degrees. `[m, 0]` (a plain number) is class I,
 * the straight division — `[2, 0]`, `[4, 0]`, `[8, 0]` are the shape usually
 * called an icosphere. `[m, m]` is class II, which puts a vertex at the middle
 * of every base edge. Any other pair is class III, the chiral one, whose
 * triangles straddle the base edges; `[n, m]` is its mirror image.
 *
 * Faces are `T = m² + mn + n²` per base face: 20T for the icosahedron
 * (default), 8T for the octahedron, 4T for the tetrahedron. Points on a shared
 * base edge are shared exactly, and the triangulation is the convex hull of
 * the points, which for points on a sphere is the geodesic one.
 *
 * `project: false` keeps the flat solid with its faces divided the same way,
 * the dome before it is inflated; a class III triangle then spans a base edge,
 * so the flat solid folds across it.
 *
 * The chart is spherical: u is the longitude around Z, v the latitude, and a
 * triangle that crosses the meridian carries u past 1 rather than folding the
 * chart back on itself. */
export function geodesic(radius=1,options:GeodesicOptions={}):Mesh<{},{},SurfaceChart,SurfaceUV> {
  optionsObject(options);
  const name=options.base??'icosahedron',project=options.project??true;
  if(typeof project!=='boolean')throw new Error('geodesic project must be boolean');
  const raw=options.frequency??2;
  const pair:readonly [number,number]=typeof raw==='number'?[raw,0]:Array.isArray(raw)&&raw.length===2?[raw[0],raw[1]]:[Number.NaN,Number.NaN];
  const [m,k]=pair;
  if(!pair.every(v=>Number.isSafeInteger(v)&&v>=0)||m+k<1)throw new Error('geodesic frequency must be an integer of 1 or more, or a pair [m, n] of whole steps that are not both zero');
  const solid=SOLIDS[name];
  if(!solid)throw new Error("geodesic base must be 'icosahedron', 'octahedron' or 'tetrahedron'");
  const T=m*m+m*k+k*k,faceCount=solid.faces.length*T;
  if(faceCount>250000)throw new Error('geodesic frequency exceeds budget (250000 faces)');
  if(empty([radius],[]))return emptyMesh(options);
  budget(faceCount/2+2,faceCount);
  const corner=solid.points.map(p=>{const s=radius/Math.hypot(...p);return [p[0]*s,p[1]*s,p[2]*s] as Vec3;});
  // Lattice points are shared by position: a point on a base edge is reached
  // from both of its faces, and class III lattices meet the edge nowhere.
  const quantum=Math.max(1,radius)*1e-9,buckets=new Map<string,number[]>();
  const flat:Vec3[]=[],sphere:Vec3[]=[];
  const cell=(p:Vec3,d:readonly number[]):string=>p.map((v,i)=>Math.round(v/quantum)+d[i]).join(',');
  const place=(p:Vec3):number=>{
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++)
      for(const i of buckets.get(cell(p,[dx,dy,dz]))??[])if(Math.hypot(...sub3(flat[i],p))<=quantum)return i;
    const index=flat.length;flat.push(p);
    const s=radius/Math.hypot(...p);sphere.push([p[0]*s,p[1]*s,p[2]*s]);
    const key=cell(p,[0,0,0]);const bucket=buckets.get(key);if(bucket)bucket.push(index);else buckets.set(key,[index]);
    return index;
  };
  const root3=Math.sqrt(3),angle=Math.atan2(k*root3/2,m+k/2),span=Math.sqrt(T);
  const cosine=Math.cos(angle),sine=Math.sin(angle);
  for(const [ia,ib,ic] of solid.faces){
    const A=corner[ia],B=corner[ib],C=corner[ic];
    const along=sub3(B,A),length=Math.hypot(...along),u=mul3(along,1/length);
    const normal=cross3(along,sub3(C,A)),w=cross3(mul3(normal,1/Math.hypot(...normal)),u);
    const scale=length/span;
    // Every Eisenstein point of the big triangle (0, m + n·w, turned 60°).
    for(let p=-k;p<=m;p++)for(let q=0;q<=m+k;q++){
      const x=p+q/2,y=q*root3/2;
      // Barycentric coordinates in that triangle: z / (m + n·w), read as a + b·w.
      const a=(x*(m+k/2)+y*(k*root3/2))/T,b=(y*(m+k/2)-x*(k*root3/2))/T;
      const beta=2*b/root3,alpha=a-b/root3;
      if(alpha<-1e-9||beta<-1e-9||alpha+beta>1+1e-9)continue;
      const rx=(x*cosine+y*sine)*scale,ry=(y*cosine-x*sine)*scale;
      place(add3(A,add3(mul3(u,rx),mul3(w,ry))));
    }
  }
  // The hull decides the triangulation. A deterministic radial nudge, far below
  // the lattice spacing and far above rounding, keeps four points on one circle
  // from sharing a plane, which is the one thing a hull cannot answer.
  const nudged=sphere.map((p,i)=>mul3(p,1+1e-9*(((i*2654435761)>>>0)/2**32)));
  let faces=convexHull3(nudged).map(f=>[...f]);
  const position=project?sphere:flat;
  let volume=0;for(const [a,b,c] of faces)volume+=dot3(sphere[a],cross3(sphere[b],sphere[c]))/6;
  if(volume<0)faces=faces.map(f=>[f[0],f[2],f[1]]);
  if(!faces.length)return emptyMesh(options);
  const longitude=(p:Vec3):number=>{const value=Math.atan2(p[1],p[0])/TAU;return value<0?value+1:value;};
  const latitude=(p:Vec3):number=>.5+Math.asin(Math.max(-1,Math.min(1,p[2]/radius)))/Math.PI;
  return new Mesh(ownSurface3(chartSurface3(surface3(position,faces),(f,c,v)=>{
    // A corner over a pole has no longitude of its own: it takes the mean of
    // the others, so the triangle's chart stays a triangle.
    const corners=faces[f].map(i=>Math.hypot(sphere[i][0],sphere[i][1])>1e-9*radius?longitude(sphere[i]):null);
    const anchor=corners.find(value=>value!==null)??0;
    const unwrapped=corners.map(value=>{if(value===null)return null;let out=value;while(out-anchor>.5)out-=1;while(anchor-out>.5)out+=1;return out;});
    const known=unwrapped.filter(value=>value!==null);
    const resolved=unwrapped.map(value=>value??(known.length?known.reduce((sum,n)=>sum+n,0)/known.length:0));
    // A projected geodesic is star-shaped about the origin it was pushed out
    // from; the flat solid is not built that way and claims nothing.
    return {uv:[resolved[c],latitude(sphere[v])],chart:'geodesic'};
  })),project?{...options,radialCentre:ORIGIN}:options);
}

/** Centered on Z, with shared cap/side rims. */
export function cylinder(radius=1,height=2,options:RadialOptions={}):Mesh<{},{},SurfaceChart,SurfaceUV> {
  optionsObject(options);
  const n=options.segments??32;
  if(empty([radius,height],[[n,3,'cylinder segments']]))return emptyMesh(options);
  budget(2*n,n+2);
  if(options.caps!==undefined&&typeof options.caps!=='boolean')throw new Error('cylinder caps must be boolean');
  const points:Vec3[]=[],faces:number[][]=[];
  for(const z of [-height/2,height/2])for(let i=0;i<n;i++){const a=TAU*i/n;points.push([radius*Math.cos(a),radius*Math.sin(a),z]);}
  for(let i=0;i<n;i++){const next=(i+1)%n;faces.push([i,next,n+next,n+i]);}
  if(options.caps??true){faces.push(Array.from({length:n},(_,i)=>n-1-i));faces.push(Array.from({length:n},(_,i)=>n+i));}
  return new Mesh(ownSurface3(chartSurface3(surface3(points,faces),(f,c,v)=>{
    if(f<n){const u=f/n,next=(f+1)/n,uv:readonly (readonly [number,number])[]=[[u,0],[next,0],[next,1],[u,1]];return {uv:uv[c],chart:'side'};}
    return {uv:[.5+.5*points[v][0]/radius,.5+.5*points[v][1]/radius],chart:f===n?'bottom':'top'};
  })),options);
}

/** Base at -height/2, one shared apex at +height/2. */
export function cone(radius=1,height=2,options:RadialOptions={}):Mesh<{},{},SurfaceChart,SurfaceUV> {
  optionsObject(options);
  const n=options.segments??32;
  if(empty([radius,height],[[n,3,'cone segments']]))return emptyMesh(options);
  budget(n+1,n+1);
  if(options.caps!==undefined&&typeof options.caps!=='boolean')throw new Error('cone caps must be boolean');
  const points:Vec3[]=[],faces:number[][]=[];
  for(let i=0;i<n;i++){const a=TAU*i/n;points.push([radius*Math.cos(a),radius*Math.sin(a),-height/2]);}
  points.push([0,0,height/2]);for(let i=0;i<n;i++)faces.push([i,(i+1)%n,n]);
  if(options.caps??true)faces.push(Array.from({length:n},(_,i)=>n-1-i));
  return new Mesh(ownSurface3(chartSurface3(surface3(points,faces),(f,c,v)=>{
    if(f<n){const uv:readonly (readonly [number,number])[]=[[f/n,0],[(f+1)/n,0],[(f+.5)/n,1]];return {uv:uv[c],chart:'side'};}
    return {uv:[.5+.5*points[v][0]/radius,.5+.5*points[v][1]/radius],chart:'bottom'};
  })),options);
}

/** Ring in XY: radius measures the tube centerline, tubeRadius its section. */
export function torus(radius=1,tubeRadius=.25,options:TorusOptions={}):Mesh<{},{},SurfaceChart,SurfaceUV> {
  optionsObject(options);
  const n=options.segments??32,m=options.tubeSegments??12;
  if(empty([radius,tubeRadius],[[n,3,'torus segments'],[m,3,'torus tube segments']]))return emptyMesh(options);
  // A tube as fat as the centerline folds the ring onto its own axis, which no
  // simple polygon can represent: that stays an error, not an empty drawing.
  if(tubeRadius>=radius)throw new Error('torus tube radius must be smaller than its centerline radius');
  budget(n*m,n*m);
  const points:Vec3[]=[],faces:number[][]=[];
  for(let i=0;i<n;i++)for(let j=0;j<m;j++){const u=TAU*i/n,v=TAU*j/m,r=radius+tubeRadius*Math.cos(v);points.push([r*Math.cos(u),r*Math.sin(u),tubeRadius*Math.sin(v)]);}
  for(let i=0;i<n;i++)for(let j=0;j<m;j++)faces.push([i*m+j,((i+1)%n)*m+j,((i+1)%n)*m+(j+1)%m,i*m+(j+1)%m]);
  return new Mesh(ownSurface3(chartSurface3(surface3(points,faces),(f,c)=>{
    const i=Math.floor(f/m),j=f%m,uv:readonly (readonly [number,number])[]=[[i/n,j/m],[(i+1)/n,j/m],[(i+1)/n,(j+1)/m],[i/n,(j+1)/m]];
    return {uv:uv[c],chart:'torus'};
  })),options);
}

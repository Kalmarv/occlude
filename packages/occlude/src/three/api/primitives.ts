import {surface3} from '../geometry/surface.js';
import {chartSurface3,type SurfaceUV} from '../geometry/coordinates.js';
import {Mesh,type GeometryOptions} from './mesh.js';
import {ownSurface3} from '../geometry/model.js';
import type {Vec3} from '../math.js';

export interface SphereOptions extends GeometryOptions {readonly segments?:number;readonly rings?:number}
export interface RadialOptions extends GeometryOptions {readonly segments?:number;readonly caps?:boolean}
export interface TorusOptions extends GeometryOptions {readonly segments?:number;readonly tubeSegments?:number}
const TAU=2*Math.PI;
function positive(n:number,name:string):void{if(!Number.isFinite(n)||n<=0)throw new Error(`${name} must be positive and finite`);}
function count(n:number,min:number,name:string):void{if(!Number.isSafeInteger(n)||n<min)throw new Error(`${name} must be an integer >= ${min}`);}
function budget(points:number,faces:number):void{if(points>500000||faces>250000)throw new Error('primitive exceeds budget (500000 points / 250000 faces)');}
function optionsObject(options:unknown):void{if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('primitive options must be an object');}

/** Shared latitude rings and single poles; +Z is the polar axis. */
export function sphere(radius=1,options:SphereOptions={}):Mesh<{},{},{},SurfaceUV> {
  optionsObject(options);positive(radius,'sphere radius');
  const n=options.segments??32,r=options.rings??16;count(n,3,'sphere segments');count(r,2,'sphere rings');budget(2+n*(r-1),n*r);
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
  })),options);
}

/** Centered on Z, with shared cap/side rims. */
export function cylinder(radius=1,height=2,options:RadialOptions={}):Mesh<{},{},{},SurfaceUV> {
  optionsObject(options);positive(radius,'cylinder radius');positive(height,'cylinder height');
  const n=options.segments??32;count(n,3,'cylinder segments');budget(2*n,n+2);
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
export function cone(radius=1,height=2,options:RadialOptions={}):Mesh<{},{},{},SurfaceUV> {
  optionsObject(options);positive(radius,'cone radius');positive(height,'cone height');
  const n=options.segments??32;count(n,3,'cone segments');budget(n+1,n+1);
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
export function torus(radius=1,tubeRadius=.25,options:TorusOptions={}):Mesh<{},{},{},SurfaceUV> {
  optionsObject(options);positive(radius,'torus radius');positive(tubeRadius,'torus tube radius');
  if(tubeRadius>=radius)throw new Error('torus tube radius must be smaller than its centerline radius');
  const n=options.segments??32,m=options.tubeSegments??12;count(n,3,'torus segments');count(m,3,'torus tube segments');budget(n*m,n*m);
  const points:Vec3[]=[],faces:number[][]=[];
  for(let i=0;i<n;i++)for(let j=0;j<m;j++){const u=TAU*i/n,v=TAU*j/m,r=radius+tubeRadius*Math.cos(v);points.push([r*Math.cos(u),r*Math.sin(u),tubeRadius*Math.sin(v)]);}
  for(let i=0;i<n;i++)for(let j=0;j<m;j++)faces.push([i*m+j,((i+1)%n)*m+j,((i+1)%n)*m+(j+1)%m,i*m+(j+1)%m]);
  return new Mesh(ownSurface3(chartSurface3(surface3(points,faces),(f,c)=>{
    const i=Math.floor(f/m),j=f%m,uv:readonly (readonly [number,number])[]=[[i/n,j/m],[(i+1)/n,j/m],[(i+1)/n,(j+1)/m],[i/n,(j+1)/m]];
    return {uv:uv[c],chart:'torus'};
  })),options);
}

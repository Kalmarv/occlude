import {mesh,type Mesh,type GeometryOptions} from './mesh.js';
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
export function sphere(radius=1,options:SphereOptions={}):Mesh {
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
  return mesh(points,faces,options);
}

/** Centered on Z, with shared cap/side rims. */
export function cylinder(radius=1,height=2,options:RadialOptions={}):Mesh {
  optionsObject(options);positive(radius,'cylinder radius');positive(height,'cylinder height');
  const n=options.segments??32;count(n,3,'cylinder segments');budget(2*n,n+2);
  if(options.caps!==undefined&&typeof options.caps!=='boolean')throw new Error('cylinder caps must be boolean');
  const points:Vec3[]=[],faces:number[][]=[];
  for(const z of [-height/2,height/2])for(let i=0;i<n;i++){const a=TAU*i/n;points.push([radius*Math.cos(a),radius*Math.sin(a),z]);}
  for(let i=0;i<n;i++){const next=(i+1)%n;faces.push([i,next,n+next,n+i]);}
  if(options.caps??true){faces.push(Array.from({length:n},(_,i)=>n-1-i));faces.push(Array.from({length:n},(_,i)=>n+i));}
  return mesh(points,faces,options);
}

/** Base at -height/2, one shared apex at +height/2. */
export function cone(radius=1,height=2,options:RadialOptions={}):Mesh {
  optionsObject(options);positive(radius,'cone radius');positive(height,'cone height');
  const n=options.segments??32;count(n,3,'cone segments');budget(n+1,n+1);
  if(options.caps!==undefined&&typeof options.caps!=='boolean')throw new Error('cone caps must be boolean');
  const points:Vec3[]=[],faces:number[][]=[];
  for(let i=0;i<n;i++){const a=TAU*i/n;points.push([radius*Math.cos(a),radius*Math.sin(a),-height/2]);}
  points.push([0,0,height/2]);for(let i=0;i<n;i++)faces.push([i,(i+1)%n,n]);
  if(options.caps??true)faces.push(Array.from({length:n},(_,i)=>n-1-i));
  return mesh(points,faces,options);
}

/** Ring in XY: radius measures the tube centerline, tubeRadius its section. */
export function torus(radius=1,tubeRadius=.25,options:TorusOptions={}):Mesh {
  optionsObject(options);positive(radius,'torus radius');positive(tubeRadius,'torus tube radius');
  if(tubeRadius>=radius)throw new Error('torus tube radius must be smaller than its centerline radius');
  const n=options.segments??32,m=options.tubeSegments??12;count(n,3,'torus segments');count(m,3,'torus tube segments');budget(n*m,n*m);
  const points:Vec3[]=[],faces:number[][]=[];
  for(let i=0;i<n;i++)for(let j=0;j<m;j++){const u=TAU*i/n,v=TAU*j/m,r=radius+tubeRadius*Math.cos(v);points.push([r*Math.cos(u),r*Math.sin(u),tubeRadius*Math.sin(v)]);}
  for(let i=0;i<n;i++)for(let j=0;j<m;j++)faces.push([i*m+j,((i+1)%n)*m+j,((i+1)%n)*m+(j+1)%m,i*m+(j+1)%m]);
  return mesh(points,faces,options);
}

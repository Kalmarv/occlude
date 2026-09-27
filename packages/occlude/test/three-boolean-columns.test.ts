import {describe,it,expect} from 'vitest';
import {box,sphere} from '../src/three/api/index.js';
import type {Material,Vertex,Edge} from '../src/material.js';

/** The edge from a point to the point straight above it, if there is one. */
const upward=(p:Vertex):Edge|null=>p.edges.find(e=>{const o=e.a===p?e.b:e.a;return o.x===p.x&&o.y===p.y&&(o as unknown as {z:number}).z>(p as unknown as {z:number}).z})??null;
const z=(p:Vertex)=>(p as unknown as {z:number}).z;

/** A box whose edges, corners and points carry columns of every kind a
 * boolean reads: edge numbers (one distributed), strings and vectors; the
 * box's own corner uv and a corner string; a point column that holds an
 * edge. */
const cube=()=>box(2)
  .edges.set({w:e=>e.length,tag:e=>`e${e.index}`,dir:e=>[e.b.x-e.a.x,e.b.y-e.a.y,z(e.b)-z(e.a)]})
  .edges.set('share',e=>e.length,{transfer:'distribute'})
  .corners.set('tag',c=>`c${c.index}`)
  .points.set('up',upward);
const ball=()=>sphere(1.2,{segments:12,rings:6}).translate([0.9,0.8,0.7]).edges.set('w',()=>7);

const OPS=['union','subtract','intersect'] as const;
const run=(op:typeof OPS[number])=>{const a=cube(),b=ball();return {a,b,out:(a[op] as (o:Material)=>Material)(b)};};

describe('a boolean carries the edge and corner columns of both solids',()=>{
 for(const op of OPS) it(`${op}: an edge along an input edge keeps its columns, a piece its share`,()=>{
  const {a,b,out}=run(op);
  expect(out.edgeTransfers.share).toBe('distribute');
  let pieces=0,whole=0,made=0;
  for(const e of out.edges){
   const s=e.source as Edge|undefined;
   if(s!==undefined&&a.edges.some(x=>x===s)){
    // A piece holds the parent's values, and a distributed one its share,
    // which for a straight edge is the part of its length it holds.
    expect(e.tag).toBe(s.tag);expect(e.dir).toEqual(s.dir);expect(e.w).toBe(s.w);
    expect(e.share).toBeCloseTo(e.length,9);
    expect(e.root).toBe(s.root);
    if(Math.abs(e.length-s.length)<1e-12)whole++;else pieces++;
   }else if(s!==undefined&&b.edges.some(x=>x===s)){
    expect(e.w).toBe(7);expect(e.tag).toBe('');expect(e.root).toBe(s.root);
   }else{
    // A seam or a new diagonal is a new edge: the defaults, and a root of its own.
    expect(s).toBeUndefined();
    expect([e.w,e.tag,e.dir,e.share]).toEqual([0,'',[0,0,0],0]);
    made++;
   }
  }
  expect(pieces).toBeGreaterThan(0);expect(made).toBeGreaterThan(0);
  if(op!=='intersect')expect(whole).toBeGreaterThan(0);
 });

 for(const op of OPS) it(`${op}: a corner reads the corner of its source face at its point, or their blend at a seam point`,()=>{
  const {a,out}=run(op);
  let kept=0,blended=0;
  for(const face of out.faces){
   type Row={point:Vertex;uv:readonly number[];tag:string};
   const found=a.faces.find(f=>f===face.source);
   if(found===undefined)continue;
   const source={corners:[...found.corners] as unknown as Row[]};
   for(const c of [...face.corners] as unknown as Row[]){
    const own=source.corners.find(k=>k.point===c.point.source);
    if(own!==undefined){expect(c.uv).toEqual(own.uv);expect(c.tag).toBe(own.tag);kept++;continue;}
    // A box face's uv is affine over its square: the blend at a seam point
    // is that map at the point. A string is one of the face's own.
    const [p,q,r]=source.corners,at=(k:{point:Vertex})=>[k.point.x,k.point.y,z(k.point)];
    const P=at(p),Q=at(q),R=at(r),X=[c.point.x,c.point.y,z(c.point)];
    const u=[Q[0]-P[0],Q[1]-P[1],Q[2]-P[2]],v=[R[0]-P[0],R[1]-P[1],R[2]-P[2]],d=[X[0]-P[0],X[1]-P[1],X[2]-P[2]];
    const dot=(m:number[],n:number[])=>m[0]*n[0]+m[1]*n[1]+m[2]*n[2],uu=dot(u,u),uv=dot(u,v),vv=dot(v,v),du=dot(d,u),dv=dot(d,v),den=uu*vv-uv*uv;
    const s=(du*vv-dv*uv)/den,t=(dv*uu-du*uv)/den;
    for(let k=0;k<2;k++)expect(c.uv[k]).toBeCloseTo(p.uv[k]+s*(q.uv[k]-p.uv[k])+t*(r.uv[k]-p.uv[k]),9);
    expect(source.corners.map(k=>k.tag)).toContain(c.tag);
    blended++;
   }
  }
  expect(kept).toBeGreaterThan(0);expect(blended).toBeGreaterThan(0);
 });
});

describe('an edge reference survives a boolean by lineage, as a 2D split',()=>{
 for(const op of OPS) it(`${op}: a whole edge is the same row; a cut edge retires, its pieces answer it as their source; a gone one is nothing`,()=>{
  const {a,out}=run(op);
  let whole=0,cut=0,gone=0;
  for(const s of a.edges){
   const held=a.edges.filter(e=>e===s);
   const found=out.edges.filter(e=>e.source===s);
   const same=found.filter(e=>Math.abs(e.length-s.length)<1e-12);
   if(same.length===1){
    // The edge survives whole: the view held of the input names it, and so
    // does a reference to it carried in a point column.
    expect(out.edges.intersect(held).length).toBe(1);
    expect(out.edges.rows(s).at(0)).toBe(same.at(0));
    for(const p of out.points)if(p.source!==undefined&&(p.source as Vertex).up===s)expect(p.up).toBe(same.at(0));
    whole++;
   }else{
    // A cut edge is retired, as a split's parent: nothing names it, and a
    // reference to it reads null. Its pieces name it as their source and
    // keep its root; an edge with no piece left is simply gone.
    expect(out.edges.intersect(held).length).toBe(0);
    expect(out.edges.rows(s).length).toBe(0);
    for(const p of out.points)if(p.source!==undefined&&(p.source as Vertex).up===s)expect(p.up).toBeNull();
    for(const e of found)expect(e.root).toBe(s.root);
    if(found.length)cut++;else gone++;
   }
  }
  expect(cut).toBeGreaterThan(0);
  expect(whole+gone).toBeGreaterThan(0);
 });
});

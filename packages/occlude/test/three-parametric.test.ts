import {describe,it,expect} from 'vitest';
import {parametric,sphere,torus,type Mesh} from '../src/three/api/index.js';
import {cross3,dot3,sub3,type Vec3} from '../src/three/math.js';

/** The same closed-surface test the primitive catalog uses. */
function manifold(s:Mesh<any,any,any,any>,chi:number){
  expect(s.surface.edges.every(e=>e.faces.length===2)).toBe(true);
  expect(s.points.length-s.edges.length+s.faces.length).toBe(chi);
  const directions=new Map<string,number>();
  for(const f of s.surface.faces)for(let i=0;i<f.vertices.length;i++){const a=f.vertices[i],b=f.vertices[(i+1)%f.vertices.length],key=[Math.min(a,b),Math.max(a,b)].join(':');directions.set(key,(directions.get(key)??0)+(a<b?1:-1));}
  expect([...directions.values()].every(n=>n===0)).toBe(true);
  let volume=0;for(const t of s.surface.triangles){const [a,b,c]=t.vertices.map(i=>s.surface.points[i].position);expect(Math.hypot(...cross3(sub3(b,a),sub3(c,a)))).toBeGreaterThan(0);volume+=dot3(a,cross3(b,c))/6;}
  expect(volume).toBeGreaterThan(0);
}
const TAU=2*Math.PI;
const ball=(radius=1)=>(u:number,v:number):Vec3=>{
  const lon=TAU*u,lat=Math.PI*(v-.5);
  return [radius*Math.cos(lat)*Math.cos(lon),radius*Math.cos(lat)*Math.sin(lon),radius*Math.sin(lat)];
};

describe('parametric surfaces from a formula',()=>{
 it('closes a sphere by formula exactly as sphere() does',()=>{
  const formula=parametric(ball(2),{cols:32,rows:17,closeU:true});
  const primitive=sphere(2,{segments:32,rings:16});
  expect(formula.points.length).toBe(primitive.points.length);
  expect(formula.faces.length).toBe(primitive.faces.length);
  manifold(formula,2);
  for(const p of formula.points)expect(Math.hypot(p.x,p.y,p.z)).toBeCloseTo(2,12);
  // The poles are single shared vertices, not a ring of coincident ones.
  expect(formula.points.filter(p=>Math.abs(Math.abs(p.z)-2)<1e-9).length).toBe(2);
 });
 it('welds both seams of a torus knot tube and leaves a helicoid open',()=>{
  const knot=parametric((u,v)=>{
    const a=TAU*u,b=TAU*v,r=2+Math.cos(3*a);
    const centre:Vec3=[r*Math.cos(2*a),r*Math.sin(2*a),Math.sin(3*a)];
    // A crude frame is enough: the tube only has to close on itself.
    const tangent:Vec3=[-Math.sin(2*a),Math.cos(2*a),0],normal:Vec3=[Math.cos(2*a),Math.sin(2*a),0];
    const bi=cross3(tangent,normal);
    return [0,1,2].map(k=>centre[k]+.35*(Math.cos(b)*normal[k]+Math.sin(b)*bi[k])) as unknown as Vec3;
  },{cols:64,rows:16,closeU:true,closeV:true});
  expect(knot.surface.edges.every(e=>e.faces.length===2)).toBe(true);
  expect(knot.points.length).toBe(64*16);
  expect(knot.points.length-knot.edges.length+knot.faces.length).toBe(0);
  const helicoid=parametric((u,v)=>{const a=TAU*u;return [v*Math.cos(a),v*Math.sin(a),.4*a];},{cols:24,rows:8});
  expect(helicoid.surface.edges.filter(e=>e.faces.length===1).length).toBeGreaterThan(0);
  expect(helicoid.faces.length).toBe(23*7);
 });
 it('carries the unit square as a chart and winds by du x dv',()=>{
  const sheet=parametric((u,v)=>[u*2-1,v*2-1,0],{cols:5,rows:5});
  const uv=sheet.surface.faces.flatMap(f=>f.corners!.map(c=>c.attributes.uv as readonly [number,number]));
  expect(uv.every(p=>p[0]>=0&&p[0]<=1&&p[1]>=0&&p[1]<=1)).toBe(true);
  expect(Math.max(...uv.map(p=>p[0]))).toBeCloseTo(1,12);
  expect(Math.max(...uv.map(p=>p[1]))).toBeCloseTo(1,12);
  expect(sheet.surface.faces.every(f=>(f.corners??[]).every(c=>c.attributes.chart==='parametric'))).toBe(true);
  // du x dv is +Z for this sheet, so every face normal is +Z.
  expect(sheet.faces.every(f=>f.normal[2]>.999)).toBe(true);
  // Swapping the parameters turns the same sheet inside out.
  const flipped=parametric((u,v)=>[v*2-1,u*2-1,0],{cols:5,rows:5});
  expect(flipped.faces.every(f=>f.normal[2]<-.999)).toBe(true);
 });
 it('matches torus() for the same formula and resolution',()=>{
  const formula=parametric((u,v)=>{const a=TAU*u,b=TAU*v,r=1+.25*Math.cos(b);return [r*Math.cos(a),r*Math.sin(a),.25*Math.sin(b)];},{cols:32,rows:12,closeU:true,closeV:true});
  const primitive=torus(1,.25,{segments:32,tubeSegments:12});
  expect(formula.points.length).toBe(primitive.points.length);
  expect(formula.faces.length).toBe(primitive.faces.length);
  manifold(formula,0);
 });
 it('draws nothing for a degenerate formula and names real mistakes',()=>{
  for(const make of [
    ()=>parametric(ball(),{cols:1,rows:8}),
    ()=>parametric(ball(),{cols:8,rows:1}),
    ()=>parametric(ball(),{cols:2,rows:8,closeU:true}),
    ()=>parametric((u,v)=>[u,v,1/0],{cols:4,rows:4}),
    ()=>parametric((u,v)=>[u,v,Number.NaN],{cols:4,rows:4}),
  ])expect(make().surface.faces.length).toBe(0);
  expect(()=>parametric(ball(),{cols:4.5,rows:4})).toThrow('integer');
  expect(()=>parametric(ball(),{cols:2000,rows:2000})).toThrow('budget');
  expect(()=>parametric(undefined as never,{cols:4,rows:4})).toThrow('formula');
  expect(()=>parametric(ball(),{cols:4,rows:4,closeU:'yes' as never})).toThrow('boolean');
 });
});

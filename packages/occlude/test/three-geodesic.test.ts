import {describe,it,expect} from 'vitest';
import {geodesic,type Mesh} from '../src/three/api/index.js';
import {cross3,dot3,sub3} from '../src/three/math.js';

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

describe('geodesic polyhedra',()=>{
 it('divides every base face T ways, in all three classes',()=>{
  const pairs:readonly (readonly [number,number])[]=[[1,0],[2,0],[3,0],[1,1],[2,2],[3,3],[2,1],[3,1],[3,2],[4,3]];
  for(const [base,perFace] of [['icosahedron',20],['octahedron',8],['tetrahedron',4]] as const)
    for(const [m,n] of pairs){
      const T=m*m+m*n+n*n,dome=geodesic(1,{base,frequency:[m,n]});
      expect({base,m,n,faces:dome.faces.length}).toEqual({base,m,n,faces:perFace*T});
      expect(dome.points.length).toBe(perFace*T/2+2);
      expect(dome.faces.every(f=>f.vertices.length===3)).toBe(true);
      manifold(dome,2);
    }
  // A plain number is the class I pair [m, 0], and the default is [2, 0]:
  // what an icosphere is.
  expect(geodesic(1,{frequency:3}).faces.length).toBe(geodesic(1,{frequency:[3,0]}).faces.length);
  expect(geodesic().faces.length).toBe(80);
  // The mirror pair is the same count, the other hand.
  expect(geodesic(1,{frequency:[1,2]}).faces.length).toBe(140);
 });
 it('puts every point on the sphere and keeps no two of them in one place',()=>{
  const dome=geodesic(2.5,{frequency:4});
  for(const p of dome.points)expect(Math.hypot(p.x,p.y,p.z)).toBeCloseTo(2.5,12);
  const places=new Set(dome.points.map(p=>[p.x,p.y,p.z].map(n=>n.toFixed(9)).join(',')));
  expect(places.size).toBe(dome.points.length);
 });
 it('keeps the flat solid when it is asked not to project',()=>{
  const flat=geodesic(1,{frequency:3,base:'tetrahedron',project:false});
  expect(flat.faces.length).toBe(36);
  manifold(flat,2);
  const planes=geodesic(1,{frequency:1,base:'tetrahedron'}).faces.map(f=>({normal:f.normal,d:dot3(f.normal,f.centroid)}));
  for(const p of flat.points)expect(planes.some(plane=>Math.abs(dot3(plane.normal,[p.x,p.y,p.z])-plane.d)<1e-9)).toBe(true);
  for(const p of geodesic(1,{frequency:3,base:'tetrahedron'}).points)expect(Math.hypot(p.x,p.y,p.z)).toBeCloseTo(1,12);
 });
 it('carries a spherical chart that does not fold back at the meridian',()=>{
  const dome=geodesic(1,{frequency:3});
  for(const face of dome.surface.faces){
    const uv=face.corners!.map(c=>c.attributes.uv as readonly [number,number]);
    expect(uv.every(p=>p.every(Number.isFinite))).toBe(true);
    // Every corner is unwrapped within half a turn of the first, so a chart
    // never runs backwards across the whole meridian. A triangle over a pole
    // still spreads, which is what a spherical chart does there.
    expect(uv.every(p=>Math.abs(p[0]-uv[0][0])<=.5+1e-12)).toBe(true);
    expect(uv.every(p=>p[1]>=0&&p[1]<=1)).toBe(true);
    expect(face.corners!.every(c=>c.attributes.chart==='geodesic')).toBe(true);
  }
 });
 it('is the same mesh every time it is built',()=>{
  const a=geodesic(1.5,{base:'octahedron',frequency:3}),b=geodesic(1.5,{base:'octahedron',frequency:3});
  expect(a.points.map(p=>[p.x,p.y,p.z])).toEqual(b.points.map(p=>[p.x,p.y,p.z]));
  expect(a.faces.map(f=>f.vertices)).toEqual(b.faces.map(f=>f.vertices));
 });
 it('draws nothing without a radius and names every real mistake',()=>{
  for(const make of [()=>geodesic(0),()=>geodesic(-1,{frequency:3})])expect(make().surface.faces.length).toBe(0);
  expect(()=>geodesic(1,{frequency:0})).toThrow('integer of 1 or more');
  expect(()=>geodesic(1,{frequency:2.5})).toThrow('integer of 1 or more');
  expect(()=>geodesic(1,{frequency:200})).toThrow('budget');
  expect(()=>geodesic(1,{base:'cube' as never})).toThrow('icosahedron');
 });
});

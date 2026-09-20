import {readFileSync} from 'node:fs';
import {beforeAll,describe,it,expect} from 'vitest';
import {initOcclude,sketch,compileSketchAsync,render,pen,mm} from '../src/index.js';
import {sdf3,isosurface,view,orthographic,type Mesh} from '../src/three/api/index.js';
import {cross3,dot3,sub3} from '../src/three/math.js';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));

/** The primitive catalog's own closed-surface test: two faces on every edge,
 * the expected Euler characteristic, opposed winding across every edge, no
 * degenerate triangle, and a positive enclosed volume (outward winding). */
function manifold(s:Mesh,chi:number){
  expect(s.surface.edges.every(e=>e.faces.length===2)).toBe(true);
  expect(s.points.length-s.edges.length+s.faces.length).toBe(chi);
  const directions=new Map<string,number>();
  for(const f of s.surface.faces)for(let i=0;i<f.vertices.length;i++){const a=f.vertices[i],b=f.vertices[(i+1)%f.vertices.length],key=[Math.min(a,b),Math.max(a,b)].join(':');directions.set(key,(directions.get(key)??0)+(a<b?1:-1));}
  expect([...directions.values()].every(n=>n===0)).toBe(true);
  let volume=0;for(const t of s.surface.triangles){const [a,b,c]=t.vertices.map(i=>s.surface.points[i].position);expect(Math.hypot(...cross3(sub3(b,a),sub3(c,a)))).toBeGreaterThan(0);volume+=dot3(a,cross3(b,c))/6;}
  expect(volume).toBeGreaterThan(0);
  return volume;
}
/** Connected pieces, by the faces that share a point. */
function components(s:Mesh):number{
  const parent=s.points.map((_,i)=>i);
  const root=(i:number):number=>{while(parent[i]!==i)i=parent[i]=parent[parent[i]];return i;};
  for(const f of s.surface.faces)for(const v of f.vertices){const a=root(f.vertices[0]),b=root(v);if(a!==b)parent[a]=b;}
  return new Set(s.points.map((_,i)=>root(i))).size;
}
const cube=(half:number):[readonly [number,number,number],readonly [number,number,number]]=>[[-half,-half,-half],[half,half,half]];

describe('sdf3, the distance algebra in space',()=>{
 it('is positive inside, exact on its primitives, and identical to the 2D algebra in shape',()=>{
  // The sign is the one `distanceTo` and `sdf` use: inside is positive.
  expect(sdf3.sphere(1)(0,0,0)).toBe(1);expect(sdf3.sphere(1)(1,0,0)).toBe(0);expect(sdf3.sphere(1)(3,0,0)).toBe(-2);
  expect(sdf3.sphere(1,[2,0,0])(2,0,0)).toBe(1);
  expect(sdf3.box(2)(0,0,0)).toBe(1);expect(sdf3.box([2,4,6])(0,0,0)).toBe(1);
  expect(sdf3.box(2)(2,2,2)).toBeCloseTo(-Math.sqrt(3),12);expect(sdf3.box(2)(0,0,2)).toBe(-1);
  expect(sdf3.capsule([-1,0,0],[1,0,0],.5)(0,0,0)).toBe(.5);
  expect(sdf3.capsule([-1,0,0],[1,0,0],.5)(2,0,0)).toBeCloseTo(-.5,12);
  expect(sdf3.torus(1,.25)(1,0,0)).toBe(.25);expect(sdf3.torus(1,.25)(0,0,0)).toBeCloseTo(-.75,12);
  // The normal points OUT of the solid, so the half space below it is inside.
  expect(sdf3.plane([0,0,2],1)(0,0,0)).toBe(1);expect(sdf3.plane([0,0,1],1)(0,0,3)).toBe(-2);
  expect(sdf3.plane([0,0,0])(0,0,0)).toBe(-Infinity);
 });
 it('combines fields with the same identities and refusals as the 2D algebra',()=>{
  const a=sdf3.sphere(1,[-.5,0,0]),b=sdf3.sphere(1,[.5,0,0]);
  expect(sdf3.union()( 0,0,0)).toBe(-Infinity);expect(sdf3.intersect()(0,0,0)).toBe(Infinity);
  expect(sdf3.union(a,b)(1.4,0,0)).toBeCloseTo(.1,12);expect(sdf3.intersect(a,b)(1.4,0,0)).toBeCloseTo(-.9,12);
  expect(sdf3.subtract(a,b)(-1.4,0,0)).toBeCloseTo(.1,12);expect(sdf3.subtract(a,b)(0,0,0)).toBeLessThan(0);
  // A fillet only ever adds material, and only near the joint.
  for(const p of [[0,.9,0],[0,0,.9],[1.2,0,0]] as const)expect(sdf3.blend(a,b,.3)(p[0],p[1],p[2])).toBeGreaterThanOrEqual(sdf3.union(a,b)(p[0],p[1],p[2])-1e-12);
  expect(sdf3.blend(a,b,0)(0,.9,0)).toBe(sdf3.union(a,b)(0,.9,0));
  expect(sdf3.translate(sdf3.sphere(1),[3,0,0])(3,0,0)).toBe(1);
  expect(sdf3.repeat(sdf3.sphere(.25),2)(4,0,0)).toBe(.25);expect(sdf3.repeat(sdf3.sphere(.25),2)(1,0,0)).toBeCloseTo(-.75,12);
  for(const make of [()=>sdf3.union(3 as never),()=>sdf3.subtract(3 as never),()=>sdf3.blend(sdf3.sphere(1),null as never,1)])expect(make).toThrow('function of (x, y, z)');
 });
});

describe('isosurface, the field made a mesh',()=>{
 it('closes a sphere on the grid, with every point on the radius and the volume it should have',()=>{
  const cells=24,span=3,size=span/cells;
  const ball=isosurface(sdf3.sphere(1),{bounds:cube(1.5),resolution:cells});
  const volume=manifold(ball,2);
  expect(components(ball)).toBe(1);
  for(const p of ball.points)expect(Math.abs(Math.hypot(p.x,p.y,p.z)-1)).toBeLessThan(size);
  expect(volume).toBeCloseTo(4*Math.PI/3,1);
  // The same field at the same resolution is the same mesh, point for point.
  const again=isosurface(sdf3.sphere(1),{bounds:cube(1.5),resolution:cells});
  expect(again.points.map(p=>[p.x,p.y,p.z])).toEqual(ball.points.map(p=>[p.x,p.y,p.z]));
  expect(again.surface.faces.map(f=>f.vertices)).toEqual(ball.surface.faces.map(f=>f.vertices));
 });
 it('joins a union into one closed piece and keeps a smoothed surface closed',()=>{
  const pair=sdf3.union(sdf3.sphere(.8,[-.5,0,0]),sdf3.sphere(.8,[.5,0,0]));
  const welded=isosurface(pair,{bounds:[[-1.7,-1.2,-1.2],[1.7,1.2,1.2]],resolution:28});
  manifold(welded,2);expect(components(welded)).toBe(1);
  const eased=isosurface(pair,{bounds:[[-1.7,-1.2,-1.2],[1.7,1.2,1.2]],resolution:28,smooth:3});
  manifold(eased,2);
  expect(eased.surface.faces.map(f=>f.vertices)).toEqual(welded.surface.faces.map(f=>f.vertices));
  // Laplacian passes move the points and pull the surface in a little.
  expect(eased.points.map(p=>[p.x,p.y,p.z])).not.toEqual(welded.points.map(p=>[p.x,p.y,p.z]));
 });
 it('changes the genus when a solid is cut through, and counts the pieces a lattice makes',()=>{
  // A box with a tunnel bored through it is genus one: chi = 2 - 2g = 0.
  const bored=isosurface(sdf3.subtract(sdf3.box(2),sdf3.capsule([0,0,-3],[0,0,3],.5)),{bounds:cube(1.5),resolution:24});
  manifold(bored,0);expect(components(bored)).toBe(1);
  // A hollow ring is genus one too, and it reads the three counts itself.
  const ring=isosurface(sdf3.torus(1,.35),{bounds:[[-1.6,-1.6,-.6],[1.6,1.6,.6]],resolution:[32,32,12]});
  manifold(ring,0);expect(components(ring)).toBe(1);
  // Repetition folds space: twenty-seven balls on the lattice inside the box.
  const balls=isosurface(sdf3.repeat(sdf3.sphere(.25),1),{bounds:cube(1.5),resolution:36});
  manifold(balls,2*27);expect(components(balls)).toBe(27);
 });
 it('draws nothing for a degenerate box, and refuses a resolution it cannot answer',()=>{
  for(const make of [
    ()=>isosurface(sdf3.sphere(1),{bounds:[[0,0,0],[0,0,0]],resolution:8}),
    ()=>isosurface(sdf3.sphere(1),{bounds:[[1,1,1],[-1,-1,-1]],resolution:8}),
    ()=>isosurface(sdf3.sphere(1),{bounds:cube(1.5),resolution:0}),
    // Nowhere inside, and a field that answers with nothing at all, each draw nothing.
    ()=>isosurface(sdf3.union(),{bounds:cube(1.5),resolution:8}),
    ()=>isosurface((()=>Number.NaN) as never,{bounds:cube(1.5),resolution:8}),
    ()=>isosurface(sdf3.sphere(9),{bounds:cube(1.5),resolution:8}),
  ])expect(make().surface.faces.length).toBe(0);
  expect(()=>isosurface(sdf3.sphere(1),{bounds:cube(1.5),resolution:8.5})).toThrow('integer');
  expect(()=>isosurface(sdf3.sphere(1),{bounds:cube(1.5),resolution:200})).toThrow('budget');
  expect(()=>isosurface(null as never,{bounds:cube(1.5),resolution:8})).toThrow('function of (x, y, z)');
  expect(()=>isosurface(sdf3.sphere(1),{bounds:[[0,0,0]] as never,resolution:8})).toThrow('bounds');
 });
 it('goes through view and draws',async()=>{
  const solid=isosurface(sdf3.blend(sdf3.sphere(.9,[-.5,0,0]),sdf3.sphere(.9,[.5,0,0]),.4),{bounds:[[-1.8,-1.2,-1.2],[1.8,1.2,1.2]],resolution:24});
  const drawing=view(solid,{camera:orthographic({eye:[5,7,6],span:5}),stroke:'ink',creaseAngle:180});
  expect(drawing.scene.objects.length).toBe(1);
  const execution=await compileSketchAsync(sketch({seed:42,margin:0,pens:{ink:pen({width:mm(.25),color:'#112233'})}},()=>drawing));
  expect(render(execution).raw.frags.length).toBeGreaterThan(0);
 });
});

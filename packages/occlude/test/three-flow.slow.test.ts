import {readFileSync} from 'node:fs';
import {beforeAll,describe,it,expect} from 'vitest';
import {initOcclude,sketchAsync,compileSketchAsync,pen,mm} from '../src/index.js';
import {sphere,box,cylinder,view,orthographic,curl3,grad3,type Vec3} from 'occlude/3d';
import {streamlines3} from '../src/three/api/flow.js';
const env={rnd:()=>0.5};
const stream=()=>{let state=1;return ()=>{state=(state*1103515245+12345)%2147483648;return state/2147483648;};};
const points=(curve:{surface:{points:readonly {position:Vec3}[]}}):Vec3[]=>curve.surface.points.map(p=>p.position);

describe('streamlines of a 3D field',()=>{
 it('follows a uniform field in a straight line',()=>{
  const lines=streamlines3(()=>[0,0,1],{seeds:[[0,0,0]],step:.1,maxLength:4},env);
  expect(lines.length).toBe(1);
  const path=points(lines[0]);
  expect(path.length).toBeGreaterThan(30);
  for(const p of path){expect(Math.abs(p[0])).toBeLessThan(1e-9);expect(Math.abs(p[1])).toBeLessThan(1e-9);}
  // maxLength is the reach in each direction from the seed, as in 2D.
  const z=path.map(p=>p[2]);
  expect(Math.max(...z)-Math.min(...z)).toBeCloseTo(8,6);
 });
 it('comes back to where it started in a vortex',()=>{
  // A circle about Z: the line closes on itself, so its ends nearly meet.
  const lines=streamlines3(p=>[-p[1],p[0],0],{seeds:[[1,0,0]],spacing:.1,step:.02,maxLength:20},env);
  const path=points(lines[0]);
  for(const p of path)expect(Math.hypot(p[0],p[1])).toBeCloseTo(1,3);
  // The two halves stop when they meet, so the ends sit about one spacing
  // apart rather than on top of each other.
  expect(Math.hypot(...path[0].map((n,i)=>n-path.at(-1)![i]))).toBeLessThan(.15);
  expect(path.length).toBeGreaterThan(250);
 });
 it('keeps every line a spacing apart',()=>{
  const seeds:Vec3[]=[];for(let i=-10;i<=10;i++)seeds.push([i*.05,0,0]);
  const lines=streamlines3(()=>[0,0,1],{seeds,spacing:.2,maxLength:2},env);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.length).toBeLessThan(seeds.length);
  const all=lines.flatMap((l,i)=>points(l).map(p=>({p,i})));
  for(const a of all)for(const b of all)if(a.i!==b.i)
    expect(Math.hypot(...a.p.map((n,k)=>n-b.p[k]))).toBeGreaterThan(.09);
 });
 it('cuts a line to the inside of a closed mesh',()=>{
  const ball=sphere(1,{segments:48,rings:24});
  const lines=streamlines3(()=>[0,0,1],{seeds:[[0,0,-3]],step:.02,maxLength:6,within:ball},env);
  expect(lines.length).toBe(1);
  const path=points(lines[0]);
  for(const p of path)expect(Math.hypot(...p)).toBeLessThan(1.01);
  // The ends are the wall, interpolated, not the last step before it.
  for(const end of [path[0],path.at(-1)!])expect(Math.hypot(...end)).toBeCloseTo(1,2);
  // Two runs where the path leaves and comes back.
  const twice=streamlines3(()=>[0,0,1],{seeds:[[0,0,-3]],step:.02,maxLength:12,within:box(1).translate([0,0,2])},env);
  expect(twice.length).toBeGreaterThanOrEqual(1);
 });
 it('draws nothing for a field, a spacing or a mesh it cannot use',()=>{
  const seeds:Vec3[]=[[0,0,0]];
  expect(streamlines3(()=>[0,0,0],{seeds},env).length).toBe(0);
  expect(streamlines3(()=>[Number.NaN,0,0],{seeds},env).length).toBe(0);
  expect(streamlines3(()=>[0,0,1],{seeds,spacing:0},env).length).toBe(0);
  expect(streamlines3(()=>[0,0,1],{seeds,step:-1},env).length).toBe(0);
  // An open mesh has no inside to cut to.
  expect(streamlines3(()=>[0,0,1],{seeds,within:box(2)},env).length).toBe(1);
  expect(streamlines3(()=>[0,0,1],{seeds,within:cylinder(1,2,{caps:false})},env).length).toBe(0);
  expect(()=>streamlines3(undefined as never,{seeds},env)).toThrow('vector field');
  expect(()=>streamlines3(()=>[0,0,1],{seeds:{count:1.5,within:box(1)}},env)).toThrow('integer');
 });
 it('throws a count of seeds into a mesh with the sketch stream',()=>{
  const inside=streamlines3(()=>[0,0,1],{seeds:{count:12,within:sphere(1)},step:.1,maxLength:1},{rnd:stream()});
  expect(inside.length).toBe(12);
  for(const line of inside)for(const p of points(line))expect(Math.hypot(p[0],p[1])).toBeLessThan(1.01);
 });
});

describe('curl and gradient of a 3D field',()=>{
 it('reads the slope of a scalar field',()=>{
  const g=grad3(p=>p[0]*p[0]+2*p[1]);
  expect(g([1,0,0])[0]).toBeCloseTo(2,6);
  expect(g([1,0,0])[1]).toBeCloseTo(2,6);
  expect(g([1,0,0])[2]).toBeCloseTo(0,6);
  // A field with no value there has no slope: zero, not NaN.
  expect(grad3(()=>Number.NaN)([0,0,0])).toEqual([0,0,0]);
 });
 it('reads the turn of a vector field',()=>{
  const c=curl3(p=>[-p[1],p[0],0]);
  const value=c([0.3,-0.2,1]);
  expect(value[0]).toBeCloseTo(0,5);expect(value[1]).toBeCloseTo(0,5);expect(value[2]).toBeCloseTo(2,5);
  // The curl of a gradient is zero: the identity that makes it a flow word.
  const none=curl3(grad3(p=>p[0]*p[1]+p[2]*p[2]))([.5,.5,.5]);
  expect(Math.hypot(...none)).toBeLessThan(1e-3);
 });
});

describe('streamlines3 on the toolkit',()=>{
 beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
 it('is seeded by the sketch and drawn through a view',async()=>{
  const config={seed:42,margin:0,pens:{ink:pen({width:mm(.25),color:'#112233'})}};
  const run=async()=>{
    let count=0;
    const execution=await compileSketchAsync(sketchAsync(config,async t=>{
      const flow=t.streamlines3(curl3(p=>[0,0,Math.sin(p[0])*Math.cos(p[1])]),{seeds:{count:8,within:sphere(1.2)},spacing:.15,step:.04,maxLength:6,key:'flow'});
      count=flow.length;
      return view([...flow,box(.4).translate([0,0,1.4])],{camera:orthographic({eye:[4,6,3],span:5}),stroke:'ink'});
    }));
    return {count,execution};
  };
  const a=await run(),b=await run();
  expect(a.count).toBeGreaterThan(0);
  expect(b.count).toBe(a.count);
 });
});

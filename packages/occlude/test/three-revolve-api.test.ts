import {beforeAll,describe,it,expect,expectTypeOf} from 'vitest';
import {readFileSync} from 'node:fs';
import {polyline,circle,box,revolve,query,view,orthographic,perspective} from 'occlude/3d';
import {initOcclude,sketch,compileSketchAsync,commitCamera3,exportSvg,pen,mm} from '../src/index.js';
import {cross3,dot3} from '../src/three/math.js';
import type {Mesh} from 'occlude/3d';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
function volume(mesh:Mesh<any,any,any>){return mesh.surface.triangles.reduce((sum,t)=>{const [a,b,c]=t.vertices.map(i=>mesh.surface.points[i].position);return sum+dot3(a,cross3(b,c))/6;},0);}
function manifold(mesh:Mesh<any,any,any>){expect(mesh.edges.length).toBeGreaterThan(0);expect(mesh.surface.edges.every(e=>e.faces.length===2)).toBe(true);for(const edge of mesh.edges)expect(edge.length).toBeGreaterThan(0);}
describe('curve-profile revolution',()=>{
 it('shares full seams and poles with independent polygonal cone volume and normals',()=>{
  const n=12,r=2,h=3,profile=polyline([[0,0,0],[r,0,0],[0,0,h]]).attribute('weight',p=>p.index+1).edgeAttribute('part',e=>e.index===0?'base':'side');
  const solid=revolve(profile,{segments:n});manifold(solid);
  expect(solid.points.length).toBe(n+2);expect(solid.faces.length).toBe(2*n);expect(volume(solid)).toBeCloseTo(n*r*r*Math.sin(2*Math.PI/n)*h/6,12);
  expect(solid.points.filter(p=>p.x===0&&p.y===0).length).toBe(2);
  expect(solid.points.filter(p=>p.weight===2).length).toBe(n);expectTypeOf(solid.points.at(0)!.weight).toEqualTypeOf<number>();
  for(const face of solid.faces){expect(face.provenance!.parents.length).toBe(1);if(face.part==='base')expect(face.normal[2]).toBe(-1);else expect(face.normal[2]).toBeGreaterThan(0);}
  expect(solid.surface).toEqual(revolve(profile,{segments:n}).surface);
  const negative=revolve(profile,{segments:n,angle:-360});manifold(negative);expect(volume(negative)).toBeCloseTo(volume(solid),12);
 });
 it('makes open-ended vessels without automatically sealing profile boundaries',()=>{
  const vessel=revolve(polyline([[0,0,0],[1,0,0],[1,0,2]]),{segments:16});
  expect(vessel.surface.edges.filter(e=>e.faces.length===1).length).toBe(16);
  const target=query(vessel);expect(target.ray([0,0,3],[0,0,-2])!.distance).toBeCloseTo(3,12);expect(target.ray([0,0,3],[0,0,-2])!.t).toBeCloseTo(1.5,12);
  expect(vessel.faces.filter(f=>f.normal[2]>.99).length).toBe(0);
  expect(profileUnchanged()).toEqual([[0,0,0],[1,0,0],[1,0,2]]);
  function profileUnchanged(){const p=polyline([[0,0,0],[1,0,0],[1,0,2]]);revolve(p);return p.points.map(p=>[p.x,p.y,p.z]);}
 });
 it('caps partial closed profiles with correct winding and signed-angle symmetry',()=>{
  const profile=polyline([[1,0,-1],[1,0,1],[0,0,1],[0,0,-1]],{closed:true}).edgeAttribute('tag',7);
  const n=8,angle=120,sector=revolve(profile,{segments:n,angle,caps:true});manifold(sector);
  expect(volume(sector)).toBeCloseTo(n*Math.sin(angle*Math.PI/180/n),12);
  const caps=sector.faces.filter(f=>f.tag===undefined);expect(caps.length).toBe(2);
  expect(caps.at(0)!.normal[1]).toBeCloseTo(-1,12);
  expect(()=>revolve(profile,{segments:n,angle,caps:true,maxCapPoints:3})).toThrow('cap point budget');
  const open=revolve(profile,{segments:n,angle});expect(open.surface.edges.some(e=>e.faces.length===1)).toBe(true);
  const negative=revolve(profile,{segments:n,angle:-angle,caps:true});manifold(negative);expect(volume(negative)).toBeCloseTo(volume(sector),12);
 });
 it('accepts transformed circle profiles and keeps ordinary downstream mesh capabilities',()=>{
  const profile=circle(.25,{segments:12}).rotate([90,0,0]).translate([1,0,0]).attribute('gain',.1).edgeAttribute('label','tube').withKey('donut');
  const solid=revolve(profile,{segments:24});manifold(solid);expect(solid.points.length).toBe(288);expect(solid.faces.length).toBe(288);expect(solid.key).toBe('donut');
  expect(volume(solid)).toBeGreaterThan(0);expect(solid.faces.map(f=>f.label)).toEqual(Array(288).fill('tube'));
  const edited=solid.subdivide().displace(p=>[0,0,p.gain]).faceAttribute('up',f=>f.normal[2]>0).steps(1,(current,next)=>next.move(current.points,[0,0,.2]));
  manifold(edited);expect(edited.faces.length).toBeGreaterThan(solid.faces.length);expect(volume(edited)).toBeCloseTo(volume(solid),10);expect(edited.points.at(0)!.z).toBeCloseTo(solid.points.at(0)!.z+.3,12);expect(query(edited).nearest([2,0,0])).not.toBeNull();
 });
 it('rejects branches, disconnected paths, invalid meridians, pinch points and oversized results',()=>{
  expect(()=>revolve(box().edges.extract())).toThrow('unbranched');
  const disconnected=polyline([[1,0,0],[1,0,1],[1,0,2],[1,0,3]]).edges.filter(e=>e.index!==1).extract();expect(()=>revolve(disconnected)).toThrow('connected');
  expect(()=>revolve(polyline([[-1,0,0],[1,0,1]]))).toThrow('XZ');
  expect(()=>revolve(polyline([[1,1,0],[1,1,1]]))).toThrow('XZ');
  expect(()=>revolve(polyline([[1,1,1e12],[1,1,1e12+1]]))).toThrow('XZ');
  expect(()=>revolve(polyline([[1,0,0],[0,0,1],[1,0,2]]))).toThrow('pinched');
  expect(()=>revolve(polyline([[0,0,0],[0,0,1]]))).toThrow('entirely');
  const profile=polyline([[1,0,0],[1,0,1]]);
  expect(()=>revolve(profile,{segments:2})).toThrow('smaller than 180');expect(()=>revolve(profile,{angle:0})).toThrow('angle');
  expect(()=>revolve(profile,{angle:90,caps:true})).toThrow('closed profile');
  expect(()=>revolve(profile,{maxPoints:10})).toThrow('points budget');expect(()=>revolve(profile,{maxFaces:10})).toThrow('faces budget');
  expect(()=>revolve(profile,{segments:1e9,maxPoints:1_000_000})).toThrow('budget');
 });
 it('retains revolved mesh and selective hatch across camera-only commits',async()=>{
  let models=0;
  const definition=sketch({seed:42,pens:{ink:pen({width:mm(.3)})}},()=>{models++;return view(revolve(polyline([[0,0,-1],[1,0,-1],[.5,0,1]])),{camera:orthographic({eye:[5,7,6],span:5}),hatch:{spacing:mm(3),select:f=>f.normal[2]>0}});});
  const result=await compileSketchAsync(definition),before=exportSvg(result),id=[...result.scenes3.keys()][0];
  const changed=await commitCamera3(result,id,perspective({eye:[5,7,6]}));expect(models).toBe(1);expect(exportSvg(result)).toBe(before);expect(exportSvg(changed)).not.toBe(before);
 });
});

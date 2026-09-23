import {describe,it,expect} from 'vitest';
import {axisAngle,alignAxis,pointCloud,box,instanceOnPoints,curve,type Rotation} from 'occlude/3d';
import {rotation3,rotateVector3} from '../src/three/rotation.js';
import type {Vec3} from '../src/three/math.js';
function near(actual:Vec3,wanted:Vec3,precision=12){actual.forEach((v,i)=>expect(v).toBeCloseTo(wanted[i],precision));}
describe('rotation values and alignment',()=>{
 it('uses right-handed degrees, explicit composition order and inverse',()=>{
   const z=axisAngle('z',90),x=axisAngle('x',90);
   near(z.apply([1,0,0]),[0,1,0]);near(z.then(x).apply([1,0,0]),[0,0,1]);
   near(x.then(z).apply([1,0,0]),[0,1,0]);
   near(z.then(x).inverse().apply(z.then(x).apply([2,-3,4])),[2,-3,4]);
   expect(Object.isFrozen(z.quaternion)).toBe(true);
   near(rotation3(JSON.parse(JSON.stringify(z))).apply([1,0,0]),[0,1,0]);
 });
 it('aligns parallel, antiparallel, oblique and near-antiparallel directions',()=>{
   for(const n of [[0,0,1],[0,0,-1],[1,0,0],[0,1,0],[3,4,0],[1e-10,0,-1]] as Vec3[]){
     const unit=n.map(v=>v/Math.hypot(...n)) as unknown as Vec3;
     near(alignAxis('z',n).apply([0,0,1]),unit);
   }
   expect(alignAxis('z',[1e-320,0,-1]).apply([0,0,1])[0]).toBeGreaterThan(0);
   near(alignAxis([3,4,0],[0,0,2]).apply([.6,.8,0]),[0,0,1]);
   near(alignAxis('z',{x:1e308,y:1e308,z:0}).apply([0,0,1]),[Math.SQRT1_2,Math.SQRT1_2,0]);
 });
 it('constrains roll with paired references and then applies world-axis twist',()=>{
   const r=alignAxis('z',[1,0,0],{localUp:[0,1,0],up:[0,0,1]});
   near(r.apply([0,0,1]),[1,0,0]);near(r.apply([0,1,0]),[0,0,1]);
   const twisted=alignAxis('z',[1,0,0],{localUp:[0,1,0],up:[0,0,1],twist:90});
   near(twisted.apply([0,0,1]),[1,0,0]);near(twisted.apply([0,1,0]),[0,-1,0]);
 });
 it('does not switch roll when the target crosses coordinate-axis boundaries',()=>{
   let previous:Vec3|undefined;
   for(let i=0;i<=400;i++){
     const a=i*Math.PI/200,n:Vec3=[Math.cos(a),Math.sin(a),.5],x=alignAxis('z',n).apply([1,0,0]);
     if(previous)expect(Math.hypot(...x.map((v,j)=>v-previous![j]))).toBeLessThan(.04);
     previous=x;
   }
 });
 it('transports a frame smoothly through the antipodal direction',()=>{
   let r:Rotation=alignAxis('z',[0,0,1]),previous=r.apply([1,0,0]);
   for(let i=1;i<=400;i++){
     const a=i*Math.PI/200,n:Vec3=[Math.sin(a),0,Math.cos(a)];
     r=alignAxis('z',n,{previous:r});near(r.apply([0,0,1]),n);
     const x=r.apply([1,0,0]);expect(Math.hypot(...x.map((v,j)=>v-previous[j]))).toBeLessThan(.02);previous=x;
   }
   near(r.apply([1,0,0]),[1,0,0]);
 });
 it('rejects degenerate axes, references and ambiguous option combinations',()=>{
   // A vector that names no axis asks for no turn.
   expect(axisAngle([0,0,0],90).quaternion).toEqual([0,0,0,1]);
   expect(()=>axisAngle('z',NaN)).toThrow('finite degrees');
   expect(alignAxis('z',[0,0,0]).quaternion).toEqual([0,0,0,1]);
   expect(alignAxis('z',[0,0,1],{up:[0,0,1]}).quaternion).toEqual([0,0,0,1]);
   expect(alignAxis('z',[1,0,0],{up:[0,1,0],localUp:[0,0,2]}).apply([0,0,1])).toEqual(alignAxis('z',[1,0,0],{up:[0,1,0]}).apply([0,0,1]));
   expect(()=>alignAxis('z',[1,0,0],{localUp:[1,0,0]})).toThrow('requires');
   expect(()=>alignAxis('z',[1,0,0],{up:[0,1,0],previous:axisAngle('x',0)})).toThrow('either');
 });
 it('applies pivoted rotations to point, curve and mesh data and mirrored instances',()=>{
   const r=axisAngle('z',90),point=pointCloud([[2,0,0]]).rotate(r,[1,0,0]).points.at(0)!;
   near([point.x,point.y,point.z],[1,1,0]);
   const line=curve([[0,0,0],[1,0,0]]).rotate(r);near(line.surface.points[1].position,[0,1,0]);
   const prototype=box([2,4,6]),instances=instanceOnPoints(prototype,pointCloud([[10,0,0]]).points,{rotate:()=>r,scale:[-2,3,4]});
   expect(Array.isArray(instances.rows[0].transform.rotate)).toBe(false);
   const realized=instances.realize();
   prototype.surface.points.forEach((p,i)=>near(realized.surface.points[i].position,[10-p.position[1]*3,-p.position[0]*2,p.position[2]*4]));
   expect(realized.surface.faces[0].vertices).toEqual([...prototype.surface.faces[0].vertices].reverse());
   near(prototype.rotate(r).surface.points[0].position,[-prototype.surface.points[0].position[1],prototype.surface.points[0].position[0],prototype.surface.points[0].position[2]]);
 });
 it('agrees with legacy XYZ rotation without requiring Euler output',()=>{
   for(const angles of [[10,20,30],[0,90,40],[180,-90,240]] as Vec3[]){
     const composed=axisAngle('x',angles[0]).then(axisAngle('y',angles[1])).then(axisAngle('z',angles[2]));
     near(composed.apply([2,3,4]),rotateVector3([2,3,4],angles));
   }
 });
});

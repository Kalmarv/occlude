// A value in space carries its own origin, orientation and key as value
// fields (R2, cruft#5, promises#9): every write keeps them, a rigid move
// moves the origin, and a write of the points does not.
import {describe,expect,it} from 'vitest';
import {box,sphere,observer,axisAngle} from '../src/three/api/index.js';
import type {Material} from '../src/index.js';
import {toolkit} from './helpers/run.js';

const places=(m:Material)=>[...m.points].map(p=>[p.x,p.y,p.z]);
const middle=(m:Material)=>{const ps=places(m),n=ps.length;return [0,1,2].map(k=>ps.reduce((s,p)=>s+p[k]!,0)/n);};
const near=(a:ArrayLike<number>,b:ArrayLike<number>,eps=1e-9)=>a.length===b.length&&Array.from(a).every((v,i)=>Math.abs(v-b[i])<=eps);

describe('a value in space keeps its own frame through every write',()=>{
  const crate=box(1,{key:'crate'}).translate([5,0,0]).rotate('z',30);
  const kept=(m:Material)=>{
    expect(m.key).toBe('crate');
    expect(m.origin).toBe(crate.origin);
    expect(m.orientation).toBe(crate.orientation);
  };
  it('has a frame to keep',()=>{
    expect(crate.origin).toEqual([5,0,0]);
    expect(crate.orientation).toBeDefined();
  });
  it('points.add',()=>kept(crate.points.add({x:0,y:0,z:3})));
  it('extract of points, edges and faces',()=>{
    kept(crate.points.filter(p=>p.z>0).extract());
    kept(crate.edges.filter(e=>e.length>0).extract());
    kept(crate.faces.filter(f=>f.normal[2]>0.5).extract());
  });
  it('a column write on points, edges and faces',()=>{
    kept(crate.points.set('h',1));
    kept(crate.edges.set('w',2));
    kept(crate.faces.set('c',3));
  });
  it('split, move and remove',()=>{
    kept(crate.split(crate.edges.at(0)!));
    kept(crate.move([0,0,1],crate.points.at(0)!));
    kept(crate.points.remove(crate.points.at(0)!));
  });
  it('a derivation that keeps the value: subdivide',()=>kept(crate.subdivide(1)));
  it('every step of t.steps',()=>{
    const t=toolkit();
    kept(t.steps(1,crate,g=>g));
    kept(t.steps(3,crate,g=>g.points.set('h',p=>p.z)));
  });
});

describe('a rigid move moves the origin; a write of the points does not',()=>{
  it('a pair translate is the triple translate at z = 0, so the same rotate turns both alike',()=>{
    const pair=box(1).translate([5,0]),triple=box(1).translate([5,0,0]),record=box(1).translate({x:5,y:0});
    expect(pair.origin).toEqual([5,0,0]);
    expect(record.origin).toEqual([5,0,0]);
    expect(places(pair.rotate([0,0,90]))).toEqual(places(triple.rotate([0,0,90])));
    expect(places(record.rotate('z',90))).toEqual(places(triple.rotate('z',90)));
    // Turning in place: the box stays where the translate put it.
    expect(near(middle(pair.rotate([0,0,90])),[5,0,0])).toBe(true);
  });
  it('one number and two factors on a value in space are its 3D words',()=>{
    const b=box(1).translate([5,0,0]);
    expect(places(b.rotate(90))).toEqual(places(b.rotate('z',90)));
    expect(places(b.scale(2))).toEqual(places(b.scale([2,2,2])));
    expect(places(b.scale([2,3]))).toEqual(places(b.scale([2,3,1])));
    expect(b.scale([2,3]).origin).toEqual([5,0,0]);
  });
  it('rotate, scale and transform move the origin as they move the points',()=>{
    const b=box(1).translate([5,0,0]);
    expect(near(b.rotate('z',90,{origin:[0,0,0]}).origin!,[0,5,0])).toBe(true);
    expect(near(b.scale(2,{origin:[0,0,0]}).origin!,[10,0,0])).toBe(true);
    // A mirror is a negative scale: about its own origin it stays put.
    expect(b.scale([-1,1,1]).origin).toEqual([5,0,0]);
    const small=box(0.1).translate([0.2,0,0]),seen=observer([0.05,-0.08,0.1],[0.8,0,0]);
    expect(near(small.transform(seen).origin!,seen.point([0.2,0,0]))).toBe(true);
    // A turn is kept as the value's orientation.
    expect(near(b.rotate('z',90).orientation!.apply([1,0,0]),axisAngle('z',90).apply([1,0,0]))).toBe(true);
  });
  it('displace, points.set and move keep the pivot where it was',()=>{
    const b=box(1);
    const displaced=b.displace([5,0,0]),written=b.points.set('x',p=>p.x+5),moved=b.move([5,0,0]);
    for(const m of [displaced,written,moved]){
      expect(m.origin).toBe(b.origin);
      // Turned about the user origin, not about where the points went.
      expect(near(middle(m.rotate([0,0,90])),[0,5,0])).toBe(true);
    }
    const there=b.translate([5,0,0]).points.set('x',p=>p.x+1);
    expect(there.origin).toEqual([5,0,0]);
    expect(near(middle(there.rotate([0,0,90])),[5,1,0])).toBe(true);
  });
  it('a radial centre rides with a rigid move and with a write of the rows',()=>{
    const ball=sphere(1).translate([1,2,3]);
    expect(ball.radialCentre).toEqual([1,2,3]);
    expect(ball.points.add({x:0,y:0,z:0}).radialCentre).toEqual([1,2,3]);
    expect(ball.faces.set('k',1).radialCentre).toEqual([1,2,3]);
  });
});

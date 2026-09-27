/**
 * Stage F1a: display state leaves the 3D value, `source` in its natural
 * shape, `along` answers points, the one placement value in two dimensions,
 * `t.toPaper` in the run's space, and flat 3D refusing a curved chain; and
 * the 3D words: every value in space is a Material, a word that needs faces
 * refuses a value with none by name, and face rows measure on the fixed
 * triangles.
 */
import {readFileSync} from 'node:fs';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {beforeAll,describe,expect,it} from 'vitest';
import {sketch,pen,mm,space,circle,curve as chain,type Placement} from '../src/index.js';
import {compileSketchAsync,initOcclude} from '../src/host.js';
import {plane,box,sphere,curve,parametricCurve,sweep,revolve,honeycomb,observer,pointCloud,instanceOnPoints,view,orthographic,type Vec3} from 'occlude/3d';
import {isSpacePlacement,identity} from '../src/placement.js';
import {spaceOf} from '../src/space.js';
import {scatterSurface} from '../src/three/api/sampling.js';
import {Material} from '../src/material.js';
import {surfaceOf} from '../src/three/geometry/value.js';
import {faceGeometry3} from '../src/three/geometry/model.js';
import {grad} from '../src/three/api/vec.js';
import {toolkit} from './helpers/run.js';
import {sourceRow,sourceRows} from './helpers/source.js';

beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const rnd=(seed:number)=>()=>{seed=(seed*16807)%2147483647;return (seed-1)/2147483646;};

describe('source',()=>{
  it('subdivide: a face its parent face, a point its parent point or the points that make it',()=>{
    const flat=plane(2,2),fine=flat.subdivide(1);
    for(const f of fine.faces)expect(f.source).toBe(flat.faces.at(0));
    const kept=fine.points.filter(p=>flat.points.some(q=>q.x===p.x&&q.y===p.y));
    for(const p of kept)expect(sourceRow(flat.points,p)).toBeDefined();
    const middle=fine.points.find(p=>p.x===0&&p.y===0)!;
    expect(sourceRows(flat.points,middle).sort((a,b)=>a.index-b.index)).toEqual([...flat.points]);
    // A write or a move of the result keeps it.
    const moved=fine.points.set('h',1).displace([0,0,1]);
    expect(moved.faces.at(0)!.source).toBe(flat.faces.at(0));
    // A value no derivation made answers none.
    expect(flat.faces.at(0)!.source).toBeUndefined();
  });
  it('extrude: a wall the edge under it, a cap its own face; dual: a point its face',()=>{
    const sheet=plane(2,2).subdivide(1),raised=sheet.extrude(sheet.faces.rowsAt([0]),{distance:1});
    const edges=[...sheet.edges],walls=raised.faces.filter(f=>edges.some(e=>e===f.source));
    expect(walls.length).toBe(4);
    expect(raised.faces.filter(f=>f.source===sheet.faces.at(0)).length).toBe(1);
    const cube=box(1),d=cube.dual();
    for(const p of d.points)expect(sourceRow(cube.faces,p)).toBeDefined();
    for(const f of d.faces)expect(sourceRow(cube.points,f)).toBeDefined();
  });
  it('booleans: a face its face in either input',()=>{
    const a=box(2),b=box(2).translate([1,0,0]),u=a.union(b);
    const faces=[...a.faces,...b.faces];for(const f of u.faces)expect(faces.some(g=>g===f.source)).toBe(true);
  });
  it('a scatter on a surface: each point the face under it',()=>{
    const ball=sphere(1,{segments:8,rings:4}),dots=scatterSurface(ball,{count:12},{rnd:rnd(3)});
    for(const p of dots.points){expect(sourceRow(ball.faces,p)).toBeDefined();expect(p.source).toBe(ball.faces.at(p.sample.face.index));}
  });
  it('a lifted 2D chain: each point the 2D point it came from',()=>{
    // `curve` of a chain is the chain through those same points.
    const ring=chain([[0,0],[1,0],[1,1]]),again=curve(ring);
    expect([...again.points].every(p=>ring.points.has(p))).toBe(true);
    const tube=sweep(ring,parametricCurve(u=>[0,0,u],{segments:2}));
    const [across,alongPath]=tube.points.at(0)!.source as readonly any[];
    expect(ring.points.has(across)).toBe(true);expect(alongPath.z).toBe(0);
  });
});

describe('along answers points',()=>{
  it('as the 2D along: s, u, tangent and the edge under each point',()=>{
    const path=curve([[0,0,0],[2,0,0],[2,2,0]]).points.set('w',p=>p.index);
    const at=path.along({count:5});
    expect(at.points.length).toBe(5);
    expect(at.points.map(p=>p.s)).toEqual([0,1,2,3,4]);
    expect(at.points.map(p=>p.u)).toEqual([0,.25,.5,.75,1]);
    expect(at.points.at(1)!.tangent).toEqual([1,0,0]);
    expect(at.points.at(3)!.tangent).toEqual([0,1,0]);
    expect(at.points.at(1)!.w).toBeCloseTo(.5,12);
    expect(at.points.at(1)!.source).toBe(path.edges.at(0));
    expect(at.points.at(3)!.source).toBe(path.edges.at(1));
    // Points stand where instances go.
    expect(instanceOnPoints(box(.1),at).points.length).toBe(5);
    expect(path.resample({count:5}).points.at(3)!.source).toBe(path.edges.at(1));
  });
  it('length, along and resample measure in 3D',()=>{
    const c=curve([[0,0,0],[2,0,0],[2,2,1]]);
    expect(c.length).toBeCloseTo(2+Math.hypot(2,1),12);
    expect(c.along({count:5}).points.at(-1)!.z).toBeCloseTo(1,12);
    expect(c.resample({spacing:0.5}).edges.length).toBeGreaterThan(4);
  });
});

describe('the 3D words',()=>{
  it('every value in space is a Material',()=>{
    for(const made of [plane(1),box(1),sphere(1,{segments:6,rings:3}),curve([[0,0,0],[1,0,0]])])expect(made).toBeInstanceOf(Material);
  });
  it('refuses a face-only word on a value with no faces, by name',()=>{
    const wire=curve([[0,0,0],[1,0,0],[1,1,0]]);
    expect(()=>wire.subdivide()).toThrow('subdivide: this value has no faces');
    expect(()=>wire.dual()).toThrow('dual: this value has no faces');
    expect(()=>wire.union(wire)).toThrow('union: this value has no faces');
    expect(()=>box(1).union({} as never)).toThrow('union: the second value is not a mesh');
  });
  it('measures a face in space on its fixed triangles',()=>{
    const s=sphere(1,{segments:8,rings:4}),g=faceGeometry3(mesh3(s));
    s.faces.forEach((f,i)=>{expect(f.normal).toEqual(g.normals[i]);expect(f.area).toBe(g.areas[i]);expect(f.centroid).toEqual(g.centers[i]);});
    // An edge's middle is in space too.
    const e=box(2).edges.at(0)!;expect(e.center).toEqual([(e.a.x+e.b.x)/2,(e.a.y+e.b.y)/2,(e.a.z+e.b.z)/2]);
  });
  it('a field that cannot answer at a point leaves that point, and a wrong answer is refused by name',()=>{
    const cube=box(1),moved=cube.displace(p=>p.index===0?[Number.NaN,0,0]:[0,0,1]);
    expect(moved.points.at(0)!.z).toBe(cube.points.at(0)!.z);expect(moved.points.at(1)!.z).toBe(cube.points.at(1)!.z+1);
    expect(()=>cube.displace(()=>'up' as never)).toThrow('displace: the field answered');
    // An extrusion by a vector that is not finite leaves that region where it is.
    expect(cube.extrude(cube.faces.filter(f=>f.index===0),[Number.NaN,0,0]).faces.length).toBe(cube.faces.length);
  });
  it('refuses a surface to t.sample, and a planar question with a place in space, by name',()=>{
    const t=toolkit();
    expect(()=>t.sample(box(1),{count:4})).toThrow('t.sample: this value has faces, and t.sample walks curves — points on a surface are t.scatter(m, { count })');
    const flat=chain([[0,0],[10,0],[10,10]]);
    expect(()=>flat.points.near([0,0,0],{radius:5})).toThrow('points.near: this value is in the plane');
    expect(()=>flat.edges.near([0,0,0],{radius:5})).toThrow('edges.near: this value is in the plane');
    expect(flat.points.near([0,0],{radius:5}).length).toBe(1);
  });
  it('t.streamlines answers one value in both worlds, the seeds saying which',()=>{
    const t=toolkit(),inSpace=t.streamlines(((...a:number[])=>[0,0,1]) as never,{seeds:[[0,0,0],[1,0,0]],step:.05,maxLength:1} as never);
    expect(inSpace).toBeInstanceOf(Material);expect(inSpace.curves.length).toBe(2);expect(inSpace.points.at(0)!.z).toBeDefined();
    expect(t.streamlines((x:number,y:number,z:number)=>[0,0,1] as const,{seeds:pointCloud([[0,0,0]]),step:.05,maxLength:1}).curves.length).toBe(1);
    expect(t.streamlines((x:number,y:number)=>[1,0],{spacing:20})).toBeInstanceOf(Material);
    // The difference step is an option in space as in the plane.
    expect(()=>grad(((x:number,y:number,z:number)=>x) as never,0.5 as never)).toThrow('grad: the step is an option');
  });
});

describe('one placement value',()=>{
  it('a placement of space is Placement<Vec3>: point, then, inverse, orientation and its 4×4',()=>{
    const h=honeycomb(4,3,5,{depth:1}),place:Placement<Vec3>=h.placements[1],seen=observer([.1,0,0],[.5,.2,0]);
    expect(isSpacePlacement(place)).toBe(true);
    expect(place.m).toHaveLength(16);
    expect(place.orientation).toBe(-1);
    const p:Vec3=[.1,.2,.3],q=place.then(seen).point(p),r=seen.point(place.point(p));
    for(let k=0;k<3;k++)expect(q[k]).toBeCloseTo(r[k],12);
    const back=place.inverse().point(place.point(p));
    for(let k=0;k<3;k++)expect(back[k]).toBeCloseTo(p[k],12);
  });
  it('the two dimensions stay two kinds, refused by name',()=>{
    const plane2=identity(spaceOf({curvature:0}).model),place=honeycomb(4,3,5,{depth:1}).placements[1];
    expect(isSpacePlacement(plane2)).toBe(false);
    expect(()=>place.then(plane2 as never)).toThrow('cannot follow one of 3D space');
    expect(()=>plane2.then(place as never)).toThrow('cannot follow one of the plane');
    expect(()=>box(1).transform(plane2 as never)).toThrow('transform takes a placement of 3D space');
  });
});

describe('the frame',()=>{
  it('t.toPaper answers a material in the run\'s space',async()=>{
    let kind='';
    const drawing=view(box(1),{camera:orthographic({eye:[4,5,6],span:3}),pen:'ink'});
    await compileSketchAsync(sketch({aspect:[1,1],space:space.hyperbolic({radius:45}),pens:{ink:pen({width:mm(.25)})}},async t=>{
      kind=t.toPaper(drawing,{points:[[0,0,0],[.5,.5,.5]] as Vec3[]}).space!.kind;
      return drawing;
    }));
    expect(kind).toBe('hyperbolic');
  });
  it('sweep and revolve refuse a chain of a curved space by name',async()=>{
    const errors:string[]=[];
    await compileSketchAsync(sketch({aspect:[1,1],space:space.hyperbolic({radius:45})},t=>{
      const ring=t.material(circle(0,0,5));
      for(const f of [()=>sweep(ring,parametricCurve(u=>[0,0,u])),()=>revolve(ring)])try{f();}catch(e){errors.push(String(e));}
      return [];
    }));
    expect(errors).toHaveLength(2);
    for(const e of errors)expect(e).toContain('hyperbolic space, and 3D space is flat');
    // A flat chain lifts as before.
    expect(revolve(chain([[1,0],[1,5]])).points.length).toBeGreaterThan(0);
    expect(pointCloud([[0,0]]).points.length).toBe(1);
  });
});

import {describe,expect,it} from 'vitest';
import {plane,box,sphere,cylinder,mesh,polyline,pointCloud,instanceOnFaces,instanceOnPoints,isolines,v3,falloff,light,view,orthographic,axisAngle} from '../src/three/api/index.js';
import {lightTone3,lightRecipe3} from '../src/three/surface/tone.js';
import {sketch,sketchAsync,compileSketch,compileSketchAsync,material,pen,mm,strokes,isSketchAsync} from '../src/index.js';
import type {ProjectedLines} from '../src/three/api/projected.js';
import type {Vec3} from '../src/three/math.js';

const near=(a:readonly number[],b:readonly number[],eps=1e-9)=>a.every((v,i)=>Math.abs(v-b[i])<eps);
const centroid=(g:{readonly points:Iterable<{x:number;y:number;z:number}>}):Vec3=>{const rows=[...g.points];return rows.reduce<Vec3>((s,p)=>v3.add(s,[p.x,p.y,p.z]),[0,0,0]).map(v=>v/rows.length) as unknown as Vec3;};

describe('sketch functions',()=>{
  it('sketch() accepts an async function and the sync compiler refuses a promise',async()=>{
    const def=sketch({seed:1,pens:{ink:pen({width:mm(.2)})}},async()=>view(box(1),{camera:orthographic({eye:[0,0,10],target:[0,0,0],up:[0,1,0],span:4}),stroke:'ink'}));
    expect(isSketchAsync(def)).toBe(true);
    expect(()=>compileSketch(def)).toThrow('compileSketchAsync');
    const run=await compileSketchAsync(def);expect(run.scenes3.size).toBe(1);
    const thenable=sketch({seed:1},()=>Promise.resolve(null) as never);
    expect(()=>compileSketch(thenable)).toThrow('returned a promise');
  });
});

describe('projected curve shorthands and pens',()=>{
  it('kind/except select feature kinds and stroke rides on derived curves into the default drawing',async()=>{
    const sheet=plane(2,2).subdivide(2).displace(p=>p.x*.3);
    const rings=isolines(sheet,p=>p.z,{count:3,stroke:'red'});
    expect(rings.stroke).toBe('red');expect(rings.withStroke('blue').stroke).toBe('blue');
    let seen:ProjectedLines|undefined;
    const run=await compileSketchAsync(sketch({seed:1,pens:{ink:pen({width:mm(.2)}),red:pen({width:mm(.3),color:'#f00'})}},()=>view([sheet,rings],{camera:orthographic({eye:[0,0,10],target:[0,0,0],up:[0,1,0],span:4}),stroke:'ink'},lines=>{seen=lines;return [strokes(lines.visible.kind('isoline'),{stroke:'red'}),strokes(lines.visible.except('isoline'),{stroke:'ink'})];})));
    expect(seen).toBeDefined();
    const iso=seen!.visible.kind('isoline'),rest=seen!.visible.except('isoline');
    expect(iso.length).toBeGreaterThan(0);expect(rest.length).toBeGreaterThan(0);
    expect([...iso].every(c=>c.kinds.has('isoline'))&&[...rest].every(c=>!c.kinds.has('isoline'))).toBe(true);
    expect(iso.length+rest.length).toBe(seen!.visible.length);
    // The default drawing (no draw callback) puts stroke-tagged curves in their own pen.
    const plain=await compileSketchAsync(sketch({seed:1,pens:{ink:pen({width:mm(.2)}),red:pen({width:mm(.3),color:'#f00'})}},()=>view([sheet,rings],{camera:orthographic({eye:[0,0,10],target:[0,0,0],up:[0,1,0],span:4}),stroke:'ink'})));
    expect(plain.scenes3.size).toBe(1);
    void run;
  });
});

describe('isolines',()=>{
  it('take one of count, spacing or levels and read point coordinates and attributes on the row',()=>{
    const sheet=plane(2,2).subdivide(3).displace(p=>p.x).attributes({h:p=>p.z*2});
    const a=isolines(sheet,p=>p.z,{count:4}),b=isolines(sheet,'h',{spacing:.5}),c=isolines(sheet,c=>c.uv[0],{levels:[.5]});
    expect(a.edges.length).toBeGreaterThan(0);expect(b.edges.length).toBeGreaterThan(0);expect(c.edges.length).toBeGreaterThan(0);
    expect(()=>isolines(sheet,p=>p.z,{} as never)).toThrow('exactly one');
    expect(()=>isolines(sheet,p=>p.z,{count:2,spacing:1} as never)).toThrow('exactly one');
  });
});

describe('object origin and rotation',()=>{
  it('rotate pivots on the object origin, which translate carries along',()=>{
    const b=box(1).translate([5,0,0]);
    expect(near(b.origin,[5,0,0])).toBe(true);
    const turned=b.rotate([0,0,90]);
    // Turning in place: the centroid stays at the origin the box was carried to.
    const centroid1=centroid(turned);
    expect(near(centroid1,[5,0,0])).toBe(true);
    const world=b.rotate('z',90,{about:'world'});
    const c2=centroid(world);
    expect(near(c2,[0,5,0],1e-9)).toBe(true);
    const point=b.rotate('z',180,{about:[6,0,0]});
    const c3=centroid(point);
    expect(near(c3,[7,0,0])).toBe(true);
    // A rotation value with an explicit pivot still works.
    const c4=centroid(b.rotate(axisAngle('z',90),[0,0,0]));
    expect(near(c4,[0,5,0],1e-9)).toBe(true);
    expect(()=>b.rotate('z',Infinity)).toThrow('finite');
  });
  it('local rotation reads the axis in the accumulated orientation',()=>{
    const tilted=box(1).rotate('z',90);
    const localX=tilted.rotate('x',90,{local:true}),worldY=tilted.rotate('y',90);
    // After a 90° turn about z the object's x axis is world +y, so a local x turn equals a world y turn.
    const wy=[...worldY.points];
    expect([...localX.points].every((p,i)=>near([p.x,p.y,p.z],[wy[i].x,wy[i].y,wy[i].z],1e-9))).toBe(true);
    expect(near(localX.orientation.apply([1,0,0]),tilted.orientation.apply([1,0,0]),1e-9)).toBe(true);
  });
  it('scale pivots on the origin by default and accepts about',()=>{
    const b=box(1).translate([3,0,0]).scale(2);
    expect(Math.min(...b.points.map(p=>p.x))).toBeCloseTo(2);expect(Math.max(...b.points.map(p=>p.x))).toBeCloseTo(4);
    const w=box(1).translate([3,0,0]).scale(2,{about:'world'});
    expect(Math.min(...w.points.map(p=>p.x))).toBeCloseTo(5);
  });
});

describe('mesh editing shorthands',()=>{
  it('faces is a getter, displace takes a scalar along the normal, steps takes {move,set}',()=>{
    const s=sphere(1,{segments:8,rings:4});
    expect(s.faces.length).toBeGreaterThan(0);
    const puffed=s.displace(.5),radii=[...puffed.points].map(p=>Math.hypot(p.x,p.y,p.z));
    expect(Math.max(...radii.map(r=>Math.abs(r-1.5)))).toBeLessThan(.05);
    const lifted=plane(1,1).displace(2,{along:'z'});
    expect(lifted.points.every(p=>Math.abs(p.z-2)<1e-12)).toBe(true);
    const stepped=plane(1,1).steps(3,{move:_p=>[0,0,1]});
    expect(stepped.points.every(p=>Math.abs(p.z-3)<1e-12)).toBe(true);
    const set=plane(1,1).attributes({n:()=>0}).steps(2,{set:p=>({n:p.attributes.n+1}),move:p=>[0,0,p.attributes.n]});
    // set runs before move within a step: z climbs 0 then 1 → 1 total; n reaches 2.
    expect(set.points.every(p=>p.attributes.n===2&&Math.abs(p.z-1)<1e-12)).toBe(true);
    // Point and curve geometry take the same shorthand; a scalar has no normal to follow there.
    const line=polyline([[0,0,0],[1,0,0]]).steps(2,{move:p=>[0,0,p.x]});
    expect([...line.points].map(p=>p.z)).toEqual([0,2]);
    expect(()=>polyline([[0,0,0],[1,0,0]]).steps(1,{move:_p=>1})).toThrow('vertex normal');
    expect(()=>plane(1,1).steps(1,{})).toThrow('move field');
    expect([...pointCloud([[0,0,0]]).steps(1,{move:_p=>[1,1,1]}).points][0].x).toBe(1);
  });
  it('collections reduce numeric attributes and smooth averages neighbours',()=>{
    const sheet=plane(2,2).subdivide(2).attributes({h:p=>p.x>0?1:0});
    expect(sheet.points.sum('h')).toBeGreaterThan(0);expect(sheet.points.max('h')).toBe(1);expect(sheet.points.min('h')).toBe(0);
    expect(sheet.points.mean('h')).toBeCloseTo(sheet.points.sum('h')/sheet.points.length);
    const soft=sheet.smooth('h',{steps:4});
    expect(soft.points.max('h')).toBeLessThan(1);expect(soft.points.min('h')).toBeGreaterThan(0);
    expect(()=>sheet.smooth('nope')).toThrow("'nope'");
  });
  it('extrude accepts a plain distance',()=>{
    const sheet=plane(1,1),up=sheet.extrude(sheet.faces,.5);
    expect(Math.max(...up.points.map(p=>p.z))).toBeCloseTo(.5);
  });
});

describe('instances on faces',()=>{
  it('places one prototype per face at the centre, aligned to the normal',()=>{
    const cube=box(2),pins=instanceOnFaces(cylinder(.1,.5,{segments:6}),cube.faces,{offset:.25});
    expect(pins.instances.length).toBe(6);
    const realized=pins.realize();
    // Every pin's axis points outward: its points sit outside the cube's face plane on the normal side.
    expect(realized.points.every(p=>Math.max(Math.abs(p.x),Math.abs(p.y),Math.abs(p.z))>=1-1e-9)).toBe(true);
    expect(()=>instanceOnFaces(box(1),cube.points as never)).toThrow('face collection');
    const some=instanceOnFaces(box(.2),cube.faces.filter(f=>f.normal[2]>.5));
    expect(some.instances.length).toBe(1);
  });
});

describe('vector helpers and light floor',()=>{
  it('v3 takes triples or {x,y,z}; falloff ramps to zero at the radius',()=>{
    expect(near(v3.add([1,2,3],{x:1,y:1,z:1}),[2,3,4])).toBe(true);
    expect(v3.length(v3.cross([1,0,0],[0,1,0]))).toBe(1);
    expect(v3.dot([1,2,3],[4,5,6])).toBe(32);
    expect(near(v3.lerp([0,0,0],[2,2,2],.5),[1,1,1])).toBe(true);
    expect(falloff([1,0,0],{radius:2})).toBeCloseTo(.5);expect(falloff([3,0,0],{radius:2})).toBe(0);
    expect(falloff({x:0,y:0,z:0},{center:[0,0,1],radius:1,ease:t=>t*t})).toBe(0);
    expect(()=>falloff([0,0,0],{radius:0})).toThrow('radius');
  });
  it('a light floor keeps a minimum tone on lit faces and named directions resolve',()=>{
    const plain=lightRecipe3({direction:'up'}),floored=lightRecipe3({direction:[0,0,1],ambient:0,floor:.2});
    expect(lightTone3([0,0,1],plain)).toBeCloseTo(0);
    expect(lightTone3([0,0,1],floored)).toBeCloseTo(.2);expect(lightTone3([0,0,-1],floored)).toBeCloseTo(1);
    expect(typeof light({direction:'x'})).toBe('function');
    expect(()=>lightRecipe3({direction:'up',floor:2})).toThrow('floor');
  });
});

describe('2D steps shorthand and toolkit noise',()=>{
  it('material.steps takes {move,set}',()=>{
    const m=material([{x:0,y:0},{x:1,y:0}]);
    const moved=m.steps(2,{move:_p=>[0,1]});
    expect(moved.y.every(y=>Math.abs(y-2)<1e-12)).toBe(true);
    const both=m.attribute('n',()=>0).steps(2,{set:p=>({n:p.n+1}),move:p=>[p.n,0]});
    expect(both.x[0]).toBeCloseTo(1);expect(both.attrs.n[0]).toBe(2);
    expect(()=>m.steps(1,{} as never)).toThrow('move field');
  });
  it('t.noise takes a point row or triple with wavelength and amount',()=>{
    let seen:number[]=[];
    compileSketch(sketch({seed:7},t=>{
      seen=[t.noise(10,20,0),t.noise({x:10,y:20}),t.noise([10,20]),t.noise([20,40,0],{wavelength:2}),t.noise({x:10,y:20},{amount:3})];
      expect(()=>t.noise([0,0],{wavelength:0})).toThrow('wavelength');
      return null;
    }));
    expect(seen[1]).toBe(seen[0]);expect(seen[2]).toBe(seen[0]);expect(seen[3]).toBe(seen[0]);expect(seen[4]).toBeCloseTo(3*seen[0]);
  });
});

import {describe,expect,it} from 'vitest';
import {plane,box,sphere,cylinder,torus,mesh,polyline,pointCloud,instanceOnFaces,instanceOnPoints,isolines,v3,falloff,light,view,orthographic,perspective,axisAngle} from '../src/three/api/index.js';
import {lightTone3,lightRecipe3} from '../src/three/surface/tone.js';
import {sketch,sketchAsync,compileSketch,compileSketchAsync,material,pen,mm,strokes,isSketchAsync,exportSvg,initOcclude} from '../src/index.js';
import {readFileSync} from 'node:fs';
import {beforeAll} from 'vitest';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
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
  it('the origin rides along with a rotation or scale about another pivot',()=>{
    const b=box(1).translate([5,0,0]);
    const turned=b.rotate('z',90,{about:'world'});
    expect(near(turned.origin,[0,5,0],1e-9)).toBe(true);
    // A later default rotation now turns in place at the carried origin.
    expect(near(centroid(turned.rotate([0,0,45])),[0,5,0],1e-9)).toBe(true);
    const value=b.rotate(axisAngle('z',180),[6,0,0]);
    expect(near(value.origin,[7,0,0],1e-9)).toBe(true);
    const grown=b.scale(2,{about:'world'});
    expect(near(grown.origin,[10,0,0])).toBe(true);
    expect(near(centroid(grown.scale(0.5)),[10,0,0],1e-9)).toBe(true);
    const line=polyline([[5,0,0],[6,0,0]]).translate([1,0,0]).rotate('z',90,{about:'world'});
    expect(near(line.origin,[0,1,0],1e-9)).toBe(true);
    expect(near(pointCloud([[0,0,0]]).translate([2,0,0]).scale([3,1,1],[1,0,0]).origin,[4,0,0])).toBe(true);
  });
  it('local rotation reads the axis in the accumulated orientation',()=>{
    const tilted=box(1).rotate('z',90);
    const localX=tilted.rotate('x',90,{local:true}),worldY=tilted.rotate('y',90);
    // After a 90° turn about z the object's x axis is world +y, so a local x turn equals a world y turn.
    const wy=[...worldY.points];
    expect([...localX.points].every((p,i)=>near([p.x,p.y,p.z],[wy[i].x,wy[i].y,wy[i].z],1e-9))).toBe(true);
    expect(near(localX.orientation.apply([1,0,0]),tilted.orientation.apply([1,0,0]),1e-9)).toBe(true);
  });
  it('a zero scale makes nothing, and nothing flows through views and intersections',async()=>{
    const gone=box(1).translate([2,0,0]).scale(0);
    expect(gone.faces.length).toBe(0);expect(gone.points.length).toBe(0);expect(near(gone.origin,[2,0,0])).toBe(true);
    expect(box(1).scale([1,0,1]).faces.length).toBe(0);
    expect(polyline([[0,0,0],[1,0,0]]).scale(0).edges.length).toBe(0);
    const dots=[...pointCloud([[1,0,0],[2,0,0]]).translate([1,0,0]).scale(0).points];
    expect(dots.length).toBe(2);expect(dots.every(p=>near([p.x,p.y,p.z],[1,0,0]))).toBe(true);
    const camera=orthographic({eye:[4,6,5],target:[0,0,0],up:[0,0,1],span:6});
    let seen:ProjectedLines|undefined;
    await compileSketchAsync(sketch({seed:1,pens:{ink:pen({width:mm(.2)})}},async t=>{
      const cube=box(1),other=box(1).translate([.5,0,0]),seams=await t.intersections([gone,cube,other]);
      expect(seams.sources.length).toBe(3);expect(seams.edges.length).toBeGreaterThan(0);
      return view([gone,cube,other,seams],{camera,stroke:'ink'},lines=>{seen=lines;return [];});
    }));
    expect([...seen!.visible].some(c=>c.feature.objectId==='object:0')).toBe(false);
    expect([...seen!.visible].some(c=>c.feature.objectId==='object:1')).toBe(true);
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

describe('outline chaining',()=>{
  it('a silhouette loop is one stroke through the mesh vertices it passes',async()=>{
    const camera=perspective({eye:[3,-4,2.5],target:[0,0,0],fovDegrees:40});
    const paths=async(geometry:any)=>{const run=await compileSketchAsync(sketch({seed:1,pens:{ink:pen({width:mm(.25)})}},()=>view(geometry as never,{camera,stroke:'ink'})));return (exportSvg(run).match(/<path/g)??[]).length;};
    expect(await paths(sphere(1,{segments:32,rings:16}))).toBe(1);
    // A cube: the six-edge outline is one stroke, the three inner edges meet at a corner and stay apart.
    expect(await paths(box(1))).toBe(4);
    expect(await paths(torus(1.2,.35,{segments:64,tubeSegments:24,creaseAngle:180}))).toBeLessThan(20);
  });
});

describe('view inputs',()=>{
  it('names a geometry value passed twice',()=>{
    const ring=torus(1,.3,{segments:8,tubeSegments:6}),camera=orthographic({eye:[4,6,5],target:[0,0,0],up:[0,0,1],span:6});
    expect(()=>compileSketch(sketch({seed:1,pens:{ink:pen({width:mm(.2)})}},()=>view([box(1),ring,ring],{camera,stroke:'ink'})))).toThrow('appears twice');
  });
});

describe('per-object pen',()=>{
  it('the default drawing uses an object stroke for its lines and hatch, view stroke elsewhere',async()=>{
    const camera=orthographic({eye:[4,6,5],target:[0,0,0],up:[0,0,1],span:6});
    const pens={ink:pen({width:mm(.2),color:'#111111'}),fine:pen({width:mm(.1),color:'#22aa22'}),red:pen({width:mm(.3),color:'#aa2222'})};
    const svg=(geometry:Parameters<typeof view>[0],options:Partial<Parameters<typeof view>[1]>={})=>compileSketchAsync(sketch({seed:1,pens},()=>view(geometry as never,{camera,stroke:'ink',...options} as never))).then(run=>exportSvg(run));
    const ball=sphere(.8,{segments:12,rings:6,stroke:'fine'}).faceAttribute('h',true),cube=box(1).translate([2,0,0]);
    const plain=await svg([cube,ball]);
    expect(plain).toContain('#111111');expect(plain).toContain('#22aa22');expect(plain).not.toContain('#aa2222');
    const hatched=await svg([cube,ball],{hatch:[{spacing:mm(2),angle:0,select:(f:any)=>f.h===true},{spacing:mm(3),angle:90,stroke:'red',select:(f:any)=>f.h===true}]});
    // Hatch without a pen follows the object; a recipe pen wins.
    expect(hatched).toContain('#aa2222');
    // A recipe pen may be a field over the face: tagged faces in another pen, one recipe.
    const tagged=await svg([cube.faceAttribute('ring',true),sphere(.8,{segments:12,rings:6}).faceAttribute('h',true)],{hatch:{spacing:mm(2),angle:0,stroke:(f:any)=>f.ring?'red':'fine',select:(f:any)=>f.ring===true||f.h===true}});
    expect(tagged).toContain('#aa2222');expect(tagged).toContain('#22aa22');
    // An object fillPen takes hatch recipes that name no pen; the outline keeps the view's pen.
    const filled=await svg([cube,sphere(.8,{segments:12,rings:6,fillPen:'red'}).faceAttribute('h',true)],{hatch:{spacing:mm(2),angle:0,select:(f:any)=>f.h===true}});
    expect(filled).toContain('#aa2222');expect(filled).toContain('#111111');expect(filled).not.toContain('#22aa22');
    expect(sphere(1).withFillPen('red').translate([1,0,0]).fillPen).toBe('red');
    const viewOnly=await svg([cube,sphere(.8,{segments:12,rings:6})]);
    expect(viewOnly).not.toContain('#22aa22');
    expect(sphere(1).withStroke('fine').translate([1,0,0]).subdivide(1).stroke).toBe('fine');
    expect(()=>sphere(1,{stroke:''})).toThrow('pen name');
  });
});

describe('per-object crease threshold',()=>{
  it('an object with its own creaseAngle overrides the view default; instances follow the prototype',async()=>{
    const camera=orthographic({eye:[4,6,5],target:[0,0,0],up:[0,0,1],span:6});
    const count=async(ring:ReturnType<typeof torus>,viewAngle?:number)=>{
      let seen:ProjectedLines|undefined;
      const def=sketch({seed:1,pens:{ink:pen({width:mm(.2)})}},()=>view([box(1).translate([2.5,0,0]),ring],{camera,stroke:'ink',...(viewAngle===undefined?{}:{creaseAngle:viewAngle})},lines=>{seen=lines;return [];}));
      await compileSketchAsync(def);
      const creases=[...seen!.visible.kind('crease')];
      return {ring:creases.filter(c=>c.feature.objectId==='object:1'&&c.feature.creaseAngle>=(c.feature.creaseThreshold??(viewAngle??30))).length,cube:creases.filter(c=>c.feature.objectId==='object:0'&&c.feature.creaseAngle>=(c.feature.creaseThreshold??(viewAngle??30))).length};
    };
    const plain=torus(1,.3,{segments:12,tubeSegments:8});
    const byDefault=await count(plain),smooth=await count(plain.withCreaseAngle(180)),sharp=await count(torus(1,.3,{segments:12,tubeSegments:8,creaseAngle:0}));
    expect(byDefault.ring).toBeGreaterThan(0);expect(smooth.ring).toBe(0);expect(sharp.ring).toBeGreaterThan(byDefault.ring);
    expect(smooth.cube).toBe(byDefault.cube);expect(sharp.cube).toBe(byDefault.cube);
    expect(smooth.cube).toBeGreaterThan(0);
    // The threshold rides on the feature so the default drawing and callbacks agree.
    expect(plain.withCreaseAngle(60).translate([1,0,0]).subdivide(1).creaseAngle).toBe(60);
    expect(()=>plain.withCreaseAngle(200)).toThrow('creaseAngle');
    const placed=instanceOnPoints(plain.withCreaseAngle(180),pointCloud([[0,0,0]]).points);
    let seen:ProjectedLines|undefined;
    await compileSketchAsync(sketch({seed:1,pens:{ink:pen({width:mm(.2)})}},()=>view([placed],{camera,stroke:'ink'},lines=>{seen=lines;return [];})));
    expect([...seen!.visible.kind('crease')].every(c=>c.feature.creaseThreshold===180)).toBe(true);
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

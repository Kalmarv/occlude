import {beforeAll,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {obj,view,orthographic,type Mesh} from '../src/three/api/index.js';
import {cross3,dot3} from '../src/three/math.js';
import {sketch,compileSketchAsync,renderAsync,pen,mm,initOcclude,exportSvg} from '../src/index.js';

beforeAll(async()=>{
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
});

/** A Blender-style export: header comments, an object name, normals and
 * texture coordinates to read past, quads as v/vt/vn triples. Y up: the
 * cube stands from y=0 to y=2. */
const CUBE=`# Blender 4.2
o Cube
v -1 0 -1
v  1 0 -1
v  1 0  1
v -1 0  1
v -1 2 -1
v  1 2 -1
v  1 2  1
v -1 2  1
vn 0 -1 0
vt 0 0
f 1/1/1 2/1/1 3/1/1 4/1/1
f 8/1/1 7/1/1 6/1/1 5/1/1
f 5/1/1 6/1/1 2/1/1 1/1/1
f 6/1/1 7/1/1 3/1/1 2/1/1
f 7/1/1 8/1/1 4/1/1 3/1/1
f 8/1/1 5/1/1 1/1/1 4/1/1
`;

function manifold(m:Mesh<any,any,any,any>,chi:number):void {
  expect(m.surface.edges.every(e=>e.faces.length===2)).toBe(true);
  expect(m.points.length-m.edges.length+m.faces.length).toBe(chi);
  let volume=0;
  for(const t of m.surface.triangles){const [a,b,c]=t.vertices.map(i=>m.surface.points[i].position);volume+=dot3(a,cross3(b,c))/6;}
  expect(volume).toBeGreaterThan(0);
}

describe('obj() mesh source',()=>{
  it('reads a Blender export as a closed, outward-wound mesh, stood up Z-up',()=>{
    const cube=obj(CUBE);
    expect(cube.points.length).toBe(8);expect(cube.faces.length).toBe(6);expect(cube.edges.length).toBe(12);
    expect(cube.faces.every(f=>f.vertices.length===4)).toBe(true);
    manifold(cube,2);
    // The file's Y (0..2) is occlude's Z; the file's Z becomes -Y.
    expect(Math.min(...cube.points.map(p=>p.z))).toBe(0);expect(Math.max(...cube.points.map(p=>p.z))).toBe(2);
    expect([...cube.points][0].y).toBe(1);
    expect(cube.faces.map(f=>f.object).every(v=>v==='Cube')).toBe(true);
  });
  it("keeps the file's frame with up: 'z'",()=>{
    const asIs=obj(CUBE,{up:'z'});
    expect(Math.max(...asIs.points.map(p=>p.y))).toBe(2);expect([...asIs.points][0].z).toBe(-1);
    manifold(asIs,2);
  });
  it('honours negative (relative) indices',()=>{
    const m=obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n');
    expect([...m.faces][0].vertices).toEqual([0,1,2]);
  });
  it('drops a face with fewer than three distinct corners and compacts unused vertices',()=>{
    const m=obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 9 9 9\nf 1 2 3\nf 1 1 2\n');
    expect(m.faces.length).toBe(1);expect(m.points.length).toBe(3);
    const cloud=obj('v 0 0 0\nv 1 0 0\n');
    expect(cloud.faces.length).toBe(0);expect(cloud.points.length).toBe(2);
    expect(obj('# nothing\n').faces.length).toBe(0);
  });
  it('filters by object name and carries o and g as face attributes',()=>{
    const two=`o a\nv 0 0 0\nv 1 0 0\nv 0 1 0\ng left\nf 1 2 3\no b\nv 5 0 0\nv 6 0 0\nv 5 1 0\nf 4 5 6\n`;
    const all=obj(two);
    expect(all.faces.map(f=>f.object)).toEqual(['a','b']);expect(all.faces.map(f=>f.group)).toEqual(['left','left']);
    const b=obj(two,{objects:['b']});
    expect(b.faces.length).toBe(1);expect(b.points.length).toBe(3);expect([...b.points][0].x).toBe(5);
    expect(obj(two,{objects:['nope']}).faces.length).toBe(0);
  });
  it('refuses a mistake by line',()=>{
    expect(()=>obj('v 0 0 0\nv 1 0 0\nf 1 2 3\n')).toThrow('obj line 3: face refers to vertex 3 and the file has 2 vertices so far');
    expect(()=>obj('v 0 0 x\n')).toThrow('obj line 1: vertex needs three finite coordinates');
    expect(()=>obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nf 1 2 3 1 4\n')).toThrow('obj line 5: face visits a vertex twice');
    expect(()=>obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 1\nf 1 2 3\nf 1 2 4\n')).toThrow('obj lines 5 and 6: both faces wind the same way');
    expect(()=>obj('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 1\nv 0 0 1\nf 1 2 3\nf 2 1 4\nf 1 2 5\n')).toThrow('obj line 8: a third face on the edge');
    expect(()=>obj(42 as never)).toThrow("t.asset('name.obj')");
    expect(()=>obj(CUBE,{up:'x' as never})).toThrow("obj up must be 'y' or 'z'");
  });
  it('reads the Stanford bunny at full resolution: a scan with holes, not a closed solid',{timeout:60000},()=>{
    // 69,451 triangles from graphics.stanford.edu/data/3Dscanrep,
    // as MeshLab wrote it. The base has holes, so some edges have one face.
    const text=readFileSync(fileURLToPath(new URL('./fixtures/stanford-bunny.obj',import.meta.url)),'utf8');
    const bunny=obj(text);
    // 1,113 of the file's vertices belong to no face (stray scan points); the import keeps only what the faces use.
    expect((text.match(/^v /gm)??[]).length).toBe(35947);
    expect(bunny.points.length).toBe(34834);expect(bunny.faces.length).toBe(69451);
    expect(bunny.surface.triangles.length).toBe(69451);
    expect(bunny.surface.edges.filter(e=>e.faces.length===1).length).toBe(223);
    expect(bunny.surface.edges.every(e=>e.faces.length<=2)).toBe(true);
    // Stood upright: the file's Y (its height) is occlude's Z, about 15 cm tall.
    const z=[...bunny.points].map(p=>p.z);
    expect(Math.max(...z)-Math.min(...z)).toBeCloseTo(0.154,2);
  });
  it('is drawn through view like any mesh, with hidden lines removed',async()=>{
    const def=sketch({seed:1,pens:{ink:pen({width:mm(.3),color:'#000'})}},()=>view(obj(CUBE),{camera:orthographic({eye:[5,7,4],target:[0,0,1],span:5}),pen:'ink'}));
    const run=await compileSketchAsync(def);
    expect(run.scenes3.size).toBe(1);
    // Nine visible edges of a cube from a three-quarter view; three hidden.
    const r=await renderAsync(def,{paper:'Square20'});
    expect(r.frags.filter(f=>!f.dot).length).toBe(9);
    expect(exportSvg(run)).toContain('data-pen="ink"');
  });
});

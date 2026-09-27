/**
 * The 3D kernels' reader and builder over the one geometry
 * (src/three/geometry/mesh3.ts): `mesh3(m)` reads the value's own columns,
 * and `made3` builds a value from a kernel's columns, keeping every row it
 * kept by name.
 */
import {describe,expect,it} from 'vitest';
import {kinds,kindOf,type AnyColumn} from '../src/column.js';
import {materialFromParts,type Material} from '../src/material.js';
import {mesh3,made3,meshOfMade3,faceEdges3,cornerNames3,checkMade3,sameAttachment3,sourceOfMade3,triangulate,type Made3} from '../src/three/geometry/mesh3.js';
import {plane,box,mesh,pointCloud} from '../src/three/api/mesh.js';
import {sphere,torus} from '../src/three/api/primitives.js';
import {curve} from '../src/index.js';

const values=(c:AnyColumn):unknown[]=>Array.from({length:c.length},(_,i)=>(c as {get(i:number):unknown}).get(i));
/** A kernel that keeps every row as it is: the reader's own columns, as an answer. */
function asMade(m:Material):Made3 {
  const r=mesh3(m);
  return {x:r.x,y:r.y,z:r.z,names:r.names,loops:r.loops,triangles:r.loops.map((_,f)=>r.localTriangles(f)),edges:r.edges,cols:{...r.cols}};
}
/** Two values hold the same rows: positions, names, loops, triangles, edges
 * and every column cell. */
function sameRows(a:Material,b:Material):void {
  const x=mesh3(a),y=mesh3(b);
  for(const k of ['x','y','z','edges','triangles','triangleFace'] as const)expect(Array.from(y[k])).toEqual(Array.from(x[k]));
  expect(y.loops).toEqual(x.loops);expect(y.names).toEqual(x.names);
  for(const d of ['points','edges','faces','corners'] as const){
    expect(Object.keys(y.cols[d]).sort()).toEqual(Object.keys(x.cols[d]).sort());
    for(const name in x.cols[d]){expect(kindOf(y.cols[d][name])).toBe(kindOf(x.cols[d][name]));expect(values(y.cols[d][name])).toEqual(values(x.cols[d][name]));}
  }
}

describe('mesh3: the reader',()=>{
  const cases:[string,()=>Material][]=[
    ['a plane with a chart',()=>plane(2)],
    ['a subdivided, displaced plane (fixed triangles)',()=>plane(2).subdivide(2).displace(p=>[0,0,Math.sin(p.x*3)*Math.cos(p.y*2)])],
    ['a box with face and corner columns',()=>box(1).faces.set({shade:f=>f.normal[2],ground:f=>f.normal[2]>0.5,tag:f=>f.normal[0]>0?'east':'west'})],
    ['a sphere',()=>sphere(1,{segments:8,rings:5})],
    ['a torus with a vector point column',()=>torus(1,0.3,{segments:10,tubeSegments:6}).points.set('dir',p=>[p.x,p.y,p.z])],
    ['an extrusion',()=>{const s=plane(2).subdivide(1);return s.extrude(s.faces.filter(f=>f.index===0||f.index===3),{distance:0.5});}],
    ['a union',()=>box(1).faces.set('mark',1).union(box(1).translate([0.5,0.2,0.1]))],
    ['a curve: loose edges, no faces',()=>curve([[0,0,0],[1,0,0],[1,1,1]])],
    ['a point cloud',()=>pointCloud([[0,0,0],[1,2,3]])],
  ];
  for(const [name,make] of cases)it(`reads ${name} as the value's rows`,()=>{
    const m=make(),r=mesh3(m);
    expect(mesh3(m)).toBe(r);
    const points=[...m.points];expect(r.n).toBe(points.length);
    points.forEach((p,i)=>expect(r.position(i)).toEqual([p.x,p.y,p.z??0]));
    const faces=[...m.faces];expect(r.faceCount).toBe(faces.length);
    faces.forEach((f,i)=>{
      expect(r.loops[i].length).toBe(f.corners.length);
      expect(r.loops[i]).toEqual([...f.corners].map(c=>c.point.index));
      // The fixed triangles cover the face: one fewer than its loop, less two.
      const own=r.triangleFace.filter(t=>t===i).length;expect(own===0||own===r.loops[i].length-2).toBe(true);
    });
    const edges=[...m.edges];expect(r.edgeCount).toBe(edges.length);
    edges.forEach((e,i)=>{expect([r.edges[2*i],r.edges[2*i+1]]).toEqual([e.a.index,e.b.index]);expect([...r.edgeFaces[i]].sort()).toEqual([...e.faces].map(f=>f.index).sort());});
    // Every name is a row's, and unique in its domain.
    for(const d of ['points','edges','faces','corners'] as const)expect(new Set(r.names[d]).size).toBe(r.names[d].length);
    // Neighbours through a shared edge, as the face rows say.
    faces.forEach((f,i)=>expect([...r.faceNeighbors[i]]).toEqual([...f.adjacent].map(g=>g.index).sort((a,b)=>a-b)));
  });
  it('reads a column cell as the kernel reads it, of the kind the column holds',()=>{
    const m=box(1).faces.set({shade:f=>f.normal[2],ground:f=>f.normal[2]>0.5,tag:'t'}).points.set('dir',p=>[p.x,p.y,p.z]),r=mesh3(m);
    expect(kindOf(r.cols.faces.shade)).toBe(kinds.number);expect(kindOf(r.cols.faces.ground)).toBe(kinds.boolean);
    expect(kindOf(r.cols.faces.tag)).toBe(kinds.string);expect(kindOf(r.cols.points.dir)).toBe(kinds.vector(3));
    expect(kindOf(r.cols.corners.uv)).toBe(kinds.vector(2));
    expect(r.cell('points','dir',3)).toEqual([...m.points][3].dir);
    expect(r.cell('faces','tag',0)).toBe('t');expect(r.cell('faces','nothing',0)).toBeUndefined();
  });
  it('keeps incidence and attachment through writes that keep the faces, and not across builds',()=>{
    const m=box(1),r=mesh3(m);
    const written=m.points.set('w',1).faces.set('f',2).corners.set({extra:7}),moved=m.translate([1,2,3]),mirrored=m.scale([-1,1,1]);
    for(const n of [written,moved])expect(mesh3(n).pointFaces).toBe(r.pointFaces);
    for(const n of [written,moved,mirrored])expect(sameAttachment3(r,mesh3(n))).toBe(true);
    // A mirror turns every face over: its loops run the other way.
    expect(mesh3(mirrored).loops[0]).toEqual([...r.loops[0]].reverse());
    // Another build with the same names is another surface.
    expect(mesh3(box(1)).names).toEqual(r.names);
    expect(sameAttachment3(r,mesh3(box(1)))).toBe(false);
  });
  it('ear clips a face whose statement holds no triangles, from its positions',()=>{
    const r=mesh3(box(1));
    const bare=materialFromParts({x:r.x,y:r.y,z:r.z,edges:r.edges,faces:r.loops.map(loop=>({loop}))});
    expect(Array.from(mesh3(bare).triangles)).toEqual(Array.from(r.triangles));
    expect(Array.from(mesh3(bare).triangles.subarray(0,3))).toEqual(triangulate(r.positions,r.loops[0])[0]);
  });
});

describe('made3: a kernel\'s columns as a value',()=>{
  it('builds the same rows from the columns it is given',()=>{
    for(const m of [plane(2).subdivide(1),box(1).faces.set('tag','t').points.set('dir',p=>[p.x,p.y,p.z]),sphere(1,{segments:6,rings:4}),curve([[0,0,0],[1,0,0],[1,1,1]])])sameRows(m,made3(asMade(m),{from:m}));
  });
  it('keeps the id of every row whose name the first input holds, and mints the rest',()=>{
    const m=box(1),made=asMade(m);
    const kept=made3(made,{from:m});
    expect([...kept.points].every(p=>m.points.has(p))).toBe(true);
    expect([...kept.edges].every(e=>m.edges.has(e))).toBe(true);
    expect([...kept.faces].every(f=>m.faces.has(f))).toBe(true);
    // A row made under a new name is new; read with no input, every row is.
    const grown=made3({...made,x:[...Array.from(made.x),9],y:[...Array.from(made.y),9],z:[...Array.from(made.z),9],names:{...made.names,points:[...made.names.points,'kernel:new']},cols:{...made.cols,points:{}}},{from:m});
    expect([...grown.points].slice(0,-1).every(p=>m.points.has(p))).toBe(true);
    expect(m.points.has([...grown.points].at(-1)!)).toBe(false);
    expect([...made3(made).points].some(p=>m.points.has(p))).toBe(false);
  });
  it('carries the reference columns a kernel never reads, and links a made row to its parents',()=>{
    const m=plane(2).subdivide(1),pts=[...m.points];
    const refs=m.points.set('next',p=>pts[(p.index+1)%pts.length]),r=mesh3(refs),made=asMade(refs);
    // The kernel reads no reference column. It keeps every point but point
    // 1, which it makes anew (a child of the old one) under a new name.
    const answer:Made3={...made,names:{...made.names,points:made.names.points.map((n,i)=>i===1?'child':n)},cols:{...made.cols,points:{}},
      lineage:{points:made.names.points.map((n,i)=>i===1?{operation:'split',parents:[n]}:undefined)}};
    expect(Object.keys(r.cols.points)).toContain('next');
    const out=made3(answer,{from:refs,source:sourceOfMade3('split',answer,[refs])}),o=[...out.points] as unknown as {next:{index:number}|null;source:unknown}[];
    // A kept row keeps its value; the made row takes its parent's; a reference
    // to the row that was made anew names nothing here.
    expect(o[2].next?.index).toBe(3);
    expect(o[1].next?.index).toBe(2);
    expect(o[0].next).toBeNull();
    expect(refs.points.has(out.points.at(0)!)).toBe(true);expect(refs.points.has(out.points.at(1)!)).toBe(false);
    expect(o[1].source).toBe([...refs.points][1]);
  });
  it('derives edges and corner names as a surface always did, and checks the loops',()=>{
    const names=['p0','p1','p2','p3'],loops=[[0,1,2],[0,2,3]];
    const {edges,names:edgeNames,kept}=faceEdges3(loops,names);
    expect(Array.from(edges)).toEqual([0,1,1,2,0,2,2,3,0,3]);
    expect(edgeNames).toEqual(['e:p0:p1','e:p1:p2','e:p0:p2','e:p2:p3','e:p0:p3']);
    expect(Array.from(kept)).toEqual([-1,-1,-1,-1,-1]);
    expect(cornerNames3(loops,['f0','f1'],names)).toEqual(['["corner","f0","p0"]','["corner","f0","p1"]','["corner","f0","p2"]','["corner","f1","p0"]','["corner","f1","p2"]','["corner","f1","p3"]']);
    // A previous value's edge between points of the same names keeps its name and row.
    const prev=mesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],[[0,1,2,3]]),r=mesh3(prev);
    const again=faceEdges3([[0,1,2],[0,2,3]],r.names.points,r);
    expect(again.names[0]).toBe(r.names.edges[0]);expect(again.kept[0]).toBe(0);
    const made=(loops:number[][]):Made3=>({x:[0,1,1,0],y:[0,0,1,1],z:[0,0,0,0],names:{points:names,edges:[],faces:loops.map((_,f)=>`f${f}`),corners:[]},loops,triangles:[],edges:[]});
    expect(()=>checkMade3(made([[0,1,2],[0,1,3]]))).toThrow('adjacent face winding must oppose along the shared edge');
    expect(()=>checkMade3(made([[0,1,1]]))).toThrow('surface face requires at least three distinct valid point indices');
    expect(()=>checkMade3(made([[0,1,2],[1,0,3],[0,1,2]]))).toThrow();
  });
  it('reads an intermediate answer without making a value',()=>{
    const m=box(1),r=meshOfMade3(asMade(m));
    expect(r.value).toBeUndefined();
    expect(Array.from(r.triangles)).toEqual(Array.from(mesh3(m).triangles));
    expect(r.names).toEqual(mesh3(m).names);
  });
});

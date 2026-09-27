/**
 * The 3D working view and the one geometry's parts, both ways
 * (src/three/geometry/parts.ts): parts → view → parts is the same parts,
 * and view → parts → view is the same surface, row for row and name for name.
 */
import {describe,expect,it} from 'vitest';
import {kinds,kindOf,type AnyColumn} from '../src/column.js';
import {materialFromParts,partsOfMaterial} from '../src/material.js';
import {partsOfSurface,surfaceOfParts,type SurfaceMade,type ViewParts} from '../src/three/geometry/parts.js';
import {surface3,type Surface3} from '../src/three/geometry/surface.js';
import {topology3} from '../src/three/geometry/topology.js';
import {plane,box,pointCloud} from '../src/three/api/mesh.js';
import {sphere,torus} from '../src/three/api/primitives.js';
import {curve} from '../src/index.js';
import {surfaceOf} from '../src/three/geometry/value.js';

const values=(c:AnyColumn):unknown[]=>Array.from({length:c.length},(_,i)=>(c as {get(i:number):unknown}).get(i));
const sameColumns=(a:Readonly<Record<string,AnyColumn>>|undefined,b:Readonly<Record<string,AnyColumn>>|undefined):void=>{
  expect(Object.keys(b??{}).sort()).toEqual(Object.keys(a??{}).sort());
  for(const name in a){expect(kindOf(b![name])).toBe(kindOf(a[name]));expect(values(b![name])).toEqual(values(a[name]));}
};
function sameParts(a:SurfaceMade,b:SurfaceMade):void {
  for(const k of ['x','y','z','edges'] as const)expect(Array.from(b[k]??[])).toEqual(Array.from(a[k]??[]));
  expect(b.faces!.map(f=>[Array.from(f.loop),Array.from(f.triangles??[]),f.cols])).toEqual(a.faces!.map(f=>[Array.from(f.loop),Array.from(f.triangles??[]),f.cols]));
  for(const d of ['points','edges','faces','corners'] as const){expect(Array.from(b.ids![d]!)).toEqual(Array.from(a.ids![d]!));expect(b.keys![d]).toEqual(a.keys![d]);}
  sameColumns(a.pointCols as Record<string,AnyColumn>,b.pointCols as Record<string,AnyColumn>);
  sameColumns(a.edgeCols as Record<string,AnyColumn>,b.edgeCols as Record<string,AnyColumn>);
  sameColumns(a.cornerColumns,b.cornerColumns);
  expect(b.lineage).toEqual(a.lineage);
}
/** The records with every column on every row: a row with no value reads
 * its kind's default. */
function dense(records:readonly Readonly<Record<string,unknown>>[]):Record<string,unknown>[] {
  const fill=new Map<string,unknown>();
  for(const r of records)for(const [k,v] of Object.entries(r))if(v!==undefined&&!fill.has(k))fill.set(k,typeof v==='number'?0:typeof v==='boolean'?false:typeof v==='string'?'':(v as number[]).map(()=>0));
  return records.map(r=>{const out:Record<string,unknown>={};for(const [k,d] of fill)out[k]=r[k]??d;return out;});
}
/** The same surface: every row, its name, its columns (dense), its lineage. */
function sameSurface(a:Surface3,b:Surface3):void {
  const pa=dense(a.points.map(p=>p.attributes)),fa=dense(a.faces.map(f=>f.attributes)),ea=dense(a.edges.map(e=>e.attributes)),ca=dense(a.faces.flatMap(f=>(f.corners??f.vertices.map(()=>({id:'',attributes:{}}))).map(c=>c.attributes as Record<string,unknown>)));
  let corner=0;
  const pair=(x:{id:string},y:{id:string})=>expect(y.id).toBe(x.id);
  expect(b.points.length).toBe(a.points.length);expect(b.faces.length).toBe(a.faces.length);expect(b.edges.length).toBe(a.edges.length);
  a.points.forEach((p,i)=>{pair(p,b.points[i]);expect(b.points[i].position).toEqual(p.position);expect(b.points[i].attributes).toEqual(pa[i]);});
  a.faces.forEach((f,i)=>{
    const g=b.faces[i];pair(f,g);expect(g.vertices).toEqual(f.vertices);expect(g.attributes).toEqual(fa[i]);
    f.vertices.forEach((_,k)=>{if(f.corners)pair(f.corners[k],g.corners![k]);expect(g.corners![k].attributes).toEqual(ca[corner++]);});
  });
  a.edges.forEach((e,i)=>{const g=b.edges[i];pair(e,g);expect(g.vertices).toEqual(e.vertices);expect(g.faces).toEqual(e.faces);expect(g.attributes).toEqual(ea[i]);});
  expect(b.triangles.map(t=>[t.face,...t.vertices])).toEqual(a.triangles.map(t=>[t.face,...t.vertices]));
  // Lineage names the same rows.
  a.points.forEach((p,i)=>expect(b.points[i].provenance).toEqual(p.provenance));
  a.faces.forEach((f,i)=>expect(b.faces[i].provenance).toEqual(f.provenance));
  a.edges.forEach((e,i)=>expect(b.edges[i].provenance).toEqual(e.provenance));
  // The adjacency every selection reads is the same, row for row.
  const ta=topology3(a),tb=topology3(b);
  for(const k of Object.keys(ta) as (keyof typeof ta)[])expect(tb[k]).toEqual(ta[k]);
}
/** One kernel pass: the parts of a surface, the value they make, the
 * parts of that value a view reads, and the view. */
const trip=(s:Surface3):{made:SurfaceMade;parts:ViewParts;view:Surface3}=>{
  const made=partsOfSurface(s),parts=partsOfMaterial(materialFromParts(made));
  return {made,parts,view:surfaceOfParts(parts,made.lineage)};
};
const viewOf=(s:Surface3):Surface3=>trip(s).view;

describe('surface parts',()=>{
  const cases:[string,()=>Surface3][]=[
    ['a plane with a chart',()=>surfaceOf(plane(2))],
    ['a subdivided, displaced plane (fixed triangles)',()=>surfaceOf(plane(2).subdivide(2).displace(p=>[0,0,Math.sin(p.x*3)*Math.cos(p.y*2)]))],
    ['a box with face and corner columns',()=>surfaceOf(box(1).faces.set({shade:f=>f.normal[2],ground:f=>f.normal[2]>0.5,tag:f=>f.normal[0]>0?'east':'west'}))],
    ['a sphere',()=>surfaceOf(sphere(1,{segments:8,rings:5}))],
    ['a torus with a vector point column',()=>surfaceOf(torus(1,0.3,{segments:10,tubeSegments:6}).points.set('dir',p=>[p.x,p.y,p.z]))],
    ['an extrusion (lineage)',()=>{const s=plane(2).subdivide(1);return surfaceOf(s.extrude(s.faces.rowsAt([0,3]),{distance:0.5}));}],
    ['a union (a column on some faces only)',()=>surfaceOf(box(1).faces.set('mark',1).union(box(1).translate([0.5,0.2,0.1])))],
    ['a curve: loose edges, no faces',()=>surfaceOf(curve([[0,0,0],[1,0,0],[1,1,1]]))],
    ['a point cloud',()=>surfaceOf(pointCloud([[0,0,0],[1,2,3]]))],
    ['a polygon with holes in no column',()=>surface3([[0,0,0],[2,0,0],[2,1,0],[1,0.5,0],[0,1,0]],[[0,1,2,3,4]])],
  ];
  for(const [name,make] of cases)it(`round-trips ${name}`,()=>{
    const surface=make();
    const {made,parts,view}=trip(surface);
    sameSurface(surface,view);
    // parts → view → parts is the same parts: ids, columns, lineage, triangles.
    sameParts(made,partsOfSurface(view,parts));
    // The view is captured: frozen rows, and the same view reads the same way twice.
    expect(Object.isFrozen(view.points)).toBe(true);expect(view.points.every(p=>Object.isFrozen(p))).toBe(true);
  });
  it('fills a sparse column with its default, one kind a column',()=>{
    const tri=surface3([[0,0,0],[1,0,0],[0,1,0],[1,1,0]],[[0,1,2],[1,3,2]]);
    const sparse={...tri,faces:tri.faces.map((f,i)=>({...f,attributes:i?{}:{mark:2,ground:true,tag:'x',dir:[1,2]}}))} as Surface3;
    expect(viewOf(sparse).faces[1].attributes).toEqual({mark:0,ground:false,tag:'',dir:[0,0]});
    const bad={...tri,points:tri.points.map((p,i)=>({...p,attributes:{w:i?'x':1}}))} as Surface3;
    expect(()=>partsOfSurface(bad)).toThrow("the column 'w' holds a number on one row and a string on another");
  });
  it('types columns by kind, and a kernel keeps the ids of the rows it kept',()=>{
    const b=surfaceOf(box(1).faces.set({shade:f=>f.normal[2],ground:f=>f.normal[2]>0.5,tag:'t'}).points.set('dir',p=>[p.x,p.y,p.z]));
    const {parts,view}=trip(b);
    const faceCols=parts.faces!.cols,cornerCols=parts.faces!.corners.cols;
    expect(kindOf(faceCols.shade)).toBe(kinds.number);expect(kindOf(faceCols.ground)).toBe(kinds.boolean);
    expect(kindOf(faceCols.tag)).toBe(kinds.string);expect(kindOf(parts.pointCols.dir)).toBe(kinds.vector(3));
    expect(kindOf(cornerCols.uv)).toBe(kinds.vector(2));
    const ids={points:parts.ids.points,edges:parts.ids.edges,faces:parts.faces!.ids.faces!,corners:parts.faces!.ids.corners!};
    // Every id a number, never reused within a domain.
    for(const d of ['points','edges','faces','corners'] as const){const all=Array.from(ids[d]);expect(all.every(n=>Number.isSafeInteger(n)&&n>0)).toBe(true);expect(new Set(all).size).toBe(all.length);}
    // A kernel that moved the points kept every row: every id.
    const moved=partsOfSurface({...view,points:view.points.map(p=>({...p,position:[p.position[0]+1,p.position[1],p.position[2]]}))} as Surface3,parts);
    for(const d of ['points','edges','faces','corners'] as const)expect(Array.from(moved.ids![d]!)).toEqual(Array.from(ids[d]));
    // A row a kernel made under a new name is new: a fresh id.
    const made=Array.from(partsOfSurface({...view,points:[...view.points,{id:'kernel:new',position:[9,9,9],attributes:{dir:[0,0,0]}}]} as Surface3,parts).ids!.points!);
    expect(made.slice(0,-1)).toEqual(Array.from(ids.points));
    expect(made.at(-1)).toBeGreaterThan(Math.max(...Array.from(ids.points)));
    // Read with no input, every row is new.
    expect(Array.from(partsOfSurface(view).ids!.points!).some(n=>ids.points.includes(n))).toBe(false);
  });
  it('reads lineage back to ids, and carries the columns a kernel never sees',()=>{
    const {parts,view}=trip(surfaceOf(plane(2).subdivide(1)));
    const faceIds=parts.faces!.ids.faces!;
    // A reference column and a placement column, which the view leaves out.
    const next=kinds.reference.from(Array.from(faceIds,(_,i)=>faceIds[(i+1)%faceIds.length])),at=kinds.placement.from(Array.from(faceIds,(_,i)=>({i})));
    const withRefs:ViewParts={...parts,faces:{...parts.faces!,cols:{...parts.faces!.cols,next,at}}};
    expect(Object.keys(surfaceOfParts(withRefs).faces[0].attributes)).not.toContain('next');
    // A kernel that keeps face 0 and makes a child of face 1.
    const kept=view.faces[0],child={...view.faces[1],id:'child',provenance:{operation:'split',parents:[view.faces[1].id]}};
    const result={...view,faces:[kept,child,...view.faces.slice(2)]} as Surface3;
    const back=partsOfSurface(result,withRefs);
    const backNext=back.faces!.map(f=>f.cols!.next),backAt=back.faces!.map(f=>f.cols!.at);
    expect(back.ids!.faces![0]).toBe(faceIds[0]);
    expect(backNext[0]).toBe(next.get(0));
    expect(backNext[1]).toBe(next.get(1));
    expect(backAt[1]).toBe(at.get(1));
    expect(back.lineage.faces![1]).toEqual({operation:'split',parents:[view.faces[1].id]});
    expect(back.ids!.faces![1]).not.toBe(faceIds[1]);
  });
  it('triangulates faces from positions when the parts carry no triangles',()=>{
    const s=surfaceOf(box(1)),{parts}=trip(s);
    const view=surfaceOfParts({...parts,faces:{...parts.faces!,triangles:undefined}});
    expect(view.triangles.map(t=>[t.face,...t.vertices])).toEqual(s.triangles.map(t=>[t.face,...t.vertices]));
  });
});

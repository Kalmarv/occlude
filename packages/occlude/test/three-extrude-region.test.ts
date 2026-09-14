import {describe,it,expect} from 'vitest';
import {box,plane,mesh} from '../src/three/api/mesh.js';
import {dot3,cross3,type Vec3} from '../src/three/math.js';
import type {Surface3} from '../src/three/geometry/surface.js';

const volume=(s:Surface3)=>s.triangles.reduce((sum,t)=>{const [a,b,c]=t.vertices.map(v=>s.points[v].position);return sum+dot3(a,cross3(b,c))/6;},0);
const closed=(s:Surface3)=>s.edges.every(e=>e.faces.length===2);
const sheet=(n=4)=>plane(4,4).subdivide(n===4?2:1);

describe('connected-region extrusion',()=>{
  it('extrudes an adjacent patch as one cap with walls on every boundary edge',()=>{
    const model=sheet();
    const region=model.faces().filter(f=>Math.abs(f.center[0])<1.5&&Math.abs(f.center[1])<1.5);
    expect(region.length).toBe(4);
    const out=model.extrude(region,[0,0,0.5]);
    const boundary=region.boundaryEdges().length;
    expect(boundary).toBe(8);
    expect(out.surface.faces.length).toBe(model.surface.faces.length+boundary);
    // Cap faces keep their IDs and rise by the vector; all other faces stay put.
    for(const f of region){const cap=out.surface.faces.find(x=>x.id===f.id)!;expect(cap.vertices.every(v=>out.surface.points[v].position[2]===0.5)).toBe(true);}
    for(const f of region.complement()){const same=out.surface.faces.find(x=>x.id===f.id)!;expect(same.vertices.every(v=>out.surface.points[v].position[2]===0)).toBe(true);}
    // The shared centre point moved in place; boundary points were duplicated.
    expect(out.surface.points.length).toBe(model.surface.points.length+8);
    expect(out.surface.points.filter(p=>p.provenance?.operation==='extrude').length).toBe(8);
    // Walls are planar quads with two fixed triangles, and the input is untouched.
    expect(out.surface.triangles.length).toBe(model.surface.triangles.length+2*boundary);
    expect(model.surface.points.every(p=>p.position[2]===0)).toBe(true);
  });
  it('changes a box volume by area times distance, for positive and negative offsets',()=>{
    const model=box(2);
    const top=model.faces().filter(f=>f.normal[2]>0.9);
    for(const d of [1,-0.5]){
      const out=model.extrude(top,{distance:d});
      expect(closed(out.surface)).toBe(true);
      expect(volume(out.surface)).toBeCloseTo(8+4*d,10);
    }
    const vector=model.extrude(top,[0,0,0.25]);
    expect(volume(vector.surface)).toBeCloseTo(9,10);
  });
  it('gives each connected component its own vector and reports zero vectors',()=>{
    const model=sheet();
    const faces=model.faces();
    const left=faces.filter(f=>f.center[0]<-1),right=faces.filter(f=>f.center[0]>1);
    const region=left.union(right);
    expect(region.components().length).toBe(2);
    const out=model.extrude(region,r=>[0,0,r.index===0?1:2]);
    const heights=[...out.surface.faces].filter(f=>f.provenance?.operation!=='extrude'&&region.some(r=>r.id===f.id)).map(f=>out.surface.points[f.vertices[0]].position[2]);
    expect(new Set(heights)).toEqual(new Set([1,2]));
    expect(out.surface.faces.length).toBe(model.surface.faces.length+left.boundaryEdges().length+right.boundaryEdges().length);
    expect(()=>model.extrude(region,r=>[0,0,r.index])).toThrow('zero vector');
  });
  it('walls hole loops and open sheet edges',()=>{
    const model=sheet();
    const ring=model.faces().filter(f=>!(Math.abs(f.center[0])<1&&Math.abs(f.center[1])<1));
    expect(ring.length).toBe(12);
    expect(ring.components().length).toBe(1);
    const out=model.extrude(ring,[0,0,1]);
    // Outer loop (open sheet boundary, 16 edges) plus the hole loop (8 edges).
    expect(out.surface.faces.length).toBe(model.surface.faces.length+24);
    const centre=model.faces().filter(f=>Math.abs(f.center[0])<1&&Math.abs(f.center[1])<1);
    for(const f of centre){const same=out.surface.faces.find(x=>x.id===f.id)!;expect(same.vertices.every(v=>out.surface.points[v].position[2]===0)).toBe(true);}
    expect(out.surface.edges.every(e=>e.faces.length<=2)).toBe(true);
    const walls=out.surface.faces.filter(f=>f.provenance?.operation==='extrude');
    expect(walls.every(f=>f.vertices.length===4)).toBe(true);
    expect(out.surface.faces.filter(f=>f.provenance?.operation==='extrude'&&f.corners!.every(c=>c.attributes.chart==='extrude:side:0')).length).toBe(24);
  });
  it('rejects closed shells, foreign selections and bad offsets',()=>{
    const model=box(1);
    expect(()=>model.extrude(model.faces(),[0,0,1])).toThrow('closed shell');
    const other=box(1);
    expect(()=>model.extrude(other.faces(),[0,0,1])).toThrow('this mesh revision');
    expect(()=>model.extrude(model.faces().filter(f=>f.normal[2]>0.9),{distance:Number.NaN})).toThrow('finite');
    expect(()=>model.extrude(model.faces().filter(f=>f.normal[2]>0.9),[0,0,1],{key:''})).toThrow('nonempty');
    // Two opposite faces cancel: no region direction for a scalar distance.
    const ends=model.faces().filter(f=>Math.abs(f.normal[2])>0.9);
    expect(ends.components().length).toBe(2);
    expect(()=>model.extrude(ends,{distance:1})).not.toThrow();
    // A folded strip: floor, wall, and a ceiling wound back over the floor.
    const cancelling=mesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[1,1,1],[0,1,1],[1,0,1],[0,0,1]],[[0,1,2,3],[3,2,4,5],[5,4,6,7]]);
    const both=cancelling.faces();
    expect(both.components().length).toBe(1);
    expect(()=>cancelling.extrude(both,{distance:1})).toThrow('well-defined direction');
  });
  it('retains cap corner UVs and generates continuous side charts',()=>{
    const model=plane(2,2).subdivide(1);
    const region=model.faces().filter(f=>f.center[0]<0);
    const out=model.extrude(region,[0,0,1]);
    for(const f of region){
      const cap=out.surface.faces.find(x=>x.id===f.id)!,source=model.surface.faces[f.index];
      expect(cap.corners!.map(c=>c.id)).toEqual(source.corners!.map(c=>c.id));
      expect(cap.corners!.map(c=>c.attributes.uv)).toEqual(source.corners!.map(c=>c.attributes.uv));
      expect(cap.corners!.every(c=>c.attributes.chart==='plane')).toBe(true);
    }
    const walls=out.surface.faces.filter(f=>f.provenance?.operation==='extrude');
    expect(walls.length).toBe(region.boundaryEdges().length);
    const u=walls.flatMap(f=>f.corners!.map(c=>(c.attributes.uv as number[])[0]));
    const v=walls.flatMap(f=>f.corners!.map(c=>(c.attributes.uv as number[])[1]));
    expect(u.every(n=>n>=0&&n<=1)).toBe(true);expect(Math.max(...u)).toBe(1);expect(Math.min(...u)).toBe(0);
    expect(new Set(v)).toEqual(new Set([0,1]));
    // Every wall bottom corner at u0 pairs with a top corner at the same u.
    for(const f of walls){const uv=f.corners!.map(c=>c.attributes.uv as number[]);expect(uv[0][0]).toBe(uv[3][0]);expect(uv[1][0]).toBe(uv[2][0]);}
    // Read through the ordinary typed corner collection.
    expect(out.corners.filter(c=>c.chart==='extrude:side:0').length).toBe(walls.length*4);
  });
  it('keeps IDs stable and unique across a second extrusion, and subdivides afterwards',()=>{
    const model=sheet();
    const select=(m:typeof model)=>m.faces().filter(f=>Math.abs(f.center[0])<1.5&&Math.abs(f.center[1])<1.5&&f.center[2]>=0);
    const once=model.extrude(select(model),[0,0,0.5],{key:'tower'});
    const again=model.extrude(select(model),[0,0,0.5],{key:'tower'});
    expect(again.surface.points.map(p=>p.id)).toEqual(once.surface.points.map(p=>p.id));
    expect(again.surface.faces.map(f=>f.id)).toEqual(once.surface.faces.map(f=>f.id));
    const caps=once.faces().filter(f=>f.center[2]===0.5&&f.normal[2]>0.9);
    expect(caps.length).toBe(4);
    const twice=once.extrude(caps,[0,0,0.5],{key:'tower'});
    expect(new Set(twice.surface.points.map(p=>p.id)).size).toBe(twice.surface.points.length);
    expect(twice.surface.faces.length).toBe(once.surface.faces.length+8);
    expect(twice.faces().filter(f=>f.center[2]===1&&f.normal[2]>0.9).length).toBe(4);
    const refined=twice.subdivide(1);
    expect(refined.surface.faces.length).toBe(twice.surface.faces.length*4);
    expect(refined.corners.every(c=>Array.isArray(c.uv)&&typeof c.chart==='string')).toBe(true);
  });
  it('copies attributes to walls and edges without adding label columns',()=>{
    const model=plane(2,2).subdivide(1).faceAttributes({tone:(f:{center:Vec3})=>f.center[0]<0?0.7:0.2}).edgeAttributes({marked:1});
    const region=model.faces().filter(f=>f.center[0]<0);
    const out=model.extrude(region,[0,0,1]);
    const walls=out.surface.faces.filter(f=>f.provenance?.operation==='extrude');
    expect(walls.every(f=>f.attributes.tone===0.7&&Object.keys(f.attributes).join()==='tone')).toBe(true);
    const generated=out.surface.edges.filter(e=>e.provenance?.operation==='extrude');
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.every(e=>e.attributes.marked===1)).toBe(true);
    expect(out.surface.points.filter(p=>p.provenance?.operation==='extrude').every(p=>Object.keys(p.attributes).length===0)).toBe(true);
  });
});

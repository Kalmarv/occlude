import {describe,it,expect} from 'vitest';
import {box,plane,mesh} from '../src/three/api/mesh.js';
import {type Vec3} from '../src/three/math.js';
import {volume} from './helpers/surfaces.js';
import type {Surface3} from '../src/three/geometry/surface.js';
import {surfaceOf} from '../src/three/geometry/value.js';
import type {Material} from '../src/material.js';

const closed=(s:Surface3)=>s.edges.every(e=>e.faces.length===2);
const sheet=(n=4)=>plane(4,4).subdivide(n===4?2:1);
/** A face's kernel name: what the working view calls it. */
const nameOf=(m:Material,f:{index:number})=>surfaceOf(m).faces[f.index].id;

describe('connected-region extrusion',()=>{
  it('extrudes an adjacent patch as one cap with walls on every boundary edge',()=>{
    const model=sheet();
    const region=model.faces.filter(f=>Math.abs(f.centroid[0])<1.5&&Math.abs(f.centroid[1])<1.5);
    expect(region.length).toBe(4);
    const out=model.extrude(region,[0,0,0.5]);
    const boundary=region.boundaryEdges().length;
    expect(boundary).toBe(8);
    expect(surfaceOf(out).faces.length).toBe(surfaceOf(model).faces.length+boundary);
    // Cap faces keep their IDs and rise by the vector; all other faces stay put.
    for(const f of region){const cap=surfaceOf(out).faces.find(x=>x.id===nameOf(model,f))!;expect(cap.vertices.every(v=>surfaceOf(out).points[v].position[2]===0.5)).toBe(true);}
    for(const f of model.faces.without(region)){const same=surfaceOf(out).faces.find(x=>x.id===nameOf(model,f))!;expect(same.vertices.every(v=>surfaceOf(out).points[v].position[2]===0)).toBe(true);}
    // The shared centre point moved in place; boundary points were duplicated.
    expect(surfaceOf(out).points.length).toBe(surfaceOf(model).points.length+8);
    expect(surfaceOf(out).points.filter(p=>p.provenance?.operation==='extrude').length).toBe(8);
    // Walls are planar quads with two fixed triangles, and the input is untouched.
    expect(surfaceOf(out).triangles.length).toBe(surfaceOf(model).triangles.length+2*boundary);
    expect(surfaceOf(model).points.every(p=>p.position[2]===0)).toBe(true);
  });
  it('changes a box volume by area times distance, for positive and negative offsets',()=>{
    const model=box(2);
    const top=model.faces.filter(f=>f.normal[2]>0.9);
    for(const d of [1,-0.5]){
      const out=model.extrude(top,{distance:d});
      expect(closed(surfaceOf(out))).toBe(true);
      expect(volume(surfaceOf(out))).toBeCloseTo(8+4*d,10);
    }
    const vector=model.extrude(top,[0,0,0.25]);
    expect(volume(surfaceOf(vector))).toBeCloseTo(9,10);
  });
  it('gives each connected component its own vector and reports zero vectors',()=>{
    const model=sheet();
    const faces=model.faces;
    const left=faces.filter(f=>f.centroid[0]<-1),right=faces.filter(f=>f.centroid[0]>1);
    const region=left.union(right);
    expect(region.components().length).toBe(2);
    const out=model.extrude(region,r=>[0,0,r.index===0?1:2]);
    const heights=[...surfaceOf(out).faces].filter(f=>f.provenance?.operation!=='extrude'&&region.some(r=>nameOf(model,r)===f.id)).map(f=>surfaceOf(out).points[f.vertices[0]].position[2]);
    expect(new Set(heights)).toEqual(new Set([1,2]));
    expect(surfaceOf(out).faces.length).toBe(surfaceOf(model).faces.length+left.boundaryEdges().length+right.boundaryEdges().length);
    // A component with no vector is left where it is; the other still extrudes.
    const partial=model.extrude(region,r=>[0,0,r.index]);
    expect(surfaceOf(partial).faces.filter(f=>f.provenance?.operation==='extrude').length).toBe(right.boundaryEdges().length);
  });
  it('walls hole loops and open sheet edges',()=>{
    const model=sheet();
    const ring=model.faces.filter(f=>!(Math.abs(f.centroid[0])<1&&Math.abs(f.centroid[1])<1));
    expect(ring.length).toBe(12);
    expect(ring.components().length).toBe(1);
    const out=model.extrude(ring,[0,0,1]);
    // Outer loop (open sheet boundary, 16 edges) plus the hole loop (8 edges).
    expect(surfaceOf(out).faces.length).toBe(surfaceOf(model).faces.length+24);
    const centre=model.faces.filter(f=>Math.abs(f.centroid[0])<1&&Math.abs(f.centroid[1])<1);
    for(const f of centre){const same=surfaceOf(out).faces.find(x=>x.id===nameOf(model,f))!;expect(same.vertices.every(v=>surfaceOf(out).points[v].position[2]===0)).toBe(true);}
    expect(surfaceOf(out).edges.every(e=>e.faces.length<=2)).toBe(true);
    const walls=surfaceOf(out).faces.filter(f=>f.provenance?.operation==='extrude');
    expect(walls.every(f=>f.vertices.length===4)).toBe(true);
    expect(surfaceOf(out).faces.filter(f=>f.provenance?.operation==='extrude'&&f.corners!.every(c=>c.attributes.chart==='extrude:side:0')).length).toBe(24);
  });
  it('rejects closed shells, foreign selections and bad offsets',()=>{
    const model=box(1);
    // A closed shell has no boundary to raise walls from: nothing to extrude.
    expect(surfaceOf(model.extrude(model.faces,[0,0,1])).faces.length).toBe(surfaceOf(model).faces.length);
    // Identity is minted: another construction of the same box is another
    // value, and its faces name nothing here.
    const other=box(1);
    expect(()=>model.extrude(other.faces,[0,0,1])).toThrow('unrelated');
    expect(()=>model.extrude(model.points as any,[0,0,1])).toThrow('extrude');
    expect(surfaceOf(model.extrude(model.faces.filter(f=>f.normal[2]>0.9),{distance:Number.NaN})).faces.length).toBe(surfaceOf(model).faces.length);
    expect(()=>model.extrude(model.faces.filter(f=>f.normal[2]>0.9),[0,0,1],{key:''})).toThrow('nonempty');
    // Two opposite faces cancel: no region direction for a scalar distance.
    const ends=model.faces.filter(f=>Math.abs(f.normal[2])>0.9);
    expect(ends.components().length).toBe(2);
    expect(()=>model.extrude(ends,{distance:1})).not.toThrow();
    // A folded strip: floor, wall, and a ceiling wound back over the floor.
    const cancelling=mesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[1,1,1],[0,1,1],[1,0,1],[0,0,1]],[[0,1,2,3],[3,2,4,5],[5,4,6,7]]);
    const both=cancelling.faces;
    expect(both.components().length).toBe(1);
    // Two opposite faces cancel: no direction to follow, so nothing moves.
    expect(surfaceOf(cancelling.extrude(both,{distance:1})).faces.length).toBe(surfaceOf(cancelling).faces.length);
  });
  it('retains cap corner UVs and generates continuous side charts',()=>{
    const model=plane(2,2).subdivide(1);
    const region=model.faces.filter(f=>f.centroid[0]<0);
    const out=model.extrude(region,[0,0,1]);
    for(const f of region){
      const cap=surfaceOf(out).faces.find(x=>x.id===nameOf(model,f))!,source=surfaceOf(model).faces[f.index];
      expect(cap.corners!.map(c=>c.id)).toEqual(source.corners!.map(c=>c.id));
      expect(cap.corners!.map(c=>c.attributes.uv)).toEqual(source.corners!.map(c=>c.attributes.uv));
      expect(cap.corners!.every(c=>c.attributes.chart==='plane')).toBe(true);
    }
    const walls=surfaceOf(out).faces.filter(f=>f.provenance?.operation==='extrude');
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
    const select=(m:typeof model)=>m.faces.filter(f=>Math.abs(f.centroid[0])<1.5&&Math.abs(f.centroid[1])<1.5&&f.centroid[2]!>=0);
    const once=model.extrude(select(model),[0,0,0.5],{key:'tower'});
    const again=model.extrude(select(model),[0,0,0.5],{key:'tower'});
    expect(surfaceOf(again).points.map(p=>p.id)).toEqual(surfaceOf(once).points.map(p=>p.id));
    expect(surfaceOf(again).faces.map(f=>f.id)).toEqual(surfaceOf(once).faces.map(f=>f.id));
    const caps=once.faces.filter(f=>f.centroid[2]===0.5&&f.normal[2]>0.9);
    expect(caps.length).toBe(4);
    const twice=once.extrude(caps,[0,0,0.5],{key:'tower'});
    expect(new Set(surfaceOf(twice).points.map(p=>p.id)).size).toBe(surfaceOf(twice).points.length);
    expect(surfaceOf(twice).faces.length).toBe(surfaceOf(once).faces.length+8);
    expect(twice.faces.filter(f=>f.centroid[2]===1&&f.normal[2]>0.9).length).toBe(4);
    const refined=twice.subdivide(1);
    expect(surfaceOf(refined).faces.length).toBe(surfaceOf(twice).faces.length*4);
    expect(refined.corners.every(c=>Array.isArray(c.uv)&&typeof c.chart==='string')).toBe(true);
  });
  it('copies attributes to walls and edges without adding label columns',()=>{
    const model=plane(2,2).subdivide(1).faces.set({tone:(f)=>f.centroid[0]<0?0.7:0.2}).edges.set({marked:1});
    const region=model.faces.filter(f=>f.centroid[0]<0);
    const out=model.extrude(region,[0,0,1]);
    const walls=surfaceOf(out).faces.filter(f=>f.provenance?.operation==='extrude');
    expect(walls.every(f=>f.attributes.tone===0.7&&Object.keys(f.attributes).sort().join()==='chart,tone')).toBe(true);
    const generated=surfaceOf(out).edges.filter(e=>e.provenance?.operation==='extrude');
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.every(e=>e.attributes.marked===1)).toBe(true);
    expect(surfaceOf(out).points.filter(p=>p.provenance?.operation==='extrude').every(p=>Object.keys(p.attributes).length===0)).toBe(true);
  });
});

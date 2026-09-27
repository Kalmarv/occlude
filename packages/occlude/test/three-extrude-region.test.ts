import {describe,it,expect} from 'vitest';
import {box,plane,mesh} from '../src/three/api/mesh.js';
import {type Vec3} from '../src/three/math.js';
import {volume} from './helpers/surfaces.js';
import {mesh3} from '../src/three/geometry/mesh3.js';
import type {Material} from '../src/material.js';
import type {Selection} from '../src/selection.js';
import type {Face} from '../src/faces.js';

const closed=(m:Material)=>m.edges.every(e=>e.faces.length===2);
const sheet=(n=4)=>plane(4,4).subdivide(n===4?2:1);
/** The faces of `out` that are faces of `faces` (its `model`), kept: they
 * keep their kernel names. */
const kept=(out:Material,faces:Selection<Face>)=>{
  const names=mesh3(faces.owner as Material).names.faces,held=new Set(faces.map(f=>names[f.index]));
  return out.faces.filter(f=>held.has(mesh3(out).names.faces[f.index]));
};
/** The faces of `out` the extrusion of `model` made: its walls. */
const walls=(out:Material,model:Material)=>out.faces.without(kept(out,model.faces));
/** The heights of a face's corners. */
const heights=(f:{corners:Iterable<{point:{z?:number}}>})=>[...f.corners].map(c=>c.point.z);

describe('connected-region extrusion',()=>{
  it('extrudes an adjacent patch as one cap with walls on every boundary edge',()=>{
    const model=sheet();
    const region=model.faces.filter(f=>Math.abs(f.centroid[0])<1.5&&Math.abs(f.centroid[1])<1.5);
    expect(region.length).toBe(4);
    const out=model.extrude(region,[0,0,0.5]);
    const boundary=region.boundaryEdges().length;
    expect(boundary).toBe(8);
    expect(out.faces.length).toBe(model.faces.length+boundary);
    // Cap faces keep their identity and rise by the vector; all other faces stay put.
    expect(kept(out,region).length).toBe(4);
    for(const cap of kept(out,region))expect(heights(cap).every(z=>z===0.5)).toBe(true);
    for(const same of kept(out,model.faces.without(region)))expect(heights(same).every(z=>z===0)).toBe(true);
    // The shared centre point moved in place; boundary points were duplicated.
    expect(out.points.length).toBe(model.points.length+8);
    expect(out.points.filter(p=>!model.points.has(p)).length).toBe(8);
    // Walls are planar quads with two fixed triangles, and the input is untouched.
    expect(mesh3(out).triangleCount).toBe(mesh3(model).triangleCount+2*boundary);
    expect(model.points.every(p=>p.z===0)).toBe(true);
  });
  it('changes a box volume by area times distance, for positive and negative offsets',()=>{
    const model=box(2);
    const top=model.faces.filter(f=>f.normal[2]>0.9);
    for(const d of [1,-0.5]){
      const out=model.extrude(top,{distance:d});
      expect(closed(out)).toBe(true);
      expect(volume(out)).toBeCloseTo(8+4*d,10);
    }
    const vector=model.extrude(top,[0,0,0.25]);
    expect(volume(vector)).toBeCloseTo(9,10);
  });
  it('gives each connected component its own vector and reports zero vectors',()=>{
    const model=sheet();
    const faces=model.faces;
    const left=faces.filter(f=>f.centroid[0]<-1),right=faces.filter(f=>f.centroid[0]>1);
    const region=left.union(right);
    expect(region.components().length).toBe(2);
    const out=model.extrude(region,r=>[0,0,r.index===0?1:2]);
    expect(new Set(kept(out,region).map(f=>heights(f)[0]))).toEqual(new Set([1,2]));
    expect(out.faces.length).toBe(model.faces.length+left.boundaryEdges().length+right.boundaryEdges().length);
    // A component with no vector is left where it is; the other still extrudes.
    const partial=model.extrude(region,r=>[0,0,r.index]);
    expect(walls(partial,model).length).toBe(right.boundaryEdges().length);
  });
  it('walls hole loops and open sheet edges',()=>{
    const model=sheet();
    const ring=model.faces.filter(f=>!(Math.abs(f.centroid[0])<1&&Math.abs(f.centroid[1])<1));
    expect(ring.length).toBe(12);
    expect(ring.components().length).toBe(1);
    const out=model.extrude(ring,[0,0,1]);
    // Outer loop (open sheet boundary, 16 edges) plus the hole loop (8 edges).
    expect(out.faces.length).toBe(model.faces.length+24);
    const centre=model.faces.filter(f=>Math.abs(f.centroid[0])<1&&Math.abs(f.centroid[1])<1);
    for(const same of kept(out,centre))expect(heights(same).every(z=>z===0)).toBe(true);
    expect(out.edges.every(e=>e.faces.length<=2)).toBe(true);
    const made=walls(out,model);
    expect(made.every(f=>f.corners.length===4)).toBe(true);
    expect(made.filter(f=>f.corners.every(c=>c.chart==='extrude:side:0')).length).toBe(24);
  });
  it('rejects closed shells, foreign selections and bad offsets',()=>{
    const model=box(1);
    // A closed shell has no boundary to raise walls from: nothing to extrude.
    expect(model.extrude(model.faces,[0,0,1]).faces.length).toBe(model.faces.length);
    // Identity is minted: another construction of the same box is another
    // value, and its faces name nothing here.
    const other=box(1);
    expect(()=>model.extrude(other.faces,[0,0,1])).toThrow('unrelated');
    expect(()=>model.extrude(model.points as any,[0,0,1])).toThrow('extrude');
    expect(model.extrude(model.faces.filter(f=>f.normal[2]>0.9),{distance:Number.NaN}).faces.length).toBe(model.faces.length);
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
    expect(cancelling.extrude(both,{distance:1}).faces.length).toBe(cancelling.faces.length);
  });
  it('retains cap corner UVs and generates continuous side charts',()=>{
    const model=plane(2,2).subdivide(1);
    const region=model.faces.filter(f=>f.centroid[0]<0);
    const out=model.extrude(region,[0,0,1]);
    for(const f of region){
      const cap=kept(out,model.faces.rows(f)).at(0)!;
      // The cap keeps its corners: the same rows, with the same values.
      expect(cap.corners.every(c=>model.corners.has(c))).toBe(true);
      expect(cap.corners.map(c=>c.uv)).toEqual(f.corners.map(c=>c.uv));
      expect(cap.corners.every(c=>c.chart==='plane')).toBe(true);
    }
    const made=walls(out,model);
    expect(made.length).toBe(region.boundaryEdges().length);
    const uvs=[...made].flatMap(f=>f.corners.map(c=>c.uv as number[]));
    const u=uvs.map(uv=>uv[0]),v=uvs.map(uv=>uv[1]);
    expect(u.every(n=>n>=0&&n<=1)).toBe(true);expect(Math.max(...u)).toBe(1);expect(Math.min(...u)).toBe(0);
    expect(new Set(v)).toEqual(new Set([0,1]));
    // Every wall bottom corner at u0 pairs with a top corner at the same u.
    for(const f of made){const uv=f.corners.map(c=>c.uv as number[]);expect(uv[0][0]).toBe(uv[3][0]);expect(uv[1][0]).toBe(uv[2][0]);}
    // Read through the ordinary typed corner collection.
    expect(out.corners.filter(c=>c.chart==='extrude:side:0').length).toBe(made.length*4);
  });
  it('keeps IDs stable and unique across a second extrusion, and subdivides afterwards',()=>{
    const model=sheet();
    const select=(m:typeof model)=>m.faces.filter(f=>Math.abs(f.centroid[0])<1.5&&Math.abs(f.centroid[1])<1.5&&f.centroid[2]!>=0);
    const once=model.extrude(select(model),[0,0,0.5],{key:'tower'});
    const again=model.extrude(select(model),[0,0,0.5],{key:'tower'});
    expect(mesh3(again).names.points).toEqual(mesh3(once).names.points);
    expect(mesh3(again).names.faces).toEqual(mesh3(once).names.faces);
    const caps=once.faces.filter(f=>f.centroid[2]===0.5&&f.normal[2]>0.9);
    expect(caps.length).toBe(4);
    const twice=once.extrude(caps,[0,0,0.5],{key:'tower'});
    expect(new Set(mesh3(twice).names.points).size).toBe(twice.points.length);
    expect(twice.faces.length).toBe(once.faces.length+8);
    expect(twice.faces.filter(f=>f.centroid[2]===1&&f.normal[2]>0.9).length).toBe(4);
    const refined=twice.subdivide(1);
    expect(refined.faces.length).toBe(twice.faces.length*4);
    expect(refined.corners.every(c=>Array.isArray(c.uv)&&typeof c.chart==='string')).toBe(true);
  });
  it('copies attributes to walls and edges without adding label columns',()=>{
    const model=plane(2,2).subdivide(1).faces.set({tone:(f)=>f.centroid[0]<0?0.7:0.2}).edges.set({marked:1});
    const region=model.faces.filter(f=>f.centroid[0]<0);
    const out=model.extrude(region,[0,0,1]);
    expect(walls(out,model).every(f=>f.tone===0.7)).toBe(true);
    // No label columns: the faces hold what they held, the points nothing.
    expect(Object.keys(mesh3(out).cols.faces).sort()).toEqual(['chart','tone']);
    expect(Object.keys(mesh3(out).cols.points)).toEqual([]);
    // An edge the extrusion made from a boundary edge (its copy on the cap, the
    // side rising from its start) answers that edge, and holds its columns.
    const generated=out.edges.filter(e=>!model.edges.has(e)&&e.source!==undefined);
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.every(e=>model.edges.has(e.source)&&e.marked===1)).toBe(true);
  });
});

import {readFileSync} from 'node:fs';
import {beforeAll,describe,it,expect} from 'vitest';
import {initOcclude} from '../src/index.js';
import {box,sphere,plane,mesh} from '../src/three/api/index.js';

beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));

const unique=(ids:readonly string[])=>new Set(ids).size===ids.length;
const sheet=()=>plane(4,4).subdivide(2); // 16 faces, 4 × 4, one unit each
const cell=(m:ReturnType<typeof sheet>,i:number,j:number)=>m.faces.filter(f=>Math.abs(f.centroid[0]-(-1.5+i))<1e-9&&Math.abs(f.centroid[1]-(-1.5+j))<1e-9);

describe('G3-29 3D selections resolve by id',()=>{
  it('G3-29 corner.in(solid) after a boolean subtract keeps the top faces that survive, by id',()=>{
    const block=box(2).subdivide(1);
    const corner=block.faces.filter(f=>f.centroid[2]>0.9).groupBy(()=>'top')[0];
    const solid=block.subtract(sphere(0.9,{segments:20,rings:10}).translate([1,1,1]));
    const stillTop=corner.in(solid);
    const ids=new Set(corner.map(f=>f.id));
    expect(stillTop.source).toBe(solid.surface);
    expect(stillTop.map(f=>f.id)).toEqual(solid.faces.filter(f=>ids.has(f.id)).map(f=>f.id));
    expect(stillTop.length).toBeGreaterThan(0);
    expect(stillTop.length).toBeLessThanOrEqual(corner.length);
    expect(stillTop.key).toBe('top');
    // Reading it back on its own revision is the identity.
    expect(corner.in(block).indices).toEqual(corner.indices);
    // Resolving among a selection of the target revision.
    expect(corner.in(solid.faces.filter(()=>false)).length).toBe(0);
    expect(()=>corner.in(solid.points as never)).toThrow('expected faces, got points');
    expect(()=>corner.in({} as never)).toThrow('has no faces');
  });
  it('G3-29 rim.has(e) answers for the edges of an extruded revision by id',()=>{
    const m=sheet(),part=cell(m,1,1);
    const rim=part.boundaryEdges();
    const out=m.extrude(part,{distance:0.3});
    const kept=out.edges.filter(e=>rim.has(e));
    expect(kept.length).toBe(rim.length);
    expect(kept.map(e=>e.id).sort()).toEqual(rim.map(e=>e.id).sort());
    expect(out.edges.filter(e=>!rim.has(e)).length).toBe(out.edges.length-rim.length);
    expect(()=>rim.has(out.faces.at(0) as never)).toThrow('expected edge, received face');
    expect(()=>rim.has({...out.edges.at(0)!})).toThrow('expected a edge row');
  });
  it('G3-29 set operations resolve a stale operand by id; a different domain still refuses',()=>{
    const m=sheet(),a=cell(m,0,0).union(cell(m,1,0)),b=cell(m,1,0);
    const next=m.extrude(cell(m,3,3),[0,0,1]);
    const nextA=a.in(next);
    expect(nextA.subtract(b).map(f=>f.id)).toEqual(cell(m,0,0).map(f=>f.id));
    expect(nextA.intersect(b).map(f=>f.id)).toEqual(b.map(f=>f.id));
    expect(next.faces.filter(()=>false).union(a).map(f=>f.id).sort()).toEqual(a.map(f=>f.id).sort());
    expect(()=>nextA.union(m.points as never)).toThrow('same domain');
  });
  it('G3-29 a single stale row edits the row with its id, not the one at its old index',()=>{
    const block=box(2).subdivide(1).faceAttribute('tone',0);
    const solid=block.subtract(sphere(0.9,{segments:20,rings:10}).translate([1,1,1]));
    const row=block.faces.find(f=>{const now=solid.faces.find(g=>g.id===f.id);return now&&now.index!==f.index;})!;
    expect(row).toBeDefined();
    const out=solid.steps(1,(_,next)=>next.setFace(row as never,{tone:1}));
    expect(out.faces.filter(f=>f.tone===1).map(f=>f.id)).toEqual([row.id]);
    expect(solid.faces.rows(row as never).map(f=>f.id)).toEqual([row.id]);
  });
  it('G3-29 predicates answer by truthiness, as arrays do',()=>{
    const m=sheet();
    expect(m.faces.filter(f=>f.index%2&&f.id).length).toBe(8);
    expect(m.faces.find(f=>f.index===3&&f)?.index).toBe(3);
    expect(m.faces.some(f=>f.index===20||null)).toBe(false);
    expect(m.faces.every(f=>f.id)).toBe(true);
  });
  it('G3-29 extrude takes a stale selection and resolves it by id',()=>{
    const m=sheet(),first=cell(m,0,0),grown=first.union(first.adjacent());
    const once=m.extrude(first,{distance:0.4});
    // grown comes from m, not from once: it is read on once by id.
    const twice=once.extrude(grown,{distance:0.2});
    expect(unique(twice.surface.points.map(p=>p.id))).toBe(true);
    expect(unique(twice.surface.faces.map(f=>f.id))).toBe(true);
    const ids=new Set(grown.map(f=>f.id));
    expect(twice.faces.filter(f=>ids.has(f.id)).every(f=>f.centroid[2]>0.1)).toBe(true);
  });
});

describe('G3-30 extrusion mints a fresh id per copy of a shared corner',()=>{
  it('G3-30 two parts that share a corner extrude in one call',()=>{
    const m=sheet(),parts=cell(m,1,1).union(cell(m,2,2));
    expect(parts.components().length).toBe(2);
    const out=m.extrude(parts,{distance:0.4});
    expect(unique(out.surface.points.map(p=>p.id))).toBe(true);
    expect(unique(out.surface.faces.map(f=>f.id))).toBe(true);
    // The shared corner (0, 0) is copied once per part, at each part's height.
    const lifted=out.surface.points.filter(p=>p.position[0]===0&&p.position[1]===0).map(p=>p.position[2]).sort();
    expect(lifted).toEqual([0,0.4,0.4]);
    expect(out.surface.faces.length).toBe(16+8);
  });
  it('G3-30 parts extruded in two calls that share a corner, re-selected by id or stale',()=>{
    const m=sheet(),parts=cell(m,1,1).union(cell(m,2,2)).components();
    let byId=m;
    for(const part of parts){const ids=new Set(part.map(f=>f.id));byId=byId.extrude(byId.faces.filter(f=>ids.has(f.id)),{distance:0.3+0.2*parts.indexOf(part)});}
    let stale=m;
    for(const part of parts)stale=stale.extrude(part,{distance:0.3+0.2*parts.indexOf(part)});
    for(const out of [byId,stale]){
      expect(unique(out.surface.points.map(p=>p.id))).toBe(true);
      expect(unique(out.surface.faces.map(f=>f.id))).toBe(true);
      expect(out.surface.faces.length).toBe(16+8);
      const lifted=out.surface.points.filter(p=>p.position[0]===0&&p.position[1]===0).map(p=>p.position[2]).sort();
      expect(lifted).toEqual([0,0.3,0.5]);
    }
    expect(stale.surface.points.map(p=>p.id)).toEqual(byId.surface.points.map(p=>p.id));
  });
  it('G3-30 a non-shared extrusion keeps the plain generated ids',()=>{
    const m=sheet(),out=m.extrude(cell(m,1,1),[0,0,1]);
    const minted=out.surface.points.filter(p=>p.provenance?.operation==='extrude').map(p=>JSON.parse(p.id));
    expect(minted.length).toBe(4);
    expect(minted.every(parts=>parts.length===4&&parts[2]==='point')).toBe(true);
  });
  it('G3-30 two fans meeting at one vertex extrude in one call, as they do in two',()=>{
    // Two open pyramids that meet only at their apex: a non-manifold vertex.
    const up=[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]] as [number,number,number][];
    const down=up.map(([x,y])=>[x,y,-1] as [number,number,number]);
    const bowtie=mesh([[0,0,0],...up,...down],[[0,1,2],[0,2,3],[0,3,4],[0,4,1],[0,6,5],[0,7,6],[0,8,7],[0,5,8]]);
    const top=bowtie.faces.filter(f=>f.index<4),bottom=bowtie.faces.filter(f=>f.index>=4);
    const both=bowtie.extrude(top.union(bottom),f=>f.index===0?[0,0,1]:[0,0,-1]);
    const apart=bowtie.extrude(top,[0,0,1]).extrude(bottom,[0,0,-1]);
    for(const out of [both,apart]){
      expect(unique(out.surface.points.map(p=>p.id))).toBe(true);
      const apex=out.surface.points.filter(p=>p.position[0]===0&&p.position[1]===0).map(p=>p.position[2]).sort();
      expect(apex).toEqual([-1,1]);
    }
  });
});

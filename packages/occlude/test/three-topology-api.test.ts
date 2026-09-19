import {describe,it,expect,expectTypeOf} from 'vitest';
import {plane,box,mesh,pointCloud} from 'occlude/3d';
import {topology3} from '../src/three/geometry/topology.js';
import {surface3} from '../src/three/geometry/surface.js';

describe('owned mesh topology relationships',()=>{
  it('exposes typed incident rows without triangulation diagonals',()=>{
    const model=box().attributes({weight:2}).edgeAttributes({ink:'outline'}).faceAttributes({tone:0.5});
    const vectorFace=model.faceAttribute('vector',[1,2]).faces.at(0)!;
    expect(Object.isFrozen(vectorFace.attributes.vector)).toBe(true);
    expect(()=>{(vectorFace.attributes.vector as number[])[0]=9;}).toThrow();
    const face=model.faces.at(0)!;
    expect(face.points.length).toBe(4);expect(face.edges.length).toBe(4);expect(face.adjacent.length).toBe(4);
    expect(face.points.every(p=>p.weight===2&&p.faces.length===3&&p.edges.length===3&&p.adjacent.length===3)).toBe(true);
    expect(face.edges.every(e=>e.ink==='outline'&&e.faces.length===2&&e.points.has(e.a)&&e.points.has(e.b))).toBe(true);
    expectTypeOf(face.points.at(0)!.weight).toEqualTypeOf<2>();
    expectTypeOf(face.edges.at(0)!.faces.at(0)!.tone).toEqualTypeOf<0.5>();
    expect(()=>JSON.stringify(face)).not.toThrow();
    expect(Object.keys(face)).not.toContain('points');
    expect(model.faces.boundaryEdges().length).toBe(0);
    expect('faces' in pointCloud([[0,0,0]]).points).toBe(false);
  });
  it('preserves relationship capabilities through selection algebra and groups',()=>{
    const model=plane(2).subdivide(1).faceAttribute('group',f=>f.center[0]<0?'left':'right');
    const left=model.faces.filter(f=>f.group==='left');
    expect(left.length).toBe(2);expect(left.points.length).toBe(6);expect(left.edges.length).toBe(7);expect(left.boundaryEdges().length).toBe(6);
    expect(left.complement().union(left).connected().length).toBe(4);
    expect(left.intersect(model.faces).components().map(g=>g.length)).toEqual([2]);
    expect(model.faces.groupBy(f=>f.group).map(g=>[g.key,g.boundaryEdges().length])).toEqual([['left',6],['right',6]]);
    expect(left.subtract(left).components()).toEqual([]);
    expect(left.extract().faces.boundaryEdges().length).toBe(6);
    expect(left.points.extract().points.length).toBe(6);
  });
  it('distinguishes edge-connected faces from coincident or vertex-touching sheets',()=>{
    const model=mesh([[0,0,0],[1,0,0],[0,1,0],[-1,0,0],[0,-1,0],[0,0,0],[1,0,0],[0,1,0]],[[0,1,2],[0,3,4],[5,6,7]]);
    expect(model.faces.components().map(c=>c.indices)).toEqual([[0],[1],[2]]);
    expect(model.faces.filter(f=>f.index===0).connected().indices).toEqual([0]);
    expect(model.points.components().map(c=>c.indices)).toEqual([[0,1,2,3,4],[5,6,7]]);
    expect(model.points.filter(p=>p.index===0).connected().indices).toEqual([0,1,2,3,4]);
  });
  it('keeps adjacency cached through motion/state edits, but measurements and ownership fresh',()=>{
    const model=plane(2).subdivide(1),before=topology3(model.surface);
    const moved=model.displace(p=>[0,0,p.x*p.y]).attributes({age:0}).steps(1,(current,next)=>next.set(current.points,p=>({age:p.faces.length})));
    expect(topology3(moved.surface)).toBe(before);
    expect(moved.points.at(0)!.z).not.toBe(model.points.at(0)!.z);
    expect(moved.faces.at(0)!.area).toBeGreaterThan(model.faces.at(0)!.area);
    expect(()=>model.faces.union(moved.faces)).toThrow('source revision');
    expect(moved.points.has(model.faces.at(0)!.points.at(0)! as any)).toBe(false);
    expect(topology3(model.subdivide().surface)).not.toBe(before);
    expect(topology3(model.faces.filter(f=>f.index===0).extract().surface)).not.toBe(before);
    expect(Object.isFrozen(before.faceNeighbors[0])).toBe(true);
  });
  it('evaluates rich relationships in attribute and displacement fields against frozen input',()=>{
    const model=plane(2).subdivide(1).attributes({mass:1}).faceAttributes({total:f=>f.points.map(p=>p.mass).reduce((a,b)=>a+b,0)})
      .attribute('degree',p=>p.adjacent.length).edgeAttributes({touch:e=>e.faces.length})
      .steps(1,(current,next)=>{
        next.setFaces(current.faces,f=>({total:f.points.map(p=>p.mass).reduce((a,b)=>a+b,0)+1}));
        next.move(current.points,p=>[0,0,p.faces.length]);
      });
    expect(model.faces.every(f=>f.total===5)).toBe(true);
    expect(model.points.find(p=>p.x===0&&p.y===0)!.z).toBe(4);
    expect(model.edges.some(e=>e.touch===2)).toBe(true);
    expect(model.displace(p=>[0,0,p.edges.length]).points.find(p=>p.x===0&&p.y===0)!.z).toBe(8);
  });
  it('invalidates cached adjacency on mutable advanced inputs',()=>{
    const surface=surface3([[0,0,0],[1,0,0],[0,1,0],[1,1,0]],[[0,1,2]]);
    const before=topology3(surface);
    (surface as any).edges=[...surface.edges,{id:'loose',vertices:[1,3],faces:[],attributes:{}}];
    expect(topology3(surface)).not.toBe(before);
    expect(topology3(surface).pointNeighbors[3]).toEqual([1]);
  });
});

describe('3D edge selections say the three relations words', () => {
  it('adjacent() is every edge meeting a member at a vertex, members excluded', () => {
    const m = plane(2, 2).subdivide(1);
    const one = m.edges.filter((e) => e.index === 0);
    const out = one.adjacent();
    expect(out.indices).not.toContain(0);
    // Every one of them shares an end with edge 0.
    const ends = new Set(m.surface.edges[0].vertices);
    for (const i of out.indices) expect(m.surface.edges[i].vertices.some((v) => ends.has(v))).toBe(true);
  });

  it('connected() reaches the whole piece, and a whole mesh is one', () => {
    const m = plane(2, 2).subdivide(1);
    expect(m.edges.filter((e) => e.index === 0).connected().length).toBe(m.edges.length);
  });

  it('components() splits a selection into its pieces', () => {
    const m = plane(2, 2).subdivide(2);
    // Two edges that share no vertex are two pieces.
    const a = m.edges.at(0)!;
    const ends: readonly number[] = a.vertices;
    const apart = m.edges.filter((e) => e.index === a.index || (e.index > a.index && !e.vertices.some((v) => ends.includes(v))));
    const pieces = apart.components();
    expect(pieces.length).toBeGreaterThan(1);
    // Together the pieces hold exactly the members, once each.
    expect(pieces.flatMap((p) => [...p.indices]).sort((x, y) => x - y)).toEqual([...apart.indices]);
  });

  it('edges.edges is itself, as it is in 2D', () => {
    const m = plane(2, 2).subdivide(1);
    const sel = m.edges.filter((e) => e.index < 3);
    expect(sel.edges).toBe(sel);
  });
});

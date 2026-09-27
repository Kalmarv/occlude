import {describe,it,expect} from 'vitest';
import {plane,box,mesh,pointCloud} from 'occlude/3d';
import {Mesh3,mesh3,sameAttachment3} from '../src/three/geometry/mesh3.js';

describe('owned mesh topology relationships',()=>{
  it('exposes typed incident rows without triangulation diagonals',()=>{
    const model=box().points.set({weight:2}).edges.set({ink:'outline'}).faces.set({tone:0.5});
    const vectorFace=model.faces.set('vector',[1,2]).faces.at(0)!;
    expect(Object.isFrozen(vectorFace.vector)).toBe(true);
    expect(()=>{(vectorFace.vector as number[])[0]=9;}).toThrow();
    const face=model.faces.at(0)!;
    expect(face.points.length).toBe(4);expect(face.edges.length).toBe(4);expect(face.adjacent.length).toBe(4);
    expect(face.points.every(p=>p.weight===2&&p.faces.length===3&&p.edges.length===3&&p.adjacent.length===3)).toBe(true);
    expect(face.edges.every(e=>e.ink==='outline'&&e.faces.length===2&&face.points.has(e.a)&&face.points.has(e.b))).toBe(true);
    
    
    expect(()=>JSON.stringify(face)).not.toThrow();
    expect(Object.keys(face)).not.toContain('points');
    expect(model.faces.boundaryEdges().length).toBe(0);
    expect('faces' in pointCloud([[0,0,0]]).points).toBe(false);
  });
  it('preserves relationship capabilities through selection algebra and groups',()=>{
    const model=plane(2).subdivide(1).faces.set('group',f=>f.centroid[0]<0?'left':'right');
    const left=model.faces.filter(f=>f.group==='left');
    expect(left.length).toBe(2);expect(left.points.length).toBe(6);expect(left.edges.length).toBe(7);expect(left.boundaryEdges().length).toBe(6);
    expect(model.faces.without(left).union(left).connected().length).toBe(4);
    expect(left.intersect(model.faces).components().map(g=>g.length)).toEqual([2]);
    expect(model.faces.groupBy(f=>f.group).map(g=>[g.key,g.boundaryEdges().length])).toEqual([['left',6],['right',6]]);
    expect(left.without(left).components()).toEqual([]);
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
    const model=plane(2).subdivide(1),before=mesh3(model);
    const moved=model.displace(p=>[0,0,p.x*p.y]).points.set({age:0}).points.set({age:p=>p.faces.length});
    const after=mesh3(moved);
    expect(after.pointFaces).toBe(before.pointFaces);
    expect(after.faceNeighbors).toBe(before.faceNeighbors);
    expect(after.edgeFaces).toBe(before.edgeFaces);
    expect(moved.points.at(0)!.z).not.toBe(model.points.at(0)!.z);
    expect(moved.faces.at(0)!.area).toBeGreaterThan(model.faces.at(0)!.area);
    // Revisions of one mesh resolve by id (spec 58, G3-29).
    expect(model.faces.union(moved.faces).length).toBe(model.faces.length);
    expect(moved.points.has(model.faces.at(0)!.points.at(0)! as any)).toBe(true);
    expect(mesh3(model.subdivide()).faceNeighbors).not.toBe(before.faceNeighbors);
    expect(mesh3(model.faces.filter(f=>f.index===0).extract()).faceNeighbors).not.toBe(before.faceNeighbors);
    expect(Object.isFrozen(before.faceNeighbors[0])).toBe(true);
  });
  it('evaluates rich relationships in attribute and displacement fields against frozen input',()=>{
    const model=plane(2).subdivide(1).points.set({mass:1}).faces.set({total:f=>f.points.map(p=>p.mass).reduce((a,b)=>a+b,0)})
      .points.set('degree',p=>p.adjacent.length).edges.set({touch:e=>e.faces.length})
      .faces.set({total:f=>f.points.map(p=>p.mass).reduce((a,b)=>a+b,0)+1})
      .displace(p=>[0,0,p.faces.length]);
    expect(model.faces.every(f=>f.total===5)).toBe(true);
    expect(model.points.find(p=>p.x===0&&p.y===0)!.z).toBe(4);
    expect(model.edges.some(e=>e.touch===2)).toBe(true);
    expect(model.displace(p=>[0,0,p.edges.length]).points.find(p=>p.x===0&&p.y===0)!.z).toBe(8);
  });
  it('reads the faces on each edge per edge list: the same loops with a loose edge added',()=>{
    const faces=mesh([[0,0,0],[1,0,0],[0,1,0],[1,1,0]],[[0,1,2]]),read=mesh3(faces);
    // A reader over the same statement of faces and one more edge, as a
    // kernel builds one: the incidence of the faces is shared, the faces on
    // each edge are the new list's, and reading one does not disturb the other.
    const loose=new Mesh3({x:read.x,y:read.y,z:read.z,loops:read.loops,edges:Uint32Array.from([...read.edges,1,3]),
      names:()=>read.names,cols:()=>read.cols,topology:read.topology});
    expect(read.edgeFaces).toEqual([[0],[0],[0]]);
    expect(loose.edgeFaces).toEqual([[0],[0],[0],[]]);
    expect(read.edgeFaces).toEqual([[0],[0],[0]]);
    expect(loose.faceNeighbors).toBe(read.faceNeighbors);
  });
  it('attaches by lineage: a column write and a mirror keep the surface, an equal independent build does not',()=>{
    const model=plane(2).subdivide(1),read=mesh3(model);
    expect(sameAttachment3(read,mesh3(model.corners.set('w',1)))).toBe(true);
    expect(sameAttachment3(read,mesh3(model.faces.set({tone:0.5}).points.set({age:1})))).toBe(true);
    const mirrored=model.scale([-1,1,1]);
    expect(mesh3(mirrored).loops[0]).toEqual([...read.loops[0]].reverse());
    expect(sameAttachment3(read,mesh3(mirrored))).toBe(true);
    expect(sameAttachment3(read,mesh3(model.subdivide()))).toBe(false);
    const points=[[0,0,0],[1,0,0],[1,1,0],[0,1,0]] as [number,number,number][],loops=[[0,1,2],[0,2,3]];
    const a=mesh3(mesh(points,loops)),b=mesh3(mesh(points,loops));
    expect(b.names).toEqual(a.names);
    expect(sameAttachment3(a,b)).toBe(false);
  });
});

describe('3D edge selections say the three relations words', () => {
  it('adjacent() is every edge meeting a member at a vertex, members excluded', () => {
    const m = plane(2, 2).subdivide(1);
    const one = m.edges.filter((e) => e.index === 0);
    const out = one.adjacent();
    expect(out.indices).not.toContain(0);
    // Every one of them shares an end with edge 0.
    const first = m.edges.at(0)!;
    const ends = new Set([first.a.index, first.b.index]);
    for (const e of out) expect(ends.has(e.a.index) || ends.has(e.b.index)).toBe(true);
  });

  it('connected() reaches the whole piece, and a whole mesh is one', () => {
    const m = plane(2, 2).subdivide(1);
    expect(m.edges.filter((e) => e.index === 0).connected().length).toBe(m.edges.length);
  });

  it('components() splits a selection into its pieces', () => {
    const m = plane(2, 2).subdivide(2);
    // Two edges that share no vertex are two pieces.
    const a = m.edges.at(0)!;
    const ends: readonly number[] = [a.a.index, a.b.index];
    const apart = m.edges.filter((e) => e.index === a.index || (e.index > a.index && ![e.a.index, e.b.index].some((v) => ends.includes(v))));
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

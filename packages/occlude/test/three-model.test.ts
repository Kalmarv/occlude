import {describe,it,expect} from 'vitest';
import {box3} from '../src/three/geometry/surface.js';
import {grid3,FaceSelection3,measureFaces3,extrudeFaces3,transformSurface3,cloneSurface3,stepsSurface3} from '../src/three/geometry/model.js';
import {dot3,cross3} from '../src/three/math.js';
const volume=(s:ReturnType<typeof box3>)=>s.triangles.reduce((sum,t)=>{const [a,b,c]=t.vertices.map(v=>s.points[v].position);return sum+dot3(a,cross3(b,c))/6;},0);
describe('procedural surface construction',()=>{
  it('builds a connected editable grid with measures and adjacency',()=>{
    const s=grid3(3,2,[6,4]);expect(s.points).toHaveLength(12);expect(s.faces).toHaveLength(6);expect(s.triangles).toHaveLength(12);
    const faces=new FaceSelection3(s);expect(faces.filter(f=>Math.abs(f.area-4)<1e-12).length).toBe(6);expect(faces.filter(f=>f.normal[2]===1).length).toBe(6);
    expect(new FaceSelection3(s,[0]).adjacent().indices).toEqual([1,3]);s.faces[1].attributes.selected=true;
    expect(new FaceSelection3(s).filter(f=>f.attributes.selected===true).indices).toEqual([1]);
  });
  it('replaces caps while retaining shared input positions, IDs and edge attributes',()=>{
    const s=grid3(3,1,[3,1]);s.faces[0].attributes.material='stone';s.edges[0].attributes.marked=true;
    const original=JSON.stringify(s),out=extrudeFaces3(s,new FaceSelection3(s,[0,2]),f=>f.index+1,{operation:'towers'});
    expect(JSON.stringify(s)).toBe(original);expect(out.faces).toHaveLength(11);
    expect(out.points.slice(0,s.points.length).map(p=>p.position)).toEqual(s.points.map(p=>p.position));
    expect(out.faces.find(f=>f.id===s.faces[1].id)!.vertices).toEqual(s.faces[1].vertices);
    expect(out.faces.filter(f=>f.attributes.parentFace==='f0')).toHaveLength(5);
    expect(out.edges.some(e=>e.attributes.parentEdge===s.edges[0].id&&e.attributes.marked===true)).toBe(true);
    expect(out.points.filter(p=>p.attributes.parentPoint).map(p=>p.position[2])).toEqual([1,1,1,1,3,3,3,3]);
  });
  it('preserves closed winding for positive and negative distances, and zero is topology-free',()=>{
    const s=box3([2,2,2]),top=new FaceSelection3(s).filter(f=>f.normal[2]>.9);
    for(const d of [1,-.5]){const out=extrudeFaces3(s,top,d,{operation:'top'});expect(out.edges.every(e=>e.faces.length===2)).toBe(true);expect(volume(out)).toBeCloseTo(8+4*d,10);}
    const unchanged=extrudeFaces3(s,top,0,{operation:'zero'});expect(unchanged).toEqual(s);expect(unchanged).not.toBe(s);
  });
  it('conserves extensive face totals while copying labels',()=>{
    const s=grid3(1,1,[2,2]);s.faces[0].attributes.mass=12;s.faces[0].attributes.material='ink';
    const out=extrudeFaces3(s,new FaceSelection3(s),1,{operation:'mass',extensiveFaceAttributes:['mass']});
    expect(out.faces.reduce((a,f)=>a+Number(f.attributes.mass),0)).toBeCloseTo(12);expect(out.faces.every(f=>f.attributes.material==='ink')).toBe(true);
    const measures=measureFaces3(out);expect(measures.reduce((a,f)=>a+f.area,0)).toBe(12);
  });
  it('retains a folded cap triangulation instead of retriangulating its projection',()=>{
    const s=grid3(1,1,[2,2]);s.points[0].position=[-1,-1,.5];
    const out=extrudeFaces3(s,new FaceSelection3(s),1,{operation:'fold'});expect(out.triangles.filter(t=>t.face===0)).toHaveLength(2);
    expect(out.faces).toHaveLength(5);expect(out.triangles).toHaveLength(10);
  });
  it('applies explicit pivots and keeps mirrored winding outward',()=>{
    const s=box3([2,2,2]),out=transformSurface3(s,{scale:[-2,3,4],rotate:[30,20,10],translate:[4,5,6]});
    expect(volume(out)).toBeCloseTo(8*24,9);expect(out.faces.map(f=>f.id)).toEqual(s.faces.map(f=>f.id));
    const translated=transformSurface3(s,{translate:[1,2,3]});expect(translated.points[0].position).toEqual([0,1,2]);
    expect(()=>transformSurface3(s,{scale:[0,1,1]})).toThrow(/nonsingular/);
  });
  it('captures frozen inputs, commits in order, bounds history and rejects old selections',()=>{
    const s=grid3(1,1),old=new FaceSelection3(s);const seen:number[]=[];
    const result=stepsSurface3(s,4,(input,i)=>{seen.push(input.points[0].position[2]);expect(()=>{input.points[0].position=[9,9,9];}).toThrow();expect(()=>extrudeFaces3(input,old,1,{operation:'stale'})).toThrow(/another surface/);const out=cloneSurface3(input);out.points.forEach(p=>p.position=[p.position[0],p.position[1],i+1]);return out;},{history:2});
    expect(seen).toEqual([0,1,2,3]);expect(result.history.map(h=>h.points[0].position[2])).toEqual([3,4]);expect(result.surface.points[0].position[2]).toBe(4);expect(s.points[0].position[2]).toBe(0);
  });
  it('rejects coincident adjacent walls and nonfinite callback output',()=>{
    const s=grid3(2,1);expect(()=>extrudeFaces3(s,new FaceSelection3(s),1,{operation:'bad'})).toThrow(/nonadjacent/);
    expect(()=>extrudeFaces3(s,new FaceSelection3(s,[0]),()=>NaN,{operation:'bad'})).toThrow(/finite/);
    expect(()=>grid3(0,1)).toThrow();expect(()=>new FaceSelection3(s,[99])).toThrow();
  });
});

import {describe,it,expect} from 'vitest';
import {grid3,transformSurface3} from '../src/three/geometry/model.js';
import {adjacency3,deformSurfaceCpu3} from '../src/three/geometry/deform.js';
describe('frozen deformation reference',()=>{
  it('gathers only original neighbors from the prior pass, with exact pins',()=>{
    const s=grid3(1,1,[2,2]),csr=adjacency3(s);
    expect([...csr.offsets]).toEqual([0,2,4,6,8]);expect([...csr.neighbors]).toEqual([1,2,0,3,0,3,1,2]);
    const out=deformSurfaceCpu3(s,{iterations:1,relaxation:.5,pinned:[0],displacements:s.points.map(()=>[0,0,.1])});
    expect(out.points.map(p=>p.position)).toEqual([[-1,-1,0],[.5,-.5,.1],[-.5,.5,.1],[.5,.5,.1]]);
    expect(s.points[1].position).toEqual([1,-1,0]);expect(out.faces.map(f=>f.id)).toEqual(s.faces.map(f=>f.id));
  });
  it('is translation-equivariant and validates batches before execution',()=>{
    const s=grid3(2,2),options={iterations:5,relaxation:.2};
    const a=deformSurfaceCpu3(s,options),b=deformSurfaceCpu3(transformSurface3(s,{translate:[5,-3,9]}),options);
    a.points.forEach((p,i)=>p.position.forEach((v,k)=>expect(b.points[i].position[k]).toBeCloseTo(v+[5,-3,9][k],12)));
    expect(()=>deformSurfaceCpu3(s,{...options,pinned:[99]})).toThrow(/pinned/);expect(()=>deformSurfaceCpu3(s,{...options,iterations:1.5})).toThrow(/iterations/);
    expect(()=>deformSurfaceCpu3(s,{...options,displacements:[]})).toThrow(/displacement/);
    const abort=new AbortController();abort.abort();expect(()=>deformSurfaceCpu3(s,{...options,signal:abort.signal})).toThrow();
  });
});

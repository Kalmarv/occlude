import {describe,it,expect} from 'vitest';
import {mesh} from '../src/three/api/mesh.js';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {adjacency3,deformCpu3} from '../src/three/geometry/deform.js';
import type {Vec3} from '../src/three/math.js';
/** A flat grid of `columns × rows` quads, `size` across and centred on the
 * origin. */
function grid(columns:number,rows:number,size:readonly [number,number]=[1,1]) {
  const positions:Vec3[]=[],faces:number[][]=[];
  for(let y=0;y<=rows;y++)for(let x=0;x<=columns;x++)positions.push([(x/columns-0.5)*size[0],(y/rows-0.5)*size[1],0]);
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){const p=y*(columns+1)+x;faces.push([p,p+1,p+columns+2,p+columns+1]);}
  return mesh(positions,faces);
}
const places=(p:{x:ArrayLike<number>;y:ArrayLike<number>;z:ArrayLike<number>})=>Array.from(p.x,(x,i)=>[x,p.y[i],p.z[i]]);
describe('frozen deformation reference',()=>{
  it('gathers only original neighbors from the prior pass, with exact pins',()=>{
    const m=grid(1,1,[2,2]),s=mesh3(m),csr=adjacency3(s);
    expect([...csr.offsets]).toEqual([0,2,4,6,8]);expect([...csr.neighbors]).toEqual([1,2,0,3,0,3,1,2]);
    const out=deformCpu3(s,{iterations:1,relaxation:.5,pinned:[0],displacements:m.points.map(()=>[0,0,.1] as Vec3)});
    expect(places(out)).toEqual([[-1,-1,0],[.5,-.5,.1],[-.5,.5,.1],[.5,.5,.1]]);
    expect(places(s)[1]).toEqual([1,-1,0]);
    // Plain arrays deform the same: what a worker is sent.
    expect(deformCpu3({x:s.x,y:s.y,z:s.z,edges:s.edges},{iterations:1,relaxation:.5,pinned:[0],displacements:m.points.map(()=>[0,0,.1] as Vec3)})).toEqual(out);
  });
  it('is translation-equivariant and validates batches before execution',()=>{
    const m=grid(2,2),s=mesh3(m),options={iterations:5,relaxation:.2};
    const a=places(deformCpu3(s,options)),b=places(deformCpu3(mesh3(m.translate([5,-3,9])),options));
    a.forEach((p,i)=>p.forEach((v,k)=>expect(b[i][k]).toBeCloseTo(v+[5,-3,9][k],12)));
    expect(()=>deformCpu3(s,{...options,pinned:[99]})).toThrow(/pinned/);expect(()=>deformCpu3(s,{...options,iterations:1.5})).toThrow(/iterations/);
    expect(()=>deformCpu3(s,{...options,displacements:[]})).toThrow(/displacement/);
    const abort=new AbortController();abort.abort();expect(()=>deformCpu3(s,{...options,signal:abort.signal})).toThrow();
  });
});

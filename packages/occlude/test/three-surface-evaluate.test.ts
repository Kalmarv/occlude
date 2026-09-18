import {describe,expect,it} from 'vitest';
import {box,torus} from '../src/three/api/index.js';
import {surfaceLocation3,type SurfacePlacement3} from '../src/three/geometry/location.js';
import {evaluateSurfaceCpu3,ambiguousTone3,packSurfaceTarget3,type SurfaceEvaluationBatch3} from '../src/three/surface/evaluate.js';
import {lightRecipe3,lightTone3,imageValue3,prefilterPixels3,TONE_QUANTUM,type ImageRecipe3} from '../src/three/surface/tone.js';
import type {Vec3} from '../src/three/math.js';

function lcg(seed:number){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/2**32;};}
/** Location weights for comparison: the third weight closes the sum exactly. */
const weightsAt=(batch:SurfaceEvaluationBatch3,i:number):Vec3=>[batch.weights[i*3],batch.weights[i*3+1],1-batch.weights[i*3]-batch.weights[i*3+1]];
function batchOf(triangles:number,count:number,rnd:()=>number):SurfaceEvaluationBatch3 {
  const triangle=new Uint32Array(count),weights=new Float32Array(count*3);
  for(let i=0;i<count;i++){
    triangle[i]=Math.floor(rnd()*triangles);
    const r=Math.sqrt(rnd()),v=rnd(),w=[1-r,r*(1-v),r*v].map(n=>Math.fround(n));
    const total=w[0]+w[1]+w[2];weights[i*3]=w[0]/total;weights[i*3+1]=w[1]/total;weights[i*3+2]=w[2]/total;
  }
  return {triangle,weights};
}
const placement:SurfacePlacement3={id:'placed',transform:{translate:[3,-2,5],rotate:[20,-35,50],scale:[2,-1.5,0.7],origin:[0.2,0,0.1]}};
function checkerboard(w:number,h:number){const data=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const o=(y*w+x)*4,v=((x+y)&1)?255:40;data[o]=v;data[o+1]=v/2;data[o+2]=255-v;data[o+3]=x*255/(w-1);}return {width:w,height:h,data};}

describe('CPU surface evaluation reference',()=>{
  for(const [name,mesh] of [['box',box([1,2,3])],['torus',torus(1.4,0.45)]] as const){
    it(`matches surface locations on a placed, mirrored, nonuniformly scaled ${name}`,()=>{
      const surface=mesh.surface,rnd=lcg(7),batch=batchOf(surface.triangles.length,300,rnd);
      const recipe=lightRecipe3({direction:[1,2,3],ambient:0.2,ramp:'smooth'});
      const out=evaluateSurfaceCpu3({surface,placement},batch,recipe);
      expect(out.stats.backend).toBe('cpu');expect(out.uv).toBeDefined();
      for(let i=0;i<batch.triangle.length;i++){
        const location=surfaceLocation3(surface,batch.triangle[i],weightsAt(batch,i),{placement});
        for(let k=0;k<3;k++){
          expect(Math.abs(out.position[i*3+k]-location.position[k])).toBeLessThan(1e-5);
          expect(Math.abs(out.normal[i*3+k]-location.normal[k])).toBeLessThan(1e-6);
        }
        expect(Math.abs(out.uv![i*2]-location.uv![0])).toBeLessThan(1e-6);
        expect(Math.abs(out.uv![i*2+1]-location.uv![1])).toBeLessThan(1e-6);
        expect(out.tone![i]).toBe(Math.fround(lightTone3(location.normal,recipe)));
      }
    });
  }
  it('computes reference values in double precision before typed output',()=>{
    const surface=box(2).surface,batch=batchOf(surface.triangles.length,50,lcg(3)),packed=packSurfaceTarget3({surface,placement});
    const out=evaluateSurfaceCpu3({surface,placement},batch);
    for(let i=0;i<batch.triangle.length;i++){
      const location=surfaceLocation3(surface,batch.triangle[i],weightsAt(batch,i),{placement});
      const t=batch.triangle[i];
      for(let k=0;k<3;k++)expect(Math.abs(packed.normals[t*3+k]-location.normal[k])).toBeLessThan(1e-9);
      expect(out.tone).toBeUndefined();
    }
  });
  it('samples chart images identically to the tone reference, with model-space light',()=>{
    const surface=torus(1,0.3).surface,batch=batchOf(surface.triangles.length,200,lcg(11));
    const recipe:ImageRecipe3={kind:'image',name:'checker',pixels:prefilterPixels3(checkerboard(16,9),1,0),channel:'dark',origin:'top-left',wrap:'repeat',area:0.02,uvAttribute:'uv'};
    const out=evaluateSurfaceCpu3({surface,placement},batch,recipe),packed=packSurfaceTarget3({surface,placement});
    const model=evaluateSurfaceCpu3({surface,placement},batch,lightRecipe3({direction:[0,0,1],space:'model'}));
    for(let i=0;i<batch.triangle.length;i++){
      const location=surfaceLocation3(surface,batch.triangle[i],weightsAt(batch,i),{placement});
      const t=batch.triangle[i],w=[batch.weights[i*3],batch.weights[i*3+1],batch.weights[i*3+2]],u=packed.uv!;
      const uv=[u[t*6]*w[0]+u[t*6+2]*w[1]+u[t*6+4]*w[2],u[t*6+1]*w[0]+u[t*6+3]*w[1]+u[t*6+5]*w[2]] as const;
      expect(out.tone![i]).toBe(Math.fround(imageValue3(uv,recipe)));
      expect(Math.abs(out.uv![i*2]-location.uv![0])).toBeLessThan(1e-6);
      expect(model.tone![i]).toBe(Math.fround(lightTone3(location.modelNormal,lightRecipe3({direction:[0,0,1],space:'model'}))));
    }
  });
  it('rejects malformed batches and missing charts for image recipes',()=>{
    const surface=box(1).surface;
    expect(()=>evaluateSurfaceCpu3({surface},{triangle:new Uint32Array([99]),weights:new Float32Array([1,0,0])})).toThrow('missing triangle');
    expect(()=>evaluateSurfaceCpu3({surface},{triangle:new Uint32Array([0]),weights:new Float32Array([0.5,0.5,0.5])})).toThrow('sum to one');
    const plain=box(1).cornerAttributes({label:'x'}).surface,stripped={...plain,faces:plain.faces.map(f=>({...f,corners:f.corners!.map(c=>({...c,attributes:{label:'x'}}))}))};
    const packed=packSurfaceTarget3({surface:stripped});expect(packed.uv).toBeUndefined();
    const recipe:ImageRecipe3={kind:'image',name:'c',pixels:checkerboard(2,2),channel:'lum',origin:'bottom-left',wrap:'clamp',area:0,uvAttribute:'uv'};
    expect(evaluateSurfaceCpu3({surface:stripped},{triangle:new Uint32Array([0]),weights:new Float32Array([1,0,0])},recipe).tone![0]).toBe(0);
  });
  it('reports only decisions within the shared quantum as ambiguous',()=>{
    const tone=new Float32Array([0.5,0.5+TONE_QUANTUM/2,0.5-TONE_QUANTUM*2,0.25]),thresholds=new Float32Array([0.5,0.5,0.5,0.9]);
    expect([...ambiguousTone3(tone,thresholds)]).toEqual([0,1]);
    expect(()=>ambiguousTone3(tone,new Float32Array(2))).toThrow('equal length');
  });
});
describe('GPU surface evaluation',()=>{
  it.skipIf(typeof navigator==='undefined'||!(navigator as {gpu?:unknown}).gpu)('agrees with the CPU reference within the tone quantum',async()=>{
    const {GpuSceneCompute3}=await import('../src/compute/webgpu/scene.js');
    const host=new GpuSceneCompute3((navigator as unknown as {gpu:GPU}).gpu),surface=torus(1.4,0.45).surface,batch=batchOf(surface.triangles.length,5000,lcg(5));
    const recipe=lightRecipe3({direction:[1,2,3]}),cpu=evaluateSurfaceCpu3({surface,placement},batch,recipe),gpu=await host.evaluateSurface({surface,placement},batch,recipe,{});
    for(let i=0;i<batch.triangle.length;i++)expect(Math.abs(gpu.tone![i]-cpu.tone![i])).toBeLessThan(TONE_QUANTUM);
    await host.dispose();
  });
});

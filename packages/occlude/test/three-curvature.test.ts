import {describe,expect,it} from 'vitest';
import {estimateCurvature3,curvatureAt3} from '../src/three/geometry/curvature.js';
import {sphere,cylinder,torus} from '../src/three/api/primitives.js';
import {plane,box} from '../src/three/api/mesh.js';
import {dot3,cross3,unit3,type Vec3} from '../src/three/math.js';
const angle=(a:Vec3,b:Vec3)=>Math.acos(Math.min(1,Math.abs(dot3(unit3(a),unit3(b)))))*180/Math.PI;
function samples(mesh:{surface:any},predicate:(p:Vec3)=>boolean){
  const est=estimateCurvature3(mesh.surface),out=[] as {p:Vec3;s:ReturnType<typeof curvatureAt3>}[];
  mesh.surface.triangles.forEach((t:any,i:number)=>{const p=t.vertices.map((v:number)=>mesh.surface.points[v].position) as Vec3[];const c:Vec3=[(p[0][0]+p[1][0]+p[2][0])/3,(p[0][1]+p[1][1]+p[2][1])/3,(p[0][2]+p[1][2]+p[2][2])/3];if(predicate(c))out.push({p:c,s:curvatureAt3(est,i,[1/3,1/3,1/3])});});
  return out;
}
describe('mesh curvature estimation',()=>{
  it('finds the cylinder tube curvature around the axis and none along it',()=>{
    const rows=samples(cylinder(2,4,{segments:48}),p=>Math.abs(p[2])<1.5&&Math.hypot(p[0],p[1])>1.5);
    expect(rows.length).toBeGreaterThan(40);
    for(const {p,s} of rows){
      expect(Math.abs(s.kMax-.5)/.5).toBeLessThan(.15);expect(Math.abs(s.kMin)).toBeLessThan(.05);
      expect(angle(s.min,[0,0,1])).toBeLessThan(5);expect(angle(s.max,[-p[1],p[0],0])).toBeLessThan(5);
      expect(s.confidence).toBeGreaterThan(.8);
    }
  });
  it('reports an umbilic sphere with low confidence and the analytic magnitude',()=>{
    const rows=samples(sphere(2,{segments:48,rings:24}),p=>Math.abs(p[2])<1.6);
    for(const {s} of rows){for(const k of [s.kMin,s.kMax])expect(Math.abs(Math.abs(k)-.5)/.5).toBeLessThan(.2);expect(s.confidence).toBeLessThan(.2);}
  });
  it('is flat on a plane and saddle-shaped on a hyperbolic paraboloid',()=>{
    for(const {s} of samples(plane(4).subdivide(3),()=>true)){expect(Math.abs(s.kMin)).toBeLessThan(1e-9);expect(Math.abs(s.kMax)).toBeLessThan(1e-9);expect(s.confidence).toBe(0);}
    const saddle=plane(4).subdivide(4).displace(p=>[0,0,.25*(p.x*p.x-p.y*p.y)]);
    const rows=samples(saddle,p=>Math.hypot(p[0],p[1])<1);
    expect(rows.length).toBeGreaterThan(4);for(const {s} of rows){expect(s.kMin).toBeLessThan(-.1);expect(s.kMax).toBeGreaterThan(.1);}
  });
  it('recovers the tube curvature on the outer torus rim',()=>{
    const rows=samples(torus(3,1,{segments:48,tubeSegments:24}),p=>Math.abs(Math.hypot(p[0],p[1])-4)<.15&&Math.abs(p[2])<.15);
    expect(rows.length).toBeGreaterThan(20);
    for(const {s} of rows){expect(Math.abs(s.kMax-1)).toBeLessThan(.25);expect(Math.abs(s.kMin-.25)).toBeLessThan(.1);}
  });
  it('interpolates sign-consistent directions inside a triangle',()=>{
    const model=cylinder(1,2,{segments:24}),est=estimateCurvature3(model.surface);
    const i=model.surface.triangles.findIndex(t=>t.vertices.every(v=>Math.hypot(...model.surface.points[v].position.slice(0,2))>.9));
    const set=[[1,0,0],[0,1,0],[0,0,1],[1/3,1/3,1/3]].map(w=>curvatureAt3(est,i,w as unknown as Vec3));
    for(const a of set)for(const b of set){expect(angle(a.max,b.max)).toBeLessThan(10);expect(angle(a.min,b.min)).toBeLessThan(10);}
    const t=model.surface.triangles[i],[a,b,c]=t.vertices.map(v=>model.surface.points[v].position),n=cross3([b[0]-a[0],b[1]-a[1],b[2]-a[2]],[c[0]-a[0],c[1]-a[1],c[2]-a[2]]);
    for(const s of set){expect(Math.abs(dot3(s.max,unit3(n)))).toBeLessThan(1e-9);expect(Math.abs(dot3(s.min,s.max))).toBeLessThan(1e-9);}
  });
  it('does not average across creases, so box faces stay flat',()=>{
    const est=estimateCurvature3(box(2).surface);
    for(const row of est.corners)for(const c of row){expect(Math.abs(c.kMax)).toBeLessThan(1e-9);expect(Math.abs(c.kMin)).toBeLessThan(1e-9);expect(Math.abs(Math.abs(c.normal[0])+Math.abs(c.normal[1])+Math.abs(c.normal[2])-1)).toBeLessThan(1e-9);}
    const smooth=estimateCurvature3(box(2).surface,{creaseDegrees:180});
    expect(smooth.corners.some(row=>row.some(c=>Math.abs(c.kMax)>.1))).toBe(true);
  });
  it('caches per surface and validates options',()=>{
    const s=sphere(1).surface;expect(estimateCurvature3(s)).toBe(estimateCurvature3(s));expect(estimateCurvature3(s,{smoothing:0})).not.toBe(estimateCurvature3(s));
    expect(()=>estimateCurvature3(s,{smoothing:-1})).toThrow('smoothing');expect(estimateCurvature3(s,{creaseDegrees:200})).toBe(estimateCurvature3(s,{creaseDegrees:180}));
    expect(()=>curvatureAt3(estimateCurvature3(s),9999,[1,0,0])).toThrow('triangle');
  });
});

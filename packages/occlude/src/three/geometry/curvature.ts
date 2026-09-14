import {snapshotSurface3} from './model.js';
import type {Surface3} from './surface.js';
import {triangulation3} from './triangulation.js';
import {add3,sub3,mul3,dot3,cross3,type Vec3} from '../math.js';

/**
 * Estimated principal curvature on the represented triangle mesh.
 *
 * Method. Each triangle contributes a curvature tensor fitted by least squares
 * from the change of the corner normals along its three edges (the per-face
 * construction of Rusinkiewicz, "Estimating Curvatures and Their Derivatives
 * on Triangle Meshes", 2004; idea only, no code). Corner normals are the
 * angle-weighted average of the triangle normals in the corner's smooth
 * sector. Tensors are rotated into each corner's tangent frame and summed with
 * the corner angle as weight, then optionally smoothed `smoothing` times by
 * angle-weighted averaging with the corners of neighbouring triangles across
 * non-crease edges. Principal values/directions are the eigenpairs of the
 * resulting 2x2 tensor; `kMax >= kMin` by value, positive where the surface
 * bends away from its outward normal (convex).
 *
 * Neighbourhood and creases. A vertex's incident triangles are partitioned
 * into sectors by edges whose dihedral angle exceeds `creaseDegrees` (default
 * 60). Nothing is averaged across a crease: a box edge stays sharp and each
 * face reports zero curvature. Boundary vertices use their one-sided ring.
 *
 * Confidence is `|kMax - kMin| / (|kMax| + |kMin| + eps)` in [0,1]: near zero
 * at umbilics (sphere) and on flat regions, where the principal direction is
 * not meaningful and a caller must fall back. Directions are unoriented lines;
 * `curvatureAt3` aligns signs before interpolating inside a triangle.
 *
 * Limits: a coarse polygonal mesh underestimates curvature by the chord
 * factor of its tessellation; two-row primitives (cylinder side quads) are
 * still handled because normals vary along the ring. This is an estimate, not
 * analytic smooth-surface geometry.
 */
export interface CurvatureOptions3 {readonly smoothing?:number;readonly creaseDegrees?:number}
export interface CornerCurvature3 {
  readonly normal:Vec3;readonly min:Vec3;readonly max:Vec3;
  readonly kMin:number;readonly kMax:number;readonly confidence:number;
}
export interface CurvatureEstimate3 {
  readonly source:Surface3;readonly options:Readonly<Required<CurvatureOptions3>>;
  /** Per triangle, per corner (triangle vertex order). */
  readonly corners:readonly (readonly [CornerCurvature3,CornerCurvature3,CornerCurvature3])[];
}
export interface CurvatureSample3 {readonly min:Vec3;readonly max:Vec3;readonly kMin:number;readonly kMax:number;readonly confidence:number}

const cache=new WeakMap<Surface3,Map<string,CurvatureEstimate3>>();
const norm=(v:Vec3)=>Math.hypot(v[0],v[1],v[2]);
const safeUnit=(v:Vec3):Vec3|null=>{const n=norm(v);return n>0&&Number.isFinite(n)?mul3(v,1/n):null;};
const freeze=<T>(v:T):T=>Object.freeze(v);

interface Frame {readonly n:Vec3;readonly u:Vec3;readonly v:Vec3}
function tangentFrame(n:Vec3):Frame {
  const helper:Vec3=Math.abs(n[0])<0.6?[1,0,0]:Math.abs(n[1])<0.6?[0,1,0]:[0,0,1];
  const u=safeUnit(cross3(helper,n))!;return {n,u,v:cross3(n,u)};
}
/** Express a tensor known in frame `from` in frame `to`, rotating `from.n`
 * onto `to.n` about their common perpendicular (the standard change of frame
 * for curvature tensors between neighbouring normals). */
function rotateTensor(t:readonly [number,number,number],from:Frame,to:Frame):[number,number,number] {
  const axis=cross3(from.n,to.n),s=norm(axis),c=dot3(from.n,to.n);
  const rotate=(x:Vec3):Vec3=>{
    if(s<1e-12)return c<0?mul3(x,-1):x;
    const k=mul3(axis,1/s),kx=cross3(k,x);
    return add3(add3(mul3(x,c),mul3(kx,s)),mul3(k,dot3(k,x)*(1-c)));
  };
  const u=rotate(from.u),v=rotate(from.v);
  const uu=dot3(u,to.u),uv=dot3(u,to.v),vu=dot3(v,to.u),vv=dot3(v,to.v);
  const [a,b,d]=t;
  // T' = R T R^T with R rows (uu,vu),(uv,vv) mapping old (u,v) components onto new axes.
  const a2=uu*(a*uu+b*vu)+vu*(b*uu+d*vu);
  const b2=uv*(a*uu+b*vu)+vv*(b*uu+d*vu);
  const d2=uv*(a*uv+b*vv)+vv*(b*uv+d*vv);
  return [a2,b2,d2];
}
function solve3(m:number[][],r:number[]):[number,number,number]|null {
  const a=m.map(row=>[...row]),b=[...r];
  for(let i=0;i<3;i++){
    let p=i;for(let j=i+1;j<3;j++)if(Math.abs(a[j][i])>Math.abs(a[p][i]))p=j;
    if(Math.abs(a[p][i])<1e-300)return null;[a[i],a[p]]=[a[p],a[i]];[b[i],b[p]]=[b[p],b[i]];
    for(let j=i+1;j<3;j++){const f=a[j][i]/a[i][i];for(let k=i;k<3;k++)a[j][k]-=f*a[i][k];b[j]-=f*b[i];}
  }
  const x=[0,0,0];for(let i=2;i>=0;i--){let s=b[i];for(let k=i+1;k<3;k++)s-=a[i][k]*x[k];x[i]=s/a[i][i];}
  return x.every(Number.isFinite)?[x[0],x[1],x[2]]:null;
}
function eigen(a:number,b:number,d:number):{k1:number;k2:number;e1:[number,number];e2:[number,number]} {
  const tr=a+d,det=a*d-b*b,disc=Math.sqrt(Math.max(0,tr*tr/4-det));
  const k1=tr/2+disc,k2=tr/2-disc;
  let e1:[number,number];
  if(Math.abs(b)>1e-300)e1=[k1-d,b];else e1=a>=d?[1,0]:[0,1];
  const l=Math.hypot(e1[0],e1[1]);e1=[e1[0]/l,e1[1]/l];
  return {k1,k2,e1,e2:[-e1[1],e1[0]]};
}

export function estimateCurvature3(input:Surface3,options:CurvatureOptions3={}):CurvatureEstimate3 {
  const source=snapshotSurface3(input),smoothing=options.smoothing??1,creaseDegrees=options.creaseDegrees??60;
  if(!Number.isSafeInteger(smoothing)||smoothing<0||smoothing>64)throw new Error('curvature smoothing must be an integer between 0 and 64');
  if(!Number.isFinite(creaseDegrees)||creaseDegrees<0||creaseDegrees>180)throw new Error('curvature creaseDegrees must lie in [0,180]');
  const key=JSON.stringify([smoothing,creaseDegrees]);
  let entries=cache.get(source);const previous=entries?.get(key);if(previous)return previous;
  const topology=triangulation3(source),triangles=source.triangles,points=source.points;
  const tn:( Vec3|null)[]=[],area:number[]=[],angles:number[][]=[];
  let extent=0;const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(const p of points)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],p.position[k]);hi[k]=Math.max(hi[k],p.position[k]);}
  if(points.length)extent=Math.hypot(hi[0]-lo[0],hi[1]-lo[1],hi[2]-lo[2]);
  const eps=1e-9/(extent||1);
  for(const t of triangles){
    const [a,b,c]=t.vertices.map(v=>points[v].position),n=cross3(sub3(b,a),sub3(c,a));
    tn.push(safeUnit(n));area.push(norm(n)/2);
    const ang=(p:Vec3,q:Vec3,r:Vec3)=>{const x=safeUnit(sub3(q,p)),y=safeUnit(sub3(r,p));return x&&y?Math.acos(Math.max(-1,Math.min(1,dot3(x,y)))):0;};
    angles.push([ang(a,b,c),ang(b,c,a),ang(c,a,b)]);
  }
  const cosCrease=Math.cos(creaseDegrees*Math.PI/180);
  const creased=(i:number,edge:number):boolean=>{const j=topology.neighbors[i][edge];if(j<0)return true;const x=tn[i],y=tn[j];return !x||!y||dot3(x,y)<cosCrease-1e-12;};
  // Sector id per triangle corner: connected across non-crease edges at that vertex.
  const sector=triangles.map(()=>[-1,-1,-1] as [number,number,number]);let sectors=0;
  const members:number[][]=[];// sector -> list of corner keys (triangle*3+corner)
  for(let i=0;i<triangles.length;i++)for(let c=0;c<3;c++){
    if(sector[i][c]>=0)continue;const id=sectors++,list:number[]=[];members.push(list);
    const stack=[[i,c] as [number,number]];sector[i][c]=id;
    while(stack.length){
      const [ti,tc]=stack.pop()!;list.push(ti*3+tc);const vertex=triangles[ti].vertices[tc];
      for(const edge of [tc,(tc+2)%3]){// edges incident to this corner: (tc,tc+1) and (tc+2,tc)
        if(creased(ti,edge))continue;const tj=topology.neighbors[ti][edge],cj=triangles[tj].vertices.indexOf(vertex);
        if(cj>=0&&sector[tj][cj]<0){sector[tj][cj]=id;stack.push([tj,cj]);}
      }
    }
  }
  const sectorNormal:Vec3[]=members.map(list=>{
    let sum:Vec3=[0,0,0];for(const k of list){const n=tn[k/3|0];if(n)sum=add3(sum,mul3(n,angles[k/3|0][k%3]));}
    return safeUnit(sum)??[0,0,1];
  });
  const frames=sectorNormal.map(tangentFrame);
  // Per-corner tensor accumulation in each sector's frame.
  const tensor:[number,number,number][]=members.map(()=>[0,0,0]),weight=members.map(()=>0);
  for(let i=0;i<triangles.length;i++){
    const n=tn[i];if(!n||!(area[i]>0))continue;
    const p=triangles[i].vertices.map(v=>points[v].position),nv=[0,1,2].map(c=>sectorNormal[sector[i][c]]);
    const e=[sub3(p[2],p[1]),sub3(p[0],p[2]),sub3(p[1],p[0])],dn=[sub3(nv[2],nv[1]),sub3(nv[0],nv[2]),sub3(nv[1],nv[0])];
    const u=safeUnit(e[0]);if(!u)continue;const frame:Frame={n,u,v:cross3(n,u)};
    const m=[[0,0,0],[0,0,0],[0,0,0]],r=[0,0,0];
    for(let k=0;k<3;k++){
      const eu=dot3(e[k],frame.u),ev=dot3(e[k],frame.v),du=dot3(dn[k],frame.u),dv=dot3(dn[k],frame.v);
      const rows:[number[],number][]=[[[eu,ev,0],du],[[0,eu,ev],dv]];
      for(const [row,val] of rows)for(let x=0;x<3;x++){r[x]+=row[x]*val;for(let y=0;y<3;y++)m[x][y]+=row[x]*row[y];}
    }
    const fitted=solve3(m,r);if(!fitted)continue;
    for(let c=0;c<3;c++){const s=sector[i][c],w=angles[i][c];const local=rotateTensor(fitted,frame,frames[s]);for(let x=0;x<3;x++)tensor[s][x]+=w*local[x];weight[s]+=w;}
  }
  let current=tensor.map((t,s)=>weight[s]>0?[t[0]/weight[s],t[1]/weight[s],t[2]/weight[s]] as [number,number,number]:[0,0,0] as [number,number,number]);
  // Smoothing: angle-weighted average with corners of the same triangles at the
  // other vertices, which lie inside the sector's smooth neighbourhood.
  for(let pass=0;pass<smoothing;pass++){
    const next=members.map(()=>[0,0,0] as [number,number,number]),w=members.map(()=>0);
    for(let s=0;s<members.length;s++){
      next[s]=add(next[s],current[s],1);w[s]+=1;
      for(const k of members[s]){
        const ti=k/3|0,tc=k%3;
        for(const oc of [(tc+1)%3,(tc+2)%3]){
          const os=sector[ti][oc],wt=angles[ti][oc];if(!(wt>0))continue;
          next[s]=add(next[s],rotateTensor(current[os],frames[os],frames[s]),wt);w[s]+=wt;
        }
      }
    }
    current=next.map((t,s)=>w[s]>0?[t[0]/w[s],t[1]/w[s],t[2]/w[s]] as [number,number,number]:t);
  }
  function add(a:[number,number,number],b:readonly [number,number,number],w:number):[number,number,number]{return [a[0]+b[0]*w,a[1]+b[1]*w,a[2]+b[2]*w];}
  const perSector:CornerCurvature3[]=current.map((t,s)=>{
    const {k1,k2,e1,e2}=eigen(t[0],t[1],t[2]),f=frames[s];
    const max=freeze(add3(mul3(f.u,e1[0]),mul3(f.v,e1[1]))),min=freeze(add3(mul3(f.u,e2[0]),mul3(f.v,e2[1])));
    const confidence=Math.min(1,Math.abs(k1-k2)/(Math.abs(k1)+Math.abs(k2)+eps));
    return freeze({normal:freeze(f.n),min,max,kMin:k2,kMax:k1,confidence});
  });
  const corners=freeze(sector.map(row=>freeze(row.map(s=>perSector[s]) as unknown as [CornerCurvature3,CornerCurvature3,CornerCurvature3])));
  const estimate=freeze({source,options:freeze({smoothing,creaseDegrees}),corners});
  if(!entries){entries=new Map();cache.set(source,entries);}
  if(entries.size>=4)entries.delete(entries.keys().next().value!);
  entries.set(key,estimate);return estimate;
}

/** Interpolate inside one represented triangle. Principal directions are lines:
 * each corner's `max` is flipped to agree with the first corner before the
 * barycentric average, projected onto the triangle plane and re-orthogonalised.
 * A degenerate triangle (zero normal) or a vanishing averaged direction falls
 * back to corner 0's frame with confidence 0. */
export function curvatureAt3(estimate:CurvatureEstimate3,triangle:number,barycentric:Vec3):CurvatureSample3 {
  const rows=estimate.corners[triangle];if(!rows)throw new Error('curvature sample requires a valid source triangle');
  if(barycentric.length!==3||barycentric.some(w=>!Number.isFinite(w)||w<0))throw new Error('curvature sample requires nonnegative barycentric weights');
  const t=estimate.source.triangles[triangle],[a,b,c]=t.vertices.map(v=>estimate.source.points[v].position);
  const n=safeUnit(cross3(sub3(b,a),sub3(c,a)));
  const total=barycentric[0]+barycentric[1]+barycentric[2]||1,w=barycentric.map(x=>x/total);
  let max:Vec3=[0,0,0],min:Vec3=[0,0,0],kMax=0,kMin=0,confidence=0;
  for(let i=0;i<3;i++){
    const r=rows[i],sMax=dot3(r.max,rows[0].max)<0?-1:1,sMin=dot3(r.min,rows[0].min)<0?-1:1;
    max=add3(max,mul3(r.max,sMax*w[i]));min=add3(min,mul3(r.min,sMin*w[i]));
    kMax+=r.kMax*w[i];kMin+=r.kMin*w[i];confidence+=r.confidence*w[i];
  }
  if(!n){return freeze({min:rows[0].min,max:rows[0].max,kMin,kMax,confidence:0});}
  const projected=safeUnit(sub3(max,mul3(n,dot3(n,max))));
  if(!projected){const f=tangentFrame(n);return freeze({min:freeze(f.v),max:freeze(f.u),kMin,kMax,confidence:0});}
  let perpendicular=cross3(n,projected);if(dot3(perpendicular,min)<0)perpendicular=mul3(perpendicular,-1);
  return freeze({min:freeze(perpendicular),max:freeze(projected),kMin,kMax,confidence:Math.min(1,Math.max(0,confidence))});
}

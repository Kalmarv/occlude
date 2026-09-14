import {dyadic,sum,product,homogeneous,abs,reduce,point,dot,dot3,cross,difference,at,plane,times,subtract,constant,sign,ratioNumber as toNumber,decodePoint,weightedPoint,integerWeights,type H,type Ratio} from '../geometry/exact.js';
import type {Triangle3,Vec3} from '../math.js';
import type {AffinePoint3,SegmentBasis3,Interval3} from './interval.js';

/** Original world triangle and the explicit camera clipping slab. GPU shadow
 * triangles may be clipped/rounded; exact refinement retains their source. */
export interface WorldOcclusion3 {
  readonly triangle:Triangle3;
  readonly view:{readonly perspective:boolean;readonly eye:Vec3;readonly target:Vec3;readonly back:Vec3;readonly near:number;readonly far:number};
}
const pointCache=new WeakMap<AffinePoint3,H>();
function sourcePoint(terms:AffinePoint3):H {
  let p=pointCache.get(terms);if(p)return p;
  if(terms.some(t=>t.exactWorld)){
    p=weightedPoint(terms.map(t=>t.exactWorld?decodePoint(t.exactWorld):point(t.world!)),integerWeights(terms.map(t=>t.weight)));
    pointCache.set(terms,p);return p;
  }
  const weights=terms.map(t=>dyadic(t.weight));
  // Homogeneous W normalizes the captured barycentric weights exactly. Their
  // floating sum need not be exactly one; an affine point stays on its plane.
  p=homogeneous([0,1,2].map(k=>sum(terms.map((t,i)=>product(dyadic(t.world![k]),weights[i])))).concat([sum(weights)]));
  if(p[3]<=0n)throw new Error('world visibility requires positive affine weight sum');
  pointCache.set(terms,p);return p;
}
const planeCache=new WeakMap<WorldOcclusion3,readonly H[]|null>();

/** Intersect the original shadow with near/far at its surface hit. This is
 * the clipped polygon's shadow, independent of the triangulation used for
 * GPU packing/indexing. Every returned inequality is affine in source t. */
function planes(volume:WorldOcclusion3):readonly H[]|null {
  if(planeCache.has(volume))return planeCache.get(volume)!;
  const [a,b,c]=volume.triangle.map(point),vertices=[a,b,c],eye=point(volume.view.eye),target=point(volume.view.target),back=point(volume.view.back);
  const direction=difference(eye,target),surface=plane(a,b,c);
  const side=volume.view.perspective?dot(surface,eye):dot3(surface,direction);
  if(side===0n){planeCache.set(volume,null);return null;}
  const depth=times(surface,-sign(side)); // strictly behind the source surface
  const result:H[]=[];
  for(let i=0;i<3;i++){
    const u=vertices[i],v=vertices[(i+1)%3],other=vertices[(i+2)%3];
    const p=volume.view.perspective?plane(eye,u,v):at(cross(difference(v,u),direction),u);
    const interior=sign(dot(p,other));if(interior===0n){planeCache.set(volume,null);return null;}
    result.push(times(p,interior));
  }
  result.push(depth);
  // L(p) = camera depth = -back·(p-eye) = linear(p)/scale.
  const linear:H=[-back[0]*eye[3],-back[1]*eye[3],-back[2]*eye[3],dot3(back,eye)];
  const scale=back[3]*eye[3];
  const [near,far]=[volume.view.near,volume.view.far].map(v=>point([v,0,0]));
  if(volume.view.perspective){
    const e=abs(dot(surface,eye)); // positive eye-side depth numerator / eye.W
    const denominator=times(depth,eye[3]).map((v,i)=>v+(i===3?e:0n)) as unknown as H;
    // hitDepth = E*L(p)/(E+depth(p)); E is positive.
    result.push(reduce(subtract(times(linear,e*near[3]),times(denominator,near[0]*scale))));
    result.push(reduce(subtract(times(denominator,far[0]*scale),times(linear,e*far[3]))));
  }else{
    const d=abs(dot3(surface,direction)),r=dot3(direction,back);
    // hitDepth = L(p) - depth(p)*(direction·back)/abs(N·direction).
    const hit=subtract(times(linear,back[3]*d),times(depth,r*scale)),denominator=scale*back[3]*d;
    result.push(reduce(subtract(times(hit,near[3]),constant(near[0]*denominator))));
    result.push(reduce(subtract(constant(far[0]*denominator),times(hit,far[3]))));
  }
  planeCache.set(volume,result);return result;
}
const compare=(a:Ratio,b:Ratio)=>a[0]*b[1]-b[0]*a[1];
export function hiddenWorldInterval3(volume:WorldOcclusion3,basis:SegmentBasis3):Interval3|null {
  const constraints=planes(volume);if(!constraints)return null;
  const a=sourcePoint(basis[0]),b=sourcePoint(basis[1]);
  let lo:Ratio=[0n,1n],hi:Ratio=[1n,1n];
  for(let i=0;i<constraints.length;i++){
    // Cross-multiply positive homogeneous denominators, so endpoints have
    // the same scale. Exact root ordering prevents invented tiny cuts/gaps.
    const va=dot(constraints[i],a)*b[3],vb=dot(constraints[i],b)*a[3];
    if(i===3&&va<=0n&&vb<=0n)return null;
    if(va<0n&&vb<0n)return null;
    if(va<0n){const root:Ratio=[-va,vb-va];if(compare(root,lo)>0n)lo=root;}
    if(vb<0n){const root:Ratio=[va,va-vb];if(compare(root,hi)<0n)hi=root;}
    if(compare(lo,hi)>=0n)return null;
  }
  return [toNumber(lo),toNumber(hi)];
}

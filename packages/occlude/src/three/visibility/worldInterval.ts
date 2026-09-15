import {dyadic,sum,product,homogeneous,abs,point,dot,dot3,cross,difference,atScale,planeScale,reduceScale,times,subtract,constant,sign,ratioNumber as toNumber,decodePoint,weightedPoint,integerWeights,filtered4,filteredDotSign,type Filtered4,type H,type V,type Ratio} from '../geometry/exact.js';
import type {Triangle3,Vec3} from '../math.js';
import type {AffinePoint3,SegmentBasis3,Interval3} from './interval.js';

/** Original world triangle and the explicit camera clipping slab. GPU shadow
 * triangles may be clipped/rounded; exact refinement retains their source. */
export interface WorldOcclusion3 {
  readonly triangle:Triangle3;
  readonly view:{readonly perspective:boolean;readonly eye:Vec3;readonly target:Vec3;readonly back:Vec3;readonly near:number;readonly far:number};
}
/** The exact point and its f64 filter image, built together and kept together:
 * both are functions of the same terms and both are reused by every candidate
 * pair that names this endpoint. */
interface SourcePoint3 { readonly p:H; readonly f:Filtered4 }
const pointCache=new WeakMap<AffinePoint3,SourcePoint3>();
function sourcePoint(terms:AffinePoint3):SourcePoint3 {
  const cached=pointCache.get(terms);if(cached)return cached;
  let p:H;
  if(terms.some(t=>t.exactWorld)){
    p=weightedPoint(terms.map(t=>t.exactWorld?decodePoint(t.exactWorld):point(t.world!)),integerWeights(terms.map(t=>t.weight)));
  }else{
    const weights=terms.map(t=>dyadic(t.weight));
    // Homogeneous W normalizes the captured barycentric weights exactly. Their
    // floating sum need not be exactly one; an affine point stays on its plane.
    p=homogeneous([0,1,2].map(k=>sum(terms.map((t,i)=>product(dyadic(t.world![k]),weights[i])))).concat([sum(weights)]));
    if(p[3]<=0n)throw new Error('world visibility requires positive affine weight sum');
  }
  const record={p,f:filtered4(p)};
  pointCache.set(terms,record);return record;
}
interface Shadow3 { readonly constraints:readonly H[]; readonly filtered:readonly Filtered4[] }
const planeCache=new WeakMap<WorldOcclusion3,Shadow3|null>();
/** Everything in the shadow construction that depends on the view and not on
 * the triangle. One snapshot shares one view object across all of its
 * occluders, so this is built once per camera rather than once per triangle. */
interface ExactView3 { readonly eye:H; readonly back:H; readonly direction:V; readonly linear:H; readonly scale:bigint; readonly near:H; readonly far:H }
const viewCache=new WeakMap<WorldOcclusion3['view'],ExactView3>();
/** A mesh vertex belongs to about six triangles and every one of them wants
 * the same exact point; the snapshot hands out the same world position array
 * each time, so identity is enough to build it once. */
const vertexCache=new WeakMap<Vec3,H>();
function exactVertex(v:Vec3):H {
  let p=vertexCache.get(v);if(p)return p;
  p=point(v);vertexCache.set(v,p);return p;
}
function exactView(view:WorldOcclusion3['view']):ExactView3 {
  const cached=viewCache.get(view);if(cached)return cached;
  const eye=point(view.eye),target=point(view.target),back=point(view.back);
  // L(p) = camera depth = -back·(p-eye) = linear(p)/scale.
  const record:ExactView3={eye,back,direction:difference(eye,target),
    linear:[-back[0]*eye[3],-back[1]*eye[3],-back[2]*eye[3],dot3(back,eye)],
    scale:back[3]*eye[3],near:point([view.near,0,0]),far:point([view.far,0,0])};
  viewCache.set(view,record);return record;
}

/** Intersect the original shadow with near/far at its surface hit. This is
 * the clipped polygon's shadow, independent of the triangulation used for
 * GPU packing/indexing. Every returned inequality is affine in source t. */
function planes(volume:WorldOcclusion3):Shadow3|null {
  if(planeCache.has(volume))return planeCache.get(volume)!;
  const [a,b,c]=volume.triangle.map(exactVertex),vertices=[a,b,c];
  const {eye,back,direction,linear,scale,near,far}=exactView(volume.view);
  const surface=planeScale(a,b,c);
  const side=volume.view.perspective?dot(surface,eye):dot3(surface,direction);
  if(side===0n){planeCache.set(volume,null);return null;}
  const depth=times(surface,-sign(side)); // strictly behind the source surface
  const result:H[]=[];
  for(let i=0;i<3;i++){
    const u=vertices[i],v=vertices[(i+1)%3],other=vertices[(i+2)%3];
    const p=volume.view.perspective?planeScale(eye,u,v):atScale(cross(difference(v,u),direction),u);
    const interior=sign(dot(p,other));if(interior===0n){planeCache.set(volume,null);return null;}
    result.push(times(p,interior));
  }
  result.push(depth);
  if(volume.view.perspective){
    const e=abs(dot(surface,eye)); // positive eye-side depth numerator / eye.W
    const denominator=times(depth,eye[3]).map((v,i)=>v+(i===3?e:0n)) as unknown as H;
    // hitDepth = E*L(p)/(E+depth(p)); E is positive.
    result.push(reduceScale(subtract(times(linear,e*near[3]),times(denominator,near[0]*scale))));
    result.push(reduceScale(subtract(times(denominator,far[0]*scale),times(linear,e*far[3]))));
  }else{
    const d=abs(dot3(surface,direction)),r=dot3(direction,back);
    // hitDepth = L(p) - depth(p)*(direction·back)/abs(N·direction).
    const hit=subtract(times(linear,back[3]*d),times(depth,r*scale)),denominator=scale*back[3]*d;
    result.push(reduceScale(subtract(times(hit,near[3]),constant(near[0]*denominator))));
    result.push(reduceScale(subtract(constant(far[0]*denominator),times(hit,far[3]))));
  }
  const shadow={constraints:result,filtered:result.map(filtered4)};
  planeCache.set(volume,shadow);return shadow;
}
const compare=(a:Ratio,b:Ratio)=>a[0]*b[1]-b[0]*a[1];
export function hiddenWorldInterval3(volume:WorldOcclusion3,basis:SegmentBasis3):Interval3|null {
  const shadow=planes(volume);if(!shadow)return null;
  const {constraints,filtered}=shadow;
  const a=sourcePoint(basis[0]),b=sourcePoint(basis[1]),a3=a.p[3],b3=b.p[3];
  let lo:Ratio=[0n,1n],hi:Ratio=[1n,1n];
  for(let i=0;i<constraints.length;i++){
    // Both endpoints outside this halfspace is a rejection, and both strictly
    // inside moves neither bound, so a certified f64 sign settles the pair
    // without the exact value. Only a crossing needs the root, and the filter
    // abstains (0) whenever f64 cannot prove the sign, including at zero.
    const sa=filteredDotSign(filtered[i],a.f),sb=filteredDotSign(filtered[i],b.f);
    if(sa<0&&sb<0)return null;
    if(sa>0&&sb>0)continue;
    // Cross-multiply positive homogeneous denominators, so endpoints have
    // the same scale. Exact root ordering prevents invented tiny cuts/gaps.
    const va=dot(constraints[i],a.p)*b3,vb=dot(constraints[i],b.p)*a3;
    if(i===3&&va<=0n&&vb<=0n)return null;
    if(va<0n&&vb<0n)return null;
    if(va<0n){const root:Ratio=[-va,vb-va];if(compare(root,lo)>0n)lo=root;}
    if(vb<0n){const root:Ratio=[va,va-vb];if(compare(root,hi)<0n)hi=root;}
    if(compare(lo,hi)>=0n)return null;
  }
  return [toNumber(lo),toNumber(hi)];
}

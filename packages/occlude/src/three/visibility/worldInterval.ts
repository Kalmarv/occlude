import type {Triangle3,Vec3} from '../math.js';
import type {AffinePoint3,SegmentBasis3,Interval3} from './interval.js';

/** Original world triangle and the explicit camera clipping slab. GPU shadow
 * triangles may be clipped/rounded; exact refinement retains their source. */
export interface WorldOcclusion3 {
  readonly triangle:Triangle3;
  readonly view:{readonly perspective:boolean;readonly eye:Vec3;readonly target:Vec3;readonly back:Vec3;readonly near:number;readonly far:number};
}
type H=readonly [bigint,bigint,bigint,bigint];
type V=readonly [bigint,bigint,bigint];
type Ratio=readonly [bigint,bigint];
type Dyadic=readonly [bigint,number];
const bits=new DataView(new ArrayBuffer(8));
/** Exact binary input, including subnormals; no decimal rounding or epsilon. */
function dyadic(value:number):Dyadic {
  if(!Number.isFinite(value))throw new Error('world visibility requires finite coordinates');
  if(value===0)return [0n,0];
  bits.setFloat64(0,value);const word=bits.getBigUint64(0),exponent=Number((word>>52n)&2047n),sign=(word>>63n)?-1n:1n;
  return [sign*((word&((1n<<52n)-1n))+(exponent?1n<<52n:0n)),exponent?exponent-1075:-1074];
}
function sum(values:readonly Dyadic[]):Dyadic {
  const nonzero=values.filter(([n])=>n!==0n);if(!nonzero.length)return [0n,0];
  const exponent=Math.min(...nonzero.map(([,e])=>e));
  return [nonzero.reduce((n,[v,e])=>n+(v<<BigInt(e-exponent)),0n),exponent];
}
const product=(a:Dyadic,b:Dyadic):Dyadic=>[a[0]*b[0],a[1]+b[1]];
function homogeneous(values:readonly Dyadic[]):H {
  const exponent=Math.min(...values.filter(([n])=>n!==0n).map(([,e])=>e));
  return reduce(values.map(([n,e])=>n===0n?0n:n<<BigInt(e-exponent)) as unknown as H);
}
const abs=(n:bigint)=>n<0n?-n:n;
function gcd(a:bigint,b:bigint):bigint{a=abs(a);b=abs(b);while(b){const next=a%b;a=b;b=next;}return a;}
/** Remove common factors once, keeping subsequent dot products compact. */
function reduce(p:H):H {const divisor=p.reduce(gcd,0n);return divisor>1n?p.map(n=>n/divisor) as unknown as H:p;}
const point=(v:Vec3):H=>homogeneous([...v.map(dyadic),[1n,0]]);
const pointCache=new WeakMap<AffinePoint3,H>();
function sourcePoint(terms:AffinePoint3):H {
  let p=pointCache.get(terms);if(p)return p;
  const weights=terms.map(t=>dyadic(t.weight));
  // Homogeneous W normalizes the captured barycentric weights exactly. Their
  // floating sum need not be exactly one; an affine point stays on its plane.
  p=homogeneous([0,1,2].map(k=>sum(terms.map((t,i)=>product(dyadic(t.world![k]),weights[i])))).concat([sum(weights)]));
  if(p[3]<=0n)throw new Error('world visibility requires positive affine weight sum');
  pointCache.set(terms,p);return p;
}
const dot=(a:H,b:H)=>a.reduce((s,n,i)=>s+n*b[i],0n);
const dot3=(a:readonly bigint[],b:readonly bigint[])=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:V,b:V):V=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const difference=(a:H,b:H):V=>[a[0]*b[3]-b[0]*a[3],a[1]*b[3]-b[1]*a[3],a[2]*b[3]-b[2]*a[3]];
const at=(normal:V,p:H):H=>reduce([normal[0]*p[3],normal[1]*p[3],normal[2]*p[3],-dot3(normal,p)]);
const plane=(a:H,b:H,c:H):H=>at(cross(difference(b,a),difference(c,a)),a);
const times=(p:H,n:bigint):H=>p.map(v=>v*n) as unknown as H;
const subtract=(a:H,b:H):H=>a.map((v,i)=>v-b[i]) as unknown as H;
const constant=(n:bigint):H=>[0n,0n,0n,n];
const sign=(n:bigint)=>n<0n?-1n:n>0n?1n:0n;
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
/** Correctly rounded nonnegative ratio <=1, including subnormal endpoints. */
function toNumber([n,d]:Ratio):number {
  if(n===0n)return 0;
  let exponent=n.toString(2).length-d.toString(2).length;
  if(exponent>=0?n<(d<<BigInt(exponent)):(n<<BigInt(-exponent))<d)exponent--;
  const shift=Math.min(1074,52-exponent),scaled=n<<BigInt(shift);
  let q=scaled/d;const remainder=scaled%d;
  if(2n*remainder>d||(2n*remainder===d&&(q&1n)!==0n))q++;
  return Number(q)*2**(-shift);
}
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

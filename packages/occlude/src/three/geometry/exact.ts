import type {Vec3} from '../math.js';

export type H=readonly [bigint,bigint,bigint,bigint];
export type V=readonly [bigint,bigint,bigint];
export type Ratio=readonly [bigint,bigint];
export type Dyadic=readonly [bigint,number];
const bits=new DataView(new ArrayBuffer(8));
/** Exact binary input, including subnormals; no decimal rounding or epsilon. */
export function dyadic(value:number):Dyadic {
  if(!Number.isFinite(value))throw new Error('world visibility requires finite coordinates');
  if(value===0)return [0n,0];
  bits.setFloat64(0,value);const word=bits.getBigUint64(0),exponent=Number((word>>52n)&2047n),sign=(word>>63n)?-1n:1n;
  return [sign*((word&((1n<<52n)-1n))+(exponent?1n<<52n:0n)),exponent?exponent-1075:-1074];
}
export function sum(values:readonly Dyadic[]):Dyadic {
  const nonzero=values.filter(([n])=>n!==0n);if(!nonzero.length)return [0n,0];
  const exponent=Math.min(...nonzero.map(([,e])=>e));
  return [nonzero.reduce((n,[v,e])=>n+(v<<BigInt(e-exponent)),0n),exponent];
}
export const product=(a:Dyadic,b:Dyadic):Dyadic=>[a[0]*b[0],a[1]+b[1]];
export function homogeneous(values:readonly Dyadic[]):H {
  const exponent=Math.min(...values.filter(([n])=>n!==0n).map(([,e])=>e));
  return reduce(values.map(([n,e])=>n===0n?0n:n<<BigInt(e-exponent)) as unknown as H);
}
export const abs=(n:bigint)=>n<0n?-n:n;
export function gcd(a:bigint,b:bigint):bigint{a=abs(a);b=abs(b);while(b){const next=a%b;a=b;b=next;}return a;}
/** Remove common factors once, keeping subsequent dot products compact. */
export function reduce(p:H):H {const divisor=p.reduce(gcd,0n);return divisor>1n?p.map(n=>n/divisor) as unknown as H:p;}
export const point=(v:Vec3):H=>homogeneous([...v.map(dyadic),[1n,0]]);
export const dot=(a:H,b:H)=>a.reduce((s,n,i)=>s+n*b[i],0n);
export const dot3=(a:readonly bigint[],b:readonly bigint[])=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const cross=(a:V,b:V):V=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const difference=(a:H,b:H):V=>[a[0]*b[3]-b[0]*a[3],a[1]*b[3]-b[1]*a[3],a[2]*b[3]-b[2]*a[3]];
export const at=(normal:V,p:H):H=>reduce([normal[0]*p[3],normal[1]*p[3],normal[2]*p[3],-dot3(normal,p)]);
export const plane=(a:H,b:H,c:H):H=>at(cross(difference(b,a),difference(c,a)),a);
export const times=(p:H,n:bigint):H=>p.map(v=>v*n) as unknown as H;
export const subtract=(a:H,b:H):H=>a.map((v,i)=>v-b[i]) as unknown as H;
export const constant=(n:bigint):H=>[0n,0n,0n,n];
export const sign=(n:bigint)=>n<0n?-1n:n>0n?1n:0n;

/** Canonical finite projective point. Plane orientations use reduce instead. */
export function canonicalPoint(p:H):H {
  if(p[3]===0n)throw new Error('exact surface point is at infinity');
  const q=reduce(p);return Object.freeze(q[3]<0n?times(q,-1n):q);
}
/** Round an arbitrary signed rational to nearest binary64, ties to even. */
export function ratioNumber([numerator,denominator]:Ratio):number {
  if(denominator===0n)throw new Error('exact ratio has a zero denominator');
  const polarity=Number(sign(numerator)*sign(denominator)),n=abs(numerator),d=abs(denominator);
  if(n===0n)return 0;
  let exponent=n.toString(2).length-d.toString(2).length;
  if(exponent>=0?n<(d<<BigInt(exponent)):(n<<BigInt(-exponent))<d)exponent--;
  if(exponent>1023)return polarity*Infinity;
  const shift=Math.min(1074,52-exponent),scaled=shift>=0?n<<BigInt(shift):n,divisor=shift>=0?d:d<<BigInt(-shift);
  let q=scaled/divisor;const remainder=scaled%divisor;
  if(2n*remainder>divisor||(2n*remainder===divisor&&(q&1n)!==0n))q++;
  return polarity*Number(q)*2**(-shift);
}
export function pointNumber(p:H):Vec3 {
  if(p[3]===0n)throw new Error('exact surface point is at infinity');
  const value=[ratioNumber([p[0],p[3]]),ratioNumber([p[1],p[3]]),ratioNumber([p[2],p[3]])] as const;
  if(!value.every(Number.isFinite))throw new Error('exact surface point exceeds finite coordinates');
  return Object.freeze(value);
}
export type EncodedPoint3=readonly [string,string,string,string];
/** Decimal integer strings survive JSON and structured clone without BigInt. */
export function encodePoint(p:H):EncodedPoint3{return Object.freeze(canonicalPoint(p).map(n=>n.toString())) as unknown as EncodedPoint3;}
export function decodePoint(value:EncodedPoint3):H {
  if(!Array.isArray(value)||value.length!==4||value.some(v=>typeof v!=='string'||v.length>10000||! /^-?(0|[1-9][0-9]*)$/.test(v)))throw new Error('invalid or over-budget exact point encoding');
  return canonicalPoint(value.map(v=>BigInt(v)) as unknown as H);
}
/** Convert dyadic coefficients to a common integer scale, without rounding. */
export function integerWeights(values:readonly number[]):readonly bigint[] {
  const rows=values.map(dyadic),exponent=Math.min(0,...rows.filter(([n])=>n!==0n).map(([,e])=>e));
  return rows.map(([n,e])=>n===0n?0n:n<<BigInt(e-exponent));
}
export function weightedPoint(points:readonly H[],weights:readonly bigint[]):H {
  if(!points.length||points.length!==weights.length||points.some(p=>p[3]<=0n))throw new Error('invalid exact affine point');
  const total=weights.reduce((a,b)=>a+b,0n);if(total<=0n)throw new Error('exact affine weights require a positive sum');
  const common=points.reduce((n,p)=>n*p[3],1n);
  return canonicalPoint([0,1,2].map(k=>points.reduce((n,p,i)=>n+p[k]*weights[i]*(common/p[3]),0n)).concat([common*total]) as unknown as H);
}
export function mixPoint(a:H,b:H,t:Ratio):H {
  const [n,d]=t;if(d<=0n)throw new Error('exact interpolation requires a positive denominator');
  return weightedPoint([a,b],[d-n,n]);
}
/** Determinant of homogeneous planar coordinates after dropping one axis. */
export function orientPoint(a:H,b:H,c:H,drop:number):bigint {
  const axes=[0,1,2].filter(k=>k!==drop),[x,y]=axes;
  return a[x]*(b[y]*c[3]-b[3]*c[y])-a[y]*(b[x]*c[3]-b[3]*c[x])+a[3]*(b[x]*c[y]-b[y]*c[x]);
}
/** Exact nonnegative affine numerators, or null when the point is off this
 * represented triangle. There is no coordinate tolerance or label exemption. */
export function triangleWeights(triangle:readonly [H,H,H],p:H):V|null {
  const [a,b,c]=triangle,n=plane(a,b,c);
  if(n.slice(0,3).every(v=>v===0n))throw new Error('exact triangle is degenerate');
  if(dot(n,p)!==0n)return null;
  let drop=0;for(let k=1;k<3;k++)if(abs(n[k])>abs(n[drop]))drop=k;
  const determinant=orientPoint(a,b,c,drop),polarity=sign(determinant);
  const weights=[orientPoint(p,b,c,drop)*a[3]*polarity,orientPoint(a,p,c,drop)*b[3]*polarity,orientPoint(a,b,p,drop)*c[3]*polarity] as const;
  if(weights.some(w=>w<0n))return null;
  const divisor=weights.reduce(gcd,0n);if(divisor===0n)throw new Error('exact triangle has no affine coordinates');
  return Object.freeze(weights.map(n=>n/divisor)) as unknown as V;
}

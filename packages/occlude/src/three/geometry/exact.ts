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
/** Remove common factors once, keeping subsequent dot products compact. A
 * running divisor of one cannot shrink further, so the remaining gcds are the
 * same answer computed the slow way. */
export function reduce(p:H):H {
  // Coordinates built from binary64 inputs mostly share a power of two:
  // shift it out first (cheap), then run Euclid on the smaller odd parts.
  const bits=abs(p[0])|abs(p[1])|abs(p[2])|abs(p[3]);
  if(bits===0n)return p;
  const shift=BigInt(trailingZeros(bits));
  const q:H=shift?[p[0]>>shift,p[1]>>shift,p[2]>>shift,p[3]>>shift]:p;
  let divisor=abs(q[0]);
  for(let i=1;i<4&&divisor!==1n;i++)divisor=gcd(divisor,q[i]);
  return divisor>1n?[q[0]/divisor,q[1]/divisor,q[2]/divisor,q[3]/divisor]:q;
}
/** Exact bit length of |n|. Base 16 is a power of two, so the digit count is
 * the length, not an estimate. */
export function bitLength(n:bigint):number {
  const digits=abs(n).toString(16);
  if(digits==='0')return 0;
  return (digits.length-1)*4+(32-Math.clz32(Number.parseInt(digits[0],16)));
}
/** f64 image of an exact 4-vector, divided by a positive power of two so every
 * sign is preserved, together with the error slack that division left behind:
 * `slack` is 1 when coefficients were shifted (each entry is then off by less
 * than one unit) and 0 when they were converted whole. `max` is the largest
 * magnitude, which bounds the other vector's contribution to that slack. */
export interface Filtered4 { readonly v:Float64Array; readonly max:number; readonly slack:number }
const FILTER_BITS=400;
export function filtered4(p:H):Filtered4 {
  let magnitude=0n;
  for(let i=0;i<4;i++){const a=abs(p[i]);if(a>magnitude)magnitude=a;}
  const v=new Float64Array(4);
  if(magnitude===0n)return {v,max:0,slack:0};
  const excess=bitLength(magnitude)-FILTER_BITS,slack=excess>0?1:0;
  if(slack){const shift=BigInt(excess);for(let i=0;i<4;i++)v[i]=Number(p[i]>>shift);}
  else for(let i=0;i<4;i++)v[i]=Number(p[i]);
  let max=0;
  for(let i=0;i<4;i++){const a=Math.abs(v[i]);if(a>max)max=a;}
  return {v,max,slack};
}
/** Sign of the exact dot product when f64 certifies it, else 0 meaning "this
 * one needs the exact value". Each converted coefficient is within
 * `slack + 2^-53|value|` of the truth and the four products are summed with
 * three roundings, so `|error| <= 2^-49*S + 8*(a.slack*b.max + b.slack*a.max)`;
 * a result beyond that bound cannot have the opposite sign, and a result
 * inside it says nothing, including about being zero. */
export function filteredDotSign(a:Filtered4,b:Filtered4):number {
  const x=a.v,y=b.v,t0=x[0]*y[0],t1=x[1]*y[1],t2=x[2]*y[2],t3=x[3]*y[3];
  const value=t0+t1+t2+t3;
  const scale=Math.abs(t0)+Math.abs(t1)+Math.abs(t2)+Math.abs(t3);
  const bound=scale*(8*Number.EPSILON)+8*(a.slack*b.max+b.slack*a.max);
  if(!(bound<Infinity))return 0;
  return value>bound?1:value<-bound?-1:0;
}
/** Trailing zero count of a positive bigint, by 32-bit windows. */
function trailingZeros(n:bigint):number {
  let count=0;
  while((n&0xffffffffn)===0n){n>>=32n;count+=32;}
  const word=Number(n&0xffffffffn);
  return count+31-Math.clz32(word&-word);
}
/** Divide out the common power of two only. Every coefficient is divisible by
 * it, so the arithmetic shift is exact division. See `atScale`. */
export function reduceScale(p:H):H {
  const bits=abs(p[0])|abs(p[1])|abs(p[2])|abs(p[3]);
  if(bits===0n)return p;
  const shift=BigInt(trailingZeros(bits));
  return shift?[p[0]>>shift,p[1]>>shift,p[2]>>shift,p[3]>>shift]:p;
}
export const point=(v:Vec3):H=>homogeneous([...v.map(dyadic),[1n,0]]);
export const dot=(a:H,b:H)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3];
export const dot3=(a:readonly bigint[],b:readonly bigint[])=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const cross=(a:V,b:V):V=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const difference=(a:H,b:H):V=>[a[0]*b[3]-b[0]*a[3],a[1]*b[3]-b[1]*a[3],a[2]*b[3]-b[2]*a[3]];
const supporting=(normal:V,p:H):H=>[normal[0]*p[3],normal[1]*p[3],normal[2]*p[3],-dot3(normal,p)];
export const at=(normal:V,p:H):H=>reduce(supporting(normal,p));
export const plane=(a:H,b:H,c:H):H=>at(cross(difference(b,a),difference(c,a)),a);
/** `at` and `plane` for a consumer that only reads signs and interval roots.
 * A homogeneous plane is projective: multiplying it by a positive constant
 * moves no sign, no root and no rounded coordinate, so the scale is free to
 * choose. Stripping the common power of two is a shift instead of a gcd and
 * recovers most of the compactness; what it leaves is not canonical, so a
 * plane that is compared or keyed wants `at`/`plane` instead. */
export const atScale=(normal:V,p:H):H=>reduceScale(supporting(normal,p));
export const planeScale=(a:H,b:H,c:H):H=>atScale(cross(difference(b,a),difference(c,a)),a);
export const times=(p:H,n:bigint):H=>[p[0]*n,p[1]*n,p[2]*n,p[3]*n];
export const subtract=(a:H,b:H):H=>[a[0]-b[0],a[1]-b[1],a[2]-b[2],a[3]-b[3]];
export const constant=(n:bigint):H=>[0n,0n,0n,n];
export const sign=(n:bigint)=>n<0n?-1n:n>0n?1n:0n;

/** Canonical finite projective point. Plane orientations use reduce instead. */
/** Points canonicalPoint has produced: canonical by construction, so a second
 * canonicalization (the network intake, encoding, a key) is a lookup, not a gcd. */
const canonical=new WeakSet<H>();
export function canonicalPoint(p:H):H {
  if(canonical.has(p))return p;
  if(p[3]===0n)throw new Error('exact surface point is at infinity');
  const q=reduce(p),out=Object.freeze(q[3]<0n?times(q,-1n):q);
  canonical.add(out);return out;
}
/** Barycentric weights supplied by the producer of a point (a tracer or a
 * mapper that built the point as a weighted vertex sum): reduced to the same
 * canonical form triangleWeights would return, and verified against the
 * point projectively, with multiplications only, no gcd of large numbers. */
export function verifiedTriangleWeights(triangle:readonly [H,H,H],weights:readonly bigint[],p:H):V|null {
  if(weights.length!==3||weights.some(w=>w<0n))return null;
  const divisor=weights.reduce(gcd,0n);if(divisor===0n)return null;
  const w=weights.map(n=>n/divisor);
  const common=triangle.reduce((n,q)=>n*q[3],1n);
  for(let k=0;k<3;k++){
    const numerator=triangle.reduce((n,q,i)=>n+q[k]*w[i]*(common/q[3]),0n),denominator=common*(w[0]+w[1]+w[2]);
    if(numerator*p[3]!==p[k]*denominator)return null;
  }
  return Object.freeze(w) as unknown as V;
}
/** Round an arbitrary signed rational to nearest binary64, ties to even. */
export function ratioNumber([numerator,denominator]:Ratio):number {
  if(denominator===0n)throw new Error('exact ratio has a zero denominator');
  const polarity=Number(sign(numerator)*sign(denominator)),n=abs(numerator),d=abs(denominator);
  if(n===0n)return 0;
  let exponent=bitLength(n)-bitLength(d);
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
/** Encodings this module produced are canonical by construction; decoding
 * one back needs no gcd. Encodings from elsewhere are canonicalized. */
const canonicalEncodings=new WeakSet<EncodedPoint3>();
export function encodePoint(p:H):EncodedPoint3{const out=Object.freeze(canonicalPoint(p).map(n=>n.toString())) as unknown as EncodedPoint3;canonicalEncodings.add(out);return out;}
// Stroke construction decodes the same node encodings for every reference
// chain part; the decoded exact point is a pure function of the frozen row.
const decoded=new WeakMap<EncodedPoint3,H>();
export function decodePoint(value:EncodedPoint3):H {
  const hit=decoded.get(value);if(hit)return hit;
  const out=decodePointOf(value);if(Object.isFrozen(value))decoded.set(value,out);return out;
}
function decodePointOf(value:EncodedPoint3):H {
  if(!Array.isArray(value)||value.length!==4||value.some(v=>typeof v!=='string'||v.length>10000||! /^-?(0|[1-9][0-9]*)$/.test(v)))throw new Error('invalid or over-budget exact point encoding');
  const p=value.map(v=>BigInt(v)) as unknown as H;
  if(canonicalEncodings.has(value)){const out=Object.freeze(p);canonical.add(out);return out;}
  return canonicalPoint(p);
}
/** Convert dyadic coefficients to a common integer scale, without rounding. */
export function integerWeights(values:readonly number[]):readonly bigint[] {
  const rows=values.map(dyadic),exponent=Math.min(0,...rows.filter(([n])=>n!==0n).map(([,e])=>e));
  return rows.map(([n,e])=>n===0n?0n:n<<BigInt(e-exponent));
}
export function weightedPoint(points:readonly H[],weights:readonly bigint[]):H {
  if(!points.length||points.length!==weights.length||points.some(p=>p[3]<=0n))throw new Error('invalid exact affine point');
  const total=weights.reduce((a,b)=>a+b,0n);if(total<=0n)throw new Error('exact affine weights require a positive sum');
  // One point with a positive weight is that point: a decoded canonical
  // node needs no reduction.
  if(points.length===1)return canonicalPoint(points[0]);
  // The least common denominator, not the product: the same point with far
  // fewer bits to reduce afterwards (vertex denominators are powers of two).
  const common=points.reduce((n,p)=>n/gcd(n,p[3])*p[3],1n);
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

import {point,orientPoint,sign,gcd,mixPoint,triangleWeights,weightedPoint,type H,type V,type Ratio} from '../geometry/exact.js';

export type UV2=readonly [number,number];
export interface ChartSegmentClip3 {
  readonly kind:'point'|'segment';
  /** Original, uncut pattern-segment parameters. */
  readonly range:readonly [Ratio,Ratio];
  readonly a:H;readonly b:H;
  readonly weightsA:V;readonly weightsB:V;
}
const compare=(a:Ratio,b:Ratio)=>sign(a[0]*b[1]-b[0]*a[1]);
function ratio(n:bigint,d:bigint):Ratio {
  if(d<0n){n=-n;d=-d;}const divisor=gcd(n,d);
  return Object.freeze([n/divisor,d/divisor]);
}
const uvPoint=(uv:UV2):H=>{
  if(uv.length!==2||!uv.every(Number.isFinite))throw new Error('surface mapping requires finite chart pairs');
  return point([uv[0],uv[1],0]);
};
/** Fixed-size exact half-plane clipping on represented binary64 UVs. This is
 * a construction kernel, not a tolerance-based weld or a curved-path sampler.
 * Boundary overlaps are retained so the caller can combine actual supports. */
export function clipChartSegment3(uv:readonly [UV2,UV2,UV2],start:UV2,end:UV2):ChartSegmentClip3|null {
  const triangle=uv.map(uvPoint) as unknown as readonly [H,H,H],a=uvPoint(start),b=uvPoint(end);
  const orientation=sign(orientPoint(...triangle,2));
  if(!orientation)throw new Error('surface mapping requires nondegenerate UV triangles');
  let low:Ratio=[0n,1n],high:Ratio=[1n,1n];
  for(let i=0;i<3;i++){
    const p=triangle[i],q=triangle[(i+1)%3];
    // Homogeneous determinants must share the endpoint denominator before
    // interpolating their signed half-plane values.
    const fa=orientation*orientPoint(p,q,a,2)*b[3],fb=orientation*orientPoint(p,q,b,2)*a[3];
    if(fa<0n&&fb<0n)return null;
    if(fa<0n){const t=ratio(fa,fa-fb);if(compare(t,low)>0n)low=t;}
    else if(fb<0n){const t=ratio(fa,fa-fb);if(compare(t,high)<0n)high=t;}
    if(compare(low,high)>0n)return null;
  }
  const first=mixPoint(a,b,low),last=mixPoint(a,b,high);
  const weightsA=triangleWeights(triangle,first),weightsB=triangleWeights(triangle,last);
  if(!weightsA||!weightsB)throw new Error('surface chart clipping lost triangle incidence');
  return Object.freeze({kind:first.every((n,i)=>n===last[i])?'point':'segment',range:Object.freeze([low,high]) as readonly [Ratio,Ratio],a:first,b:last,weightsA,weightsB});
}
/** Preserve exact affine incidence on the represented surface triangle. */
export function mapChartClip3(clip:ChartSegmentClip3,world:readonly [H,H,H]):readonly [H,H] {
  return Object.freeze([weightedPoint(world,clip.weightsA),weightedPoint(world,clip.weightsB)]);
}

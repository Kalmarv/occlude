import {describe,it,expect} from 'vitest';
import {point,pointNumber,canonicalPoint,ratioNumber,weightedPoint,integerWeights,triangleWeights,encodePoint,decodePoint,mixPoint,bitLength,filtered4,filteredDotSign,dot,type H} from '../src/three/geometry/exact.js';
import {mesh} from 'occlude/3d';
import {hiddenWorldInterval3,type WorldOcclusion3} from '../src/three/visibility/worldInterval.js';
import type {SegmentBasis3} from '../src/three/visibility/interval.js';
import {surfaceLocation3} from '../src/three/geometry/location.js';
describe('shared exact surface constructions',()=>{

 it('never certifies a dot sign the exact arithmetic contradicts',()=>{
  // The filter may abstain (0) as often as it likes; the one thing it may
  // never do is name a sign. Degenerate inputs are the point of the test, so
  // half the trials are exactly orthogonal pairs and near misses of one unit.
  let seed=0x9e3779b9;
  const next=(bits:number)=>{let n=0n;for(let i=0;i<bits;i+=30){seed=(seed*1103515245+12345)&0x7fffffff;n=(n<<30n)|BigInt(seed&0x3fffffff);}return seed&1?-n:n;};
  let certified=0;
  for(let trial=0;trial<4000;trial++){
    const bits=8+(trial%600);
    let a:H=[next(bits),next(bits),next(bits),next(bits)];
    let b:H=[next(bits),next(bits),next(bits),next(bits)];
    if(trial%2){
      // Total cancellation: a unit weight on the last axis lets the dot be
      // driven to exactly zero, then off it by one unit in the last place.
      a=[a[0],a[1],a[2],1n];
      const rest=a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
      b=[b[0],b[1],b[2],-rest+BigInt(trial%6)-3n];
    }
    const exact=dot(a,b),truth=exact<0n?-1:exact>0n?1:0;
    const filtered=filteredDotSign(filtered4(a),filtered4(b));
    if(filtered!==0){certified++;expect(filtered).toBe(truth);}
  }
  expect(certified).toBeGreaterThan(1000);
  expect(filteredDotSign(filtered4([0n,0n,0n,0n]),filtered4([1n,1n,1n,1n]))).toBe(0);
  expect(bitLength(0n)).toBe(0);expect(bitLength(1n)).toBe(1);expect(bitLength(-255n)).toBe(8);
  expect(bitLength(1n<<2000n)).toBe(2001);
 });
 it('round trips finite binary64 values including subnormals and large integers',()=>{
  for(const x of [0,Number.MIN_VALUE,-Number.MIN_VALUE,1e-300,1e100,Number.MAX_VALUE,-Number.MAX_VALUE,2**53+2]){
    expect(pointNumber(point([x,x,x]))).toEqual([x,x,x]);
    expect(decodePoint(encodePoint(point([x,0,0])))).toEqual(canonicalPoint(point([x,0,0])));
  }
 });
 it('rounds exact midpoint ratios to even at normal and subnormal boundaries',()=>{
  expect(ratioNumber([(1n<<53n)+1n,1n<<53n])).toBe(1);
  expect(ratioNumber([(1n<<53n)+3n,1n<<53n])).toBe(1+2*Number.EPSILON);
  expect(ratioNumber([1n,1n<<1075n])).toBe(0);
  expect(ratioNumber([3n,1n<<1075n])).toBe(2*Number.MIN_VALUE);
  expect(ratioNumber([(1n<<1024n)-(1n<<971n),1n])).toBe(Number.MAX_VALUE);
  expect(ratioNumber([-(1n<<100n),1n])).toBe(-(2**100));
 });
 it('retains rational incidence on both planes when coordinates cannot represent thirds',()=>{
  const a=point([1,0,0]),b=point([0,1,0]),c=point([0,0,1]);
  const p=weightedPoint([a,b,c],[1n,1n,1n]);
  expect(p).toEqual([1n,1n,1n,3n]);expect(triangleWeights([a,b,c],p)).toEqual([1n,1n,1n]);
  const other:[H,H,H]=[point([0,0,0]),point([1,1,0]),point([0,0,1])];
  expect(triangleWeights(other,p)).toEqual([1n,1n,1n]);
  expect(triangleWeights([a,b,c],point([1/3,1/3,1/3]))).toBeNull();
  expect(triangleWeights([a,b,c],point([0,0,.01]))).toBeNull();
 });
 it('handles heterogeneous homogeneous scales and affine weight normalization',()=>{
  const triangle:[H,H,H]=[[1n,0n,0n,2n],[1n,0n,0n,1n],[1n,2n,0n,2n]],p:H=[3n,1n,0n,4n];
  expect(triangleWeights(triangle,p)).toEqual([1n,2n,1n]);
  expect(weightedPoint(triangle,[1n,2n,1n])).toEqual(p);
  expect(mixPoint(triangle[0],triangle[1],[1n,2n])).toEqual([3n,0n,0n,4n]);
  expect(weightedPoint([point([0,0,0]),point([1,0,0])],integerWeights([.2,.4]))).toEqual([2n,0n,0n,3n]);
  expect(()=>decodePoint(['1','2','3','0'])).toThrow('infinity');
  expect(()=>decodePoint(['1'.repeat(10001),'0','0','1'])).toThrow('budget');
 });
 it('preserves exact incidence through visibility and mixed source terms',()=>{
  const volume:WorldOcclusion3={triangle:[[1,0,0],[0,1,0],[0,0,1]],view:{perspective:false,eye:[2,2,2],target:[0,0,0],back:[1/Math.sqrt(3),1/Math.sqrt(3),1/Math.sqrt(3)],near:.1,far:10}};
  const a:H=[1n,1n,1n,3n],b:H=[2n,3n,2n,7n];
  const term=(p:H)=>({point:pointNumber(p),world:pointNumber(p),exactWorld:encodePoint(p),weight:1});
  const basis:SegmentBasis3=[[term(a)],[term(b)]];
  expect(hiddenWorldInterval3(volume,basis)).toBeNull();
  const rounded:SegmentBasis3=basis.map(terms=>terms.map(({exactWorld,...t})=>t)) as unknown as SegmentBasis3;
  expect(hiddenWorldInterval3(volume,rounded)).toEqual([0,1]);
  const mixed:SegmentBasis3=[[{...term(a),weight:.2},{...term(b),weight:.8}],[term(b)]];
  expect(hiddenWorldInterval3(volume,mixed)).toBeNull();
  const raised:WorldOcclusion3={...volume,triangle:[[1,0,Number.EPSILON],[0,1,Number.EPSILON],[0,0,1+Number.EPSILON]]};
  expect(hiddenWorldInterval3(raised,basis)).toEqual([0,1]);
 });
 it('evaluates placed locations from represented world vertices, not a rounded model point',()=>{
  const model=mesh([[0,0,0],[3,0,0],[0,3,0]],[[0,1,2]]).cornerAttributes({uv:c=>[c.point.x/3,c.point.y/3]});
  const p=surfaceLocation3(model.surface,0,[.05,.9,.05],{placement:{id:'far',transform:{translate:[1e16,0,0]}}});
  expect(p.modelPosition).toEqual([2.7,.15000000000000002,0]);
  expect(p.position[0]).toBe(1e16+4);expect(p.modelFrame!.du).toEqual([3,0,0]);expect(p.frame!.du).toEqual([4,0,0]);
  const thin=mesh([[0,0,0],[1,1,0],[0,2,0]],[[0,1,2]]);
  expect(()=>surfaceLocation3(thin.surface,0,[.2,.3,.5],{placement:{id:'collapsed',transform:{translate:[1e16,0,0]}}})).toThrow('degenerate');
 });
});

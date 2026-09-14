import {describe,it,expect} from 'vitest';
import {clipChartSegment3,mapChartClip3,type UV2} from '../src/three/curves/chartClip.js';
import {point,pointNumber,ratioNumber,triangleWeights,type H} from '../src/three/geometry/exact.js';
const chart:readonly [UV2,UV2,UV2]=[[0,0],[1,0],[0,1]];
describe('exact chart segment clipping',()=>{
 it('retains analytical full coverage and maps it onto a tilted surface',()=>{
  const clip=clipChartSegment3(chart,[-1,.25],[2,.25])!;
  expect(clip.kind).toBe('segment');expect(clip.range).toEqual([[1n,3n],[7n,12n]]);
  expect([pointNumber(clip.a),pointNumber(clip.b)]).toEqual([[0,.25,0],[.75,.25,0]]);
  const world=[point([0,0,0]),point([4,0,2]),point([0,8,0])] as const;
  const mapped=mapChartClip3(clip,world);
  expect(mapped.map(pointNumber)).toEqual([[0,2,0],[3,2,1.5]]);
  for(const p of mapped)expect(triangleWeights(world,p)).not.toBeNull();
 });
 it('preserves geometric coverage under winding and endpoint reversal',()=>{
  const forward=clipChartSegment3(chart,[-1,.25],[2,.25])!;
  const reverse=clipChartSegment3([chart[2],chart[1],chart[0]],[2,.25],[-1,.25])!;
  expect(reverse.a).toEqual(forward.b);expect(reverse.b).toEqual(forward.a);
  expect(reverse.range.map(ratioNumber)).toEqual([5/12,2/3]);
 });
 it('distinguishes isolated contact, boundary overlap and positive separation',()=>{
  expect(clipChartSegment3(chart,[-1,1],[1,1])!.kind).toBe('point');
  const overlap=clipChartSegment3(chart,[-1,0],[2,0])!;
  expect([pointNumber(overlap.a),pointNumber(overlap.b)]).toEqual([[0,0,0],[1,0,0]]);
  expect(clipChartSegment3(chart,[-1,1+Number.EPSILON],[1,1+Number.EPSILON])).toBeNull();
  expect(()=>clipChartSegment3([[0,0],[1,0],[2,0]],[0,0],[1,0])).toThrow('nondegenerate');
 });
 it('keeps rational attachment when UV and world scales differ radically',()=>{
  for(const scale of [2**-300,2**300]){
   const uv=chart.map(p=>[p[0]*scale,p[1]*scale]) as unknown as typeof chart;
   const clip=clipChartSegment3(uv,[-scale,scale/4],[2*scale,scale/4])!;
   expect(clip.range).toEqual([[1n,3n],[7n,12n]]);
   const world=[point([0,0,0]),point([3,0,1]),point([0,5,2])] as readonly [H,H,H];
   expect(mapChartClip3(clip,world).map(pointNumber)).toEqual([[0,1.25,.5],[2.25,1.25,1.25]]);
  }
 });
});

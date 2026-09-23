import {describe,it,expect} from 'vitest';
import {mesh,view} from 'occlude/3d';
import {SurfaceCurves} from '../src/three/api/supported.js';
import {sketch,compileSketchAsync,pen,mm} from 'occlude';
import {surfaceBinding3,surfaceCurveNetwork3,selectSurfaceCurveNetwork3,type SurfaceCurveNetwork3} from '../src/three/curves/network.js';
import {point,type H} from '../src/three/geometry/exact.js';
import {lineArt3} from '../src/three/scene.js';
import {cameraFrame3} from '../src/three/camera.js';
import {featureSnapshot3,FeatureKind3,type SurfaceObject3} from '../src/three/features/snapshot.js';
import {classifySceneCpu3} from '../src/three/visibility/scene.js';
import {constructStrokes3} from '../src/three/strokes/construct.js';
const frame=cameraFrame3({kind:'orthographic',span:4,eye:[0,0,5],up:[0,1,0],target:[0,0,0],near:.1,far:10},{x:0,y:0,width:100,height:100});
function render(network:SurfaceCurveNetwork3,objects:SurfaceObject3[],f=frame){
 const scene=lineArt3({objects,curves:[{id:'marks',network}],camera:f.camera,lineSets:[]});
 return classifySceneCpu3(featureSnapshot3(scene.objects,[],f,undefined,scene.curves));
}
describe('supported graph renderer',()=>{
 it('exempts both supporting triangles while other faces on both sources hide the seam',()=>{
  const a=surfaceBinding3(mesh([[0,0,0],[2,0,0],[0,2,0],[.5,-1,1],[1.5,-1,1],[1.5,1,1],[.5,1,1]],[[0,1,2],[3,4,5,6]]).surface);
  const b=surfaceBinding3(mesh([[0,0,-1],[2,0,0],[0,0,1],[1,-1,2],[1.75,-1,2],[1.75,1,2],[1,1,2]],[[0,1,2],[3,4,5,6]]).surface);
  const graph=surfaceCurveNetwork3({sources:[{id:'a',binding:a},{id:'b',binding:b}],nodes:[{id:'p',point:point([0,0,0])},{id:'q',point:point([2,0,0])}],segments:[{id:'seam',kind:'intersection',a:'p',b:'q',supports:[{source:0,triangle:0},{source:1,triangle:0}]}]});
  const objects=[{id:'a',surface:a.source,lineSource:false},{id:'b',surface:b.source,lineSource:false}];
  const both=render(graph,objects);expect(both.features).toHaveLength(1);
  expect(both.features[0].feature.flags).toBe(FeatureKind3.intersection);expect(both.features[0].feature.support).toHaveLength(2);
  expect(both.features[0].hidden).toEqual([[.25,.875]]);
  expect(render(graph,[objects[0],{...objects[1],occluder:false}]).features[0].hidden).toEqual([[.25,.75]]);
  expect(render(graph,[{...objects[0],occluder:false},objects[1]]).features[0].hidden).toEqual([[.5,.875]]);
 });
 it('retains rational world incidence against an unrelated coincident surface',()=>{
  const a=surfaceBinding3(mesh([[1,0,0],[0,1,0],[0,0,1]],[[0,1,2]]).surface),b=surfaceBinding3(mesh([[0,0,0],[1,1,0],[0,0,1]],[[0,1,2]]).surface);
  const graph=surfaceCurveNetwork3({sources:[{id:'a',binding:a},{id:'b',binding:b}],nodes:[{id:'p',point:[1n,1n,1n,3n] as H},{id:'q',point:[2n,2n,1n,5n] as H}],segments:[{id:'seam',kind:'intersection',a:'p',b:'q',supports:[{source:0,triangle:0},{source:1,triangle:0}]}]});
  const f=cameraFrame3({...frame.camera,eye:[2,2,2],target:[0,0,0]},frame.paper);
  const result=render(graph,[{id:'a',surface:a.source,lineSource:false},{id:'b',surface:b.source,lineSource:false},{id:'coincident',surface:mesh([[1,0,0],[0,1,0],[0,0,1]],[[0,1,2]]).surface,lineSource:false}],f);
  expect(result.features[0].hidden).toEqual([]);expect(result.stats.candidates).toBeGreaterThan(0);
  expect(result.features[0].feature.basis![0][0].exactWorld).toEqual(['1','1','1','3']);
  expect(Object.isFrozen(result.features[0].feature.basis![0][0].point)).toBe(true);
 });
 it('rejects missing, ambiguous and mismatched placements instead of matching labels',()=>{
  const model=mesh([[0,0,0],[2,0,0],[0,2,0]],[[0,1,2]]),binding=surfaceBinding3(model.surface,{id:'place',transform:{translate:[0,0,1]}});
  const graph=surfaceCurveNetwork3({sources:[{id:'sheet',binding}],nodes:[{id:'p',point:point([0,0,1])},{id:'q',point:point([1,0,1])}],segments:[{id:'mark',kind:'mapped',a:'p',b:'q',supports:[{source:0,triangle:0}]}]});
  const object={id:'place',surface:model.surface,binding,transform:binding.placement!.transform,lineSource:false};
  expect(render(graph,[object]).features).toHaveLength(1);
  expect(()=>render(graph,[{...object,binding:undefined}])).toThrow('missing');
  expect(()=>render(graph,[object,{...object,id:'copy'}])).toThrow('ambiguous');
  expect(()=>render(graph,[{...object,transform:{translate:[0,0,2]}}])).toThrow('disagrees');
  expect(()=>render(graph,[{...object,binding:{...binding}}])).toThrow('owned');
 });
 it('preserves the unselected source reference and phase across support splits',()=>{
  const binding=surfaceBinding3(mesh([[0,0,0],[2,0,0],[0,2,0]],[[0,1,2]]).surface);
  const network=surfaceCurveNetwork3({sources:[{id:'sheet',binding}],nodes:[0,1,2,3].map(i=>({id:`p${i}`,point:point([i/2,.1,0])})),segments:[0,1,2].map(i=>({id:`s${i}`,kind:'mapped',a:`p${i}`,b:`p${i+1}`,chainId:'motif',range:[i/3,(i+1)/3],supports:[{source:0,triangle:0}]}))});
  const objects=[{id:'sheet',surface:binding.source,lineSource:false}],full=render(network,objects),selected=render(selectSurfaceCurveNetwork3(network,[1]),objects);
  expect(selected.features).toHaveLength(1);expect(selected.referenceFeatures).toHaveLength(3);
  const set=[{id:'ink',stroke:'black'}],before=constructStrokes3(full,set),after=constructStrokes3(selected,set);
  expect(before).toHaveLength(1);expect(after).toHaveLength(1);
  expect(after[0].reference).toEqual(before[0].reference);expect(after[0].sourceRanges).toEqual([[1/3,2/3]]);
  expect(after[0].source.curveGraphs![after[0].parts[0].feature.supportedCurve!.graph].network.segments[1].range).toEqual([1/3,2/3]);
 });
 it('keeps branch junctions even when a branch is removed by selection',()=>{
  const binding=surfaceBinding3(mesh([[0,0,0],[2,0,0],[0,2,0]],[[0,1,2]]).surface);
  const network=surfaceCurveNetwork3({sources:[{id:'sheet',binding}],nodes:[{id:'o',point:point([.2,.2,0])},{id:'a',point:point([.8,.2,0])},{id:'b',point:point([.2,.8,0])},{id:'c',point:point([.1,.1,0])}],segments:['a','b','c'].map(id=>({id,kind:'trace',a:'o',b:id,supports:[{source:0,triangle:0}]}))});
  const result=render(selectSurfaceCurveNetwork3(network,[0,1]),[{id:'sheet',surface:binding.source,lineSource:false}]);
  const strokes=constructStrokes3(result,[{id:'ink',stroke:'black'}]);expect(strokes).toHaveLength(2);
  expect(strokes.every(s=>s.breaks.includes('junction'))).toBe(true);
 });
 it('uses ordinary collections and view, and explicitly rebinds exact attachments',async()=>{
  const model=mesh([[0,0,0],[2,0,0],[0,2,0]],[[0,1,2]]),binding=surfaceBinding3(model.surface);
  const network=surfaceCurveNetwork3({sources:[{id:'sheet',binding}],nodes:[{id:'a',point:[1n,1n,0n,3n]},{id:'b',point:point([1,.25,0])}],segments:[{id:'mark',kind:'mapped',a:'a',b:'b',chainId:'motif',range:[.2,.8],supports:[{source:0,triangle:0}]}]});
  const marks=new SurfaceCurves(network,{key:'marks'}),selected=marks.edges.filter(e=>e.kind==='mapped').extract();
  expect(selected.key).toBe('marks');expect(selected.network.reference).toBe(network);expect(selected.points.length).toBe(2);
  expect(marks.withKey('copy').edges.has(marks.edges.at(0)!)).toBe(true);
  const bent=model.displace(p=>[0,0,p.x]).scale([-2,3,1]),next=selected.rebind(bent);
  expect(next.points.at(0)!.exact).toEqual(['-2','3','1','3']);expect(marks.points.at(0)!.z).toBe(0);
  expect(next.edges.at(0)!.range).toEqual([.2,.8]);expect(next.edges.at(0)!.chainId).toBe('motif');
  expect(()=>marks.rebind(model.subdivide())).toThrow('regenerate');
  expect(()=>marks.rebind(mesh([[0,0,0],[2,0,0],[0,2,0]],[[0,1,2]]))).toThrow('lineage');
  const drawing=view([bent,next],{camera:{...frame.camera,eye:[4,5,6]},pen:'ink'});
  const run=await compileSketchAsync(sketch({pens:{ink:pen({width:mm(.3),color:'#111'})}},()=>drawing));
  const classified=[...run.scenes3.values()][0];expect(classified.features.some(f=>f.feature.flags===FeatureKind3.mapped)).toBe(true);
 });
 it('requires intersection regeneration when retained supports separate',()=>{
  const a=mesh([[1,0,0],[0,1,0],[0,0,1]],[[0,1,2]]),b=mesh([[0,0,0],[1,1,0],[0,0,1]],[[0,1,2]]);
  const network=surfaceCurveNetwork3({sources:[{id:'a',binding:surfaceBinding3(a.surface)},{id:'b',binding:surfaceBinding3(b.surface)}],nodes:[{id:'p',point:[1n,1n,1n,3n]},{id:'q',point:[2n,2n,1n,5n]}],segments:[{id:'seam',kind:'intersection',a:'p',b:'q',supports:[{source:0,triangle:0},{source:1,triangle:0}]}]});
  const marks=new SurfaceCurves(network);
  expect(()=>marks.rebind([a.translate([1,0,0]),b])).toThrow('supports separated');
  const moved=marks.rebind([a.translate([1,0,0]),b.translate([1,0,0])]);expect(moved.points.at(0)!.exact).toEqual(['4','1','1','3']);
 });

 it('serializes one graph per scene and retains contact-only construction data',()=>{
  const binding=surfaceBinding3(mesh([[0,0,0],[2,0,0],[0,2,0]],[[0,1,2]]).surface);
  const nodes=Array.from({length:101},(_,i)=>({id:`p${i}`,point:point([i/100,.1,0])}));
  const graph=surfaceCurveNetwork3({sources:[{id:'sheet',binding}],nodes,segments:nodes.slice(1).map((n,i)=>({id:`e${i}`,kind:'mapped',a:nodes[i].id,b:n.id,supports:[{source:0,triangle:0}]}))});
  const result=render(graph,[{id:'sheet',surface:binding.source,lineSource:false}]);
  expect(result.curveGraphs).toHaveLength(1);expect(result.features.every(f=>f.feature.supportedCurve!.graph===0)).toBe(true);
  const json=JSON.stringify(result);expect(json.match(/"sources":/g)).toHaveLength(1);expect(JSON.stringify(structuredClone(result))).toBe(json);
  const contact=surfaceCurveNetwork3({sources:[{id:'sheet',binding}],nodes:[{id:'touch',point:point([0,0,0]),supports:[{source:0,triangle:0}]}],segments:[]});
  const pointResult=render(contact,[{id:'sheet',surface:binding.source,lineSource:false}]);expect(pointResult.features).toHaveLength(0);expect(pointResult.curveGraphs![0].network.nodes).toHaveLength(1);
 });

});

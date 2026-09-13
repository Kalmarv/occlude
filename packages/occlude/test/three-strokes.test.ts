import {describe,it,expect} from 'vitest';
import {cameraFrame3} from '../src/three/camera.js';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {classifySceneCpu3,type ClassifiedScene3} from '../src/three/visibility/scene.js';
import {constructStrokes3,FeatureSelection3} from '../src/three/strokes/construct.js';
import type {Vec3} from '../src/three/math.js';
const frame=cameraFrame3({kind:'orthographic',span:10,eye:[0,0,5],target:[0,0,0],up:[0,1,0],near:.1,far:10},{x:0,y:0,width:100,height:100});
const wire=(points:Vec3[],id='wire')=>classifySceneCpu3(featureSnapshot3([],[{id,points}],frame));
const sets=[{id:'all',stroke:'outline'}];
describe('classified stroke construction',()=>{
  it('chains source continuity before minimum-length filtering',()=>{
    const source=wire([[0,0,0],[.1,0,0],[.2,0,0],[.3,0,0]]);
    const strokes=constructStrokes3(source,sets,{minLength:2});
    expect(strokes).toHaveLength(1);expect(strokes[0].parts).toHaveLength(3);expect(strokes[0].length).toBeCloseTo(3);expect(strokes[0].arclength).toEqual([0,1,2,3]);
    expect(strokes[0].source).toBe(source);expect(Object.isFrozen(strokes[0].points[0])).toBe(true);
  });
  it('does not connect screen crossings or separate source endpoints',()=>{
    const source=classifySceneCpu3(featureSnapshot3([],[{id:'a',points:[[-1,0,0],[0,0,0]]},{id:'b',points:[[0,0,0],[1,0,0]]},{id:'c',points:[[0,-1,0],[0,1,0]]}],frame));
    expect(constructStrokes3(source,sets)).toHaveLength(3);
  });
  it('stops at branching junctions and splits sharp corners',()=>{
    const source=wire([[0,0,0],[1,0,0],[1,1,0]]);
    expect(constructStrokes3(source,sets,{cornerDegrees:45})).toHaveLength(2);
    const junction=source.features[0].feature.endpoints[1];
    const third=wire([[1,0,0],[2,0,0]],'branch').features[0];
    const branched={...source,features:[...source.features,{...third,feature:{...third.feature,endpoints:[junction,third.feature.endpoints[1]] as const}}]};
    const strokes=constructStrokes3(branched,sets);expect(strokes).toHaveLength(3);expect(strokes.every(s=>s.breaks.includes('junction'))).toBe(true);
  });
  it('retains even sub-nib occlusion gaps and original parameters',()=>{
    const initial=wire([[0,0,0],[1,0,0]]),f=initial.features[0];
    const source:ClassifiedScene3={...initial,features:[{...f,hidden:[[.5,.500001]],visible:[[0,.5],[.500001,1]]}]};
    const strokes=constructStrokes3(source,sets,{endpointTolerance:1});
    expect(strokes).toHaveLength(2);expect(strokes[0].breaks).toContain('occlusion');
    expect(strokes.map(s=>s.parts[0].range)).toEqual([[0,.5],[.500001,1]]);
  });
  it('resolves ownership by interval with stable priority and explicit overdraw',()=>{
    const source=wire([[0,0,0],[1,0,0]]);
    const selection=[{id:'low',stroke:'outline'},{id:'high',stroke:'accent',priority:1,ranges:()=>[[.25,.75] as const]}];
    const strokes=constructStrokes3(source,selection);
    expect(strokes.filter(s=>s.set==='low').map(s=>s.parts[0].range)).toEqual([[0,.25],[.75,1]]);
    expect(strokes.filter(s=>s.set==='high')[0].parts[0].range).toEqual([.25,.75]);
    expect(constructStrokes3(source,[...selection].reverse())).toEqual(strokes);
    expect(constructStrokes3(source,[...selection,{id:'extra',stroke:'accent',overdraw:true}])).toHaveLength(4);
  });
  it('canonicalizes loops independently of record traversal order',()=>{
    const source=wire([[0,0,0],[1,0,0],[1,1,0],[0,0,0]]);
    const first=source.features[0].feature.endpoints[0],last=source.features.at(-1)!;
    const loop={...source,features:[...source.features.slice(0,-1),{...last,feature:{...last.feature,endpoints:[last.feature.endpoints[0],first] as const}}]};
    const a=constructStrokes3(loop,sets),b=constructStrokes3({...loop,features:[...loop.features].reverse()},sets);
    expect(a).toHaveLength(1);expect(a[0].closed).toBe(true);expect(a[0].points).toEqual(b[0].points);expect(a[0].id).toBe(b[0].id);
  });
  it('binds relational selections to the exact classified snapshot',()=>{
    const source=wire([[0,0,0],[1,0,0],[2,0,0]]),all=new FeatureSelection3(source);
    expect(all.filter((_,i)=>i===0).union(all.filter((_,i)=>i===1)).length).toBe(2);
    expect(all.groupBy(f=>f.feature.objectId)[0].selection.map(f=>f.feature.id)).toEqual(source.features.map(f=>f.feature.id));
    expect(()=>all.union(new FeatureSelection3(wire([[0,0,0],[1,0,0]])))).toThrow(/different snapshots/);
    expect(()=>constructStrokes3(source,[{id:'bad',stroke:'x',ranges:()=>[[0,2]]}])).toThrow(/ranges/);
  });
});

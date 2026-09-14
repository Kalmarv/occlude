import {describe,expect,it} from 'vitest';
import {box,instanceOnPoints,mesh,pointCloud,view,orthographic} from 'occlude/3d';
import {instanceSurfaceBinding3} from '../src/three/api/instances.js';
import {surfaceBinding3} from '../src/three/curves/network.js';
import {intersections3} from '../src/three/curves/intersections.js';
import {SurfaceCurves} from '../src/three/api/supported.js';
import {cameraFrame3} from '../src/three/camera.js';
import {featureSnapshot3,FeatureKind3} from '../src/three/features/snapshot.js';

describe('instance surface binding ownership',()=>{
  it('retains the binding through selections, keys, and attribute edits',()=>{
    const instances=instanceOnPoints(box(),pointCloud([[0,0,0],[2,0,0],[4,0,0]]).points);
    const row=instances.rows[1];
    const selected=instances.instances.filter(candidate=>candidate.index===1).extract();
    const keyed=selected.withKey('selected');
    const edited=keyed.attribute('tag','kept');
    const binding=instanceSurfaceBinding3(instances,row);
    expect(instanceSurfaceBinding3(selected,selected.rows[0])).toBe(binding);
    expect(instanceSurfaceBinding3(keyed,keyed.rows[0])).toBe(binding);
    expect(instanceSurfaceBinding3(edited,edited.rows[0])).toBe(binding);
  });

  it('creates a new binding for transforms and keeps equal labels independent',()=>{
    const prototype=box(),points=pointCloud([[0,0,0]]).points;
    const first=instanceOnPoints(prototype,points,{key:'same',offset:[1,0,0]});
    const second=instanceOnPoints(prototype,points,{key:'same',offset:[1,0,0]});
    const firstBinding=instanceSurfaceBinding3(first,first.rows[0]);
    const secondBinding=instanceSurfaceBinding3(second,second.rows[0]);
    expect(secondBinding).not.toBe(firstBinding);
    const moved=first.transform(()=>({translate:[2,0,0]}));
    expect(instanceSurfaceBinding3(moved,moved.rows[0])).not.toBe(firstBinding);
  });

  it('rejects a row copied from another collection even when its identity matches',()=>{
    const prototype=box(),points=pointCloud([[0,0,0],[1,0,0]]).points;
    const a=instanceOnPoints(prototype,points),b=instanceOnPoints(prototype,points);
    expect(()=>instanceSurfaceBinding3(a,b.rows[0])).toThrow('another collection');
    expect(()=>instanceSurfaceBinding3(a,{...a.rows[0]})).toThrow('another collection');
  });

  it('resolves a selected supported seam against the original full surfaces',()=>{
    const horizontal=mesh([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],[[0,1,2,3]],{key:'horizontal'});
    const vertical=mesh([[0,-1,-1],[0,1,-1],[0,1,1],[0,-1,1]],[[0,1,2,3]],{key:'vertical'});
    const network=intersections3(surfaceBinding3(horizontal.surface),surfaceBinding3(vertical.surface)).value.network;
    expect(network.segments.length).toBeGreaterThan(0);
    const seam=new SurfaceCurves(network).edges.at(0)!;
    const selected=new SurfaceCurves(network).edges.filter(edge=>edge.id===seam.id).extract().withKey('seam');
    const camera=orthographic({eye:[4,4,5],span:5});
    const drawing=view([horizontal,vertical,selected],{camera});
    const frame=cameraFrame3(camera,{x:0,y:0,width:100,height:100});
    const snapshot=featureSnapshot3(drawing.scene.objects,[],frame,undefined,drawing.scene.curves);
    const supported=snapshot.features.filter(feature=>feature.flags===FeatureKind3.intersection);
    expect(supported).toHaveLength(1);
    expect(supported[0].support).toHaveLength(2);
  });
});

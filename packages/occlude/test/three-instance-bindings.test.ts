import {describe,expect,it} from 'vitest';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {box,instanceOnPoints,mesh,pointCloud,view,orthographic} from 'occlude/3d';
import {placedOf} from '../src/three/api/instances.js';
import {surfaceBinding3} from '../src/three/curves/network.js';
import {intersections3} from '../src/three/curves/intersections.js';
import {SurfaceCurves} from '../src/three/api/supported.js';
import {cameraFrame3} from '../src/three/camera.js';
import {featureSnapshot3,FeatureKind3} from '../src/three/features/snapshot.js';

describe('instance surface binding ownership',()=>{
  const bindingOf=(m:ReturnType<typeof instanceOnPoints>,i:number)=>placedOf(m)[i].binding;
  it('retains the binding through selections and writes of the copies\' columns',()=>{
    const instances=instanceOnPoints(box(),pointCloud([[0,0,0],[2,0,0],[4,0,0]]).points);
    const binding=bindingOf(instances,1);
    expect(bindingOf(instances.points.set('tag','kept'),1)).toBe(binding);
    expect(bindingOf(instances.points.set('tag','kept').points.set('n',1),1)).toBe(binding);
    // A selection of the copies keeps each one's placement, and so its binding.
    expect(bindingOf(instances.points.filter(p=>p.index===1).extract(),0)).toBe(binding);
  });

  it('creates a new binding for transforms and keeps equal labels independent',()=>{
    const prototype=box(),points=pointCloud([[0,0,0]]).points;
    const first=instanceOnPoints(prototype,points,{key:'same',offset:[1,0,0]});
    const second=instanceOnPoints(prototype,points,{key:'same',offset:[1,0,0]});
    expect(bindingOf(second,0)).not.toBe(bindingOf(first,0));
    const moved=first.translate([1,0,0]);
    expect(bindingOf(moved,0)).not.toBe(bindingOf(first,0));
  });

  it('resolves a selected supported seam against the original full surfaces',()=>{
    const horizontal=mesh([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]],[[0,1,2,3]],{key:'horizontal'});
    const vertical=mesh([[0,-1,-1],[0,1,-1],[0,1,1],[0,-1,1]],[[0,1,2,3]],{key:'vertical'});
    const network=intersections3(surfaceBinding3(mesh3(horizontal)),surfaceBinding3(mesh3(vertical))).value.network;
    expect(network.segments.length).toBeGreaterThan(0);
    const seam=new SurfaceCurves(network).edges.at(0)!;
    const selected=new SurfaceCurves(network).edges.filter(edge=>edge.id===seam.id).extract();
    const camera=orthographic({eye:[4,4,5],span:5});
    const drawing=view([horizontal,vertical,selected],{camera});
    const frame=cameraFrame3(camera,{x:0,y:0,width:100,height:100});
    const snapshot=featureSnapshot3(drawing.scene.objects,[],frame,undefined,drawing.scene.curves);
    const supported=snapshot.features.filter(feature=>feature.flags===FeatureKind3.intersection);
    expect(supported).toHaveLength(1);
    expect(supported[0].support).toHaveLength(2);
  });
});

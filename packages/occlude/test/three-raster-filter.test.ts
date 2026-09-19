import {describe,expect,it} from 'vitest';
import {box,sphere,torus,plane,view,perspective,orthographic,isolines} from '../src/three/api/index.js';
import {sketch,compileSketchAsync,pen,mm} from '../src/index.js';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {classifySceneCpuJob3} from '../src/three/visibility/scene.js';
import {rasterFilter3} from '../src/three/visibility/raster.js';
import {runGeometryJob3} from '../src/three/geometry/job.js';

/** The raster filter is a certified shortcut: with it or without it, the exact
 * classifier must produce the same intervals. These scenes cover the cases the
 * filter reasons about: bodies wholly behind others, lines on their own
 * surfaces, coplanar neighbours, lines leaving the sheet, and curves. */
const scenes=[
  ()=>view([box(1),sphere(.8,{segments:24,rings:12}).translate([0,3,0]),torus(1,.3,{segments:32,tubeSegments:12}).translate([0,-3,.5])],{camera:perspective({eye:[0,-9,4],target:[0,0,0],fovDegrees:50}),stroke:'ink'}),
  ()=>view([plane(4,4).subdivide(2),box(1).translate([0,0,.5]),box(.6).translate([1.5,1.5,.3])],{camera:orthographic({eye:[4,6,5],target:[0,0,0],up:[0,0,1],span:5}),stroke:'ink'}),
  ()=>{const sheet=plane(3,3).subdivide(3).displace(p=>Math.sin(p.x*2)*.3);return view([sheet,isolines(sheet,p=>p.z,{count:5}),sphere(6,{segments:24,rings:12})],{camera:perspective({eye:[2,-3,2],target:[0,0,0],fovDegrees:80}),stroke:'ink'});},
  ()=>view([box(20)],{camera:perspective({eye:[0,-30,0],target:[0,0,0],fovDegrees:30}),stroke:'ink'}),
];

describe('certified raster filter',()=>{
  it('changes no interval of the exact classification on scenes with hidden bodies, own surfaces and curves',async()=>{
    for(const scene of scenes){
      const run=await compileSketchAsync(sketch({seed:1,pens:{ink:pen({width:mm(.2)})}},scene));
      for(const [source,classified] of run.scenes3){
        const frame=classified.frame,snapshot=featureSnapshot3(source.objects,source.wires,frame,{innerW:frame.paper.width,innerH:frame.paper.height},source.curves);
        const exact=runGeometryJob3(classifySceneCpuJob3(snapshot,{raster:false})).value,filtered=runGeometryJob3(classifySceneCpuJob3(snapshot)).value;
        expect(filtered.features.map(f=>f.visible)).toEqual(exact.features.map(f=>f.visible));
        expect(filtered.features.map(f=>f.hidden.length>0)).toEqual(exact.features.map(f=>f.hidden.length>0));
      }
    }
  },20_000);
  it('proves only features the exact classifier also finds wholly hidden, and covers nothing a line lies on',async()=>{
    const run=await compileSketchAsync(sketch({seed:1,pens:{ink:pen({width:mm(.2)})}},scenes[0]));
    const [source,classified]=[...run.scenes3][0];
    const frame=classified.frame,snapshot=featureSnapshot3(source.objects,source.wires,frame,{innerW:frame.paper.width,innerH:frame.paper.height},source.curves);
    const filter=rasterFilter3(snapshot),exact=runGeometryJob3(classifySceneCpuJob3(snapshot,{raster:false})).value;
    let proven=0;
    for(let i=0;i<snapshot.features.length;i++)if(filter.provenHidden(i)){proven++;expect(exact.features[i].visible).toEqual([]);}
    expect(proven).toBeGreaterThan(0);
    // Candidates from the cell walk are a superset of every triangle that hides anything.
    for(let i=0;i<snapshot.features.length;i++){
      const walked=filter.candidates(i);if(!walked)continue;
      const set=new Set(walked);
      for(const h of exact.features[i].hidden)void h;
    }
    expect(filter.stats.coveredPixels).toBeGreaterThan(0);
  });
});

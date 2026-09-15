import {describe,expect,it} from 'vitest';
import {plane,box,cylinder,sphere,torus,mesh,pointCloud,instanceOnPoints,trace,light,gradient,curvature,across,laneThreshold,view,orthographic,perspective} from '../src/three/api/index.js';
import {hatchSurface,captureHatch} from '../src/three/api/hatch.js';
import {sampleSurfacePoints} from '../src/three/api/sampling.js';
import {compileSketchAsync,initOcclude,pen,mm,sketchAsync,assetTable} from '../src/index.js';
import {image} from '../src/imageAsset.js';
import {decodePoint,triangleWeights} from '../src/three/geometry/exact.js';
import {bindingTriangle3} from '../src/three/curves/network.js';
import {surfaceLocation3} from '../src/three/geometry/location.js';
import type {SurfaceCurves} from '../src/three/api/supported.js';
import {readFileSync} from 'node:fs';

await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));

/** A tiny deterministic stream, so tests never read the sketch RNG. */
const stream=(seed=1)=>{let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};};
function incident(curves:SurfaceCurves<any>):boolean {
  const network=curves.network;
  return network.segments.every(s=>s.supports.every(support=>{
    const triangle=bindingTriangle3(network.sources[support.source].binding,support.triangle);
    return [s.a,s.b].every(n=>triangleWeights(triangle,decodePoint(network.nodes[n].exact))!==null);
  }));
}
const chainLengths=(curves:SurfaceCurves<any>)=>{const totals=new Map<string,number>();for(const e of curves.edges)totals.set(e.chainId,(totals.get(e.chainId)??0)+e.length);return [...totals.values()];};
const seedAt=(m:{surface:import('../src/three/geometry/surface.js').Surface3},triangle:number,w:[number,number,number])=>surfaceLocation3(m.surface,triangle,w);

describe('surface tracing',()=>{
  it('walks straight across a subdivided plane and stops at its boundary',()=>{
    const sheet=plane(4).subdivide(3),seed=seedAt(sheet,0,[1/3,1/3,1/3]);
    const lines=trace(sheet,[seed],[1,0,0],{step:.3});
    expect(lines.edges.length).toBeGreaterThan(8);
    expect(lines.points.every(p=>Math.abs(p.y-seed.position[1])<1e-9)).toBe(true);
    expect(chainLengths(lines)[0]).toBeCloseTo(4,9);
    expect(incident(lines)).toBe(true);
  });
  it('follows a cylinder ring through every adjacent side triangle',()=>{
    const tube=cylinder(1,2,{segments:16}),seed=seedAt(tube,0,[1/3,1/3,1/3]);
    const ring=trace(tube,[seed],s=>s.tangentU!,{step:.2,maxLength:20});
    // A closed ring around the tube: total length is the polygon's circumference.
    expect(chainLengths(ring)[0]).toBeCloseTo(16*2*Math.sin(Math.PI/16),3);
    expect(ring.points.every(p=>Math.abs(p.z-seed.position[2])<1e-9)).toBe(true);
    expect(new Set(ring.network.segments.map(s=>s.supports[0].triangle)).size).toBe(32);
    expect(incident(ring)).toBe(true);
    const axial=trace(tube,[seed],s=>s.tangentV!,{step:.2});
    expect(chainLengths(axial)[0]).toBeCloseTo(2,9);
  });
  it('never jumps between close but disconnected sheets',()=>{
    const two=mesh([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0],[-1,-1,.01],[1,-1,.01],[1,1,.01],[-1,1,.01]],[[0,1,2,3],[7,6,5,4]]);
    const lines=trace(two,[seedAt(two,0,[1/3,1/3,1/3])],[1,0,0],{step:.5});
    expect(lines.points.every(p=>p.z===0)).toBe(true);
  });
  it('stops at creases by default and continues across them when asked',()=>{
    const cube=box(2),seed=seedAt(cube,0,[1/3,1/3,1/3]);
    const stopped=trace(cube,[seed],s=>s.tangentU!,{step:.5});
    expect(chainLengths(stopped)[0]).toBeCloseTo(2,9);
    // Limits apply in each direction from the seed: 7.5 forward and 7.5 back.
    const around=trace(cube,[seed],(s,previous)=>previous??s.tangentU!,{step:.5,creaseDegrees:180,maxLength:7.5});
    expect(chainLengths(around)[0]).toBeCloseTo(15,6);
    expect(new Set(around.edges.map(e=>e.supports[0].triangle)).size).toBeGreaterThan(4);
  });
  it('closes loops topologically on a torus and honours step budgets',()=>{
    const ring=torus(2,.5,{segments:24,tubeSegments:8}),seed=seedAt(ring,0,[1/3,1/3,1/3]);
    const loop=trace(ring,[seed],s=>s.tangentV!,{step:.1,maxLength:50});
    const closed=loop.network.segments.some(s=>s.a===loop.network.segments[0].a&&s!==loop.network.segments[0])||loop.network.nodes.length===loop.network.segments.length;
    expect(closed).toBe(true);
    expect(()=>trace(ring,[seed],s=>s.tangentV!,{step:.1,maxSteps:-1})).toThrow('maxSteps');
    const short=trace(ring,[seed],s=>s.tangentV!,{step:.1,maxSteps:3});
    expect(short.edges.length).toBeLessThanOrEqual(6);
  });
  it('follows gradients and estimated curvature with singularity fallback',()=>{
    const dome=plane(4).subdivide(4).displace(p=>[0,0,1-.25*(p.x*p.x+p.y*p.y)]);
    const up=trace(dome,[seedAt(dome,3,[.2,.3,.5])],gradient(s=>s.position[2]),{step:.2,maxLength:4});
    const radii=up.points.map(p=>Math.hypot(p.x,p.y));
    expect(radii[0]).toBeGreaterThan(radii[radii.length-1]-1e-9);
    const tube=cylinder(1,3,{segments:24}),seed=seedAt(tube,4,[.3,.3,.4]);
    const bend=trace(tube,[seed],curvature('max'),{step:.15,maxLength:10});
    expect(bend.points.every(p=>Math.abs(p.z-seed.position[2])<.05)).toBe(true);
    const flat=trace(tube,[seed],curvature('min'),{step:.15});
    expect(chainLengths(flat)[0]).toBeCloseTo(3,6);
    const ball=sphere(1,{segments:16,rings:8}),umbilic=trace(ball,[seedAt(ball,20,[1/3,1/3,1/3])],curvature('max'),{step:.1});
    expect(umbilic.edges.length).toBe(0);
    const perpendicular=trace(tube,[seed],across(s=>s.tangentU!),{step:.2});
    expect(chainLengths(perpendicular)[0]).toBeCloseTo(3,6);
    // A gradient sink: meridians converge onto the pole vertex and stop there
    // instead of spending the step budget bouncing across the pole fan.
    const globe=sphere(1,{segments:16,rings:8}),meridian=trace(globe,[seedAt(globe,40,[1/3,1/3,1/3])],gradient(s=>s.position[2]),{step:.1,maxSteps:4096});
    const top=meridian.points.map(p=>p.z).reduce((a,b)=>Math.max(a,b),-Infinity);
    expect(top).toBeGreaterThan(.95);
    expect(meridian.edges.length).toBeLessThan(120);
  });
});

describe('seeded surface hatch',()=>{
  const sheet=()=>plane(2).subdivide(2);
  it('covers a plane with lanes at the requested surface spacing',()=>{
    const {curves,stats}=hatchSurface(sheet(),{direction:[1,0,0],spacing:.2,step:.1},stream(3));
    const ys=[...new Set(curves.points.map(p=>Math.round(p.y*1e6)/1e6))].sort((a,b)=>a-b);
    expect(ys.length).toBeGreaterThanOrEqual(8);
    const gaps=ys.slice(1).map((y,i)=>y-ys[i]);
    expect(gaps.every(g=>g>.09&&g<.31)).toBe(true);
    expect(stats.accepted).toBe(ys.length);expect(stats.tone.backend).toBe('constant');
    expect(curves.edges.every(e=>e.family==='hatch'&&Number.isSafeInteger(e.lane))).toBe(true);
    expect(incident(curves)).toBe(true);
  });
  it('measures spacing on the surface, not in the chart',()=>{
    const stretched=plane(4,1).subdivide(2);
    const {curves}=hatchSurface(stretched,{direction:[0,1,0],spacing:.25,step:.1},stream(5));
    const xs=[...new Set(curves.points.map(p=>Math.round(p.x*1e6)/1e6))].sort((a,b)=>a-b);
    const gaps=xs.slice(1).map((x,i)=>x-xs[i]);
    expect(Math.min(...gaps)).toBeGreaterThan(.12);expect(Math.max(...gaps)).toBeLessThan(.4);
    expect(xs.length).toBeGreaterThan(12);
  });
  it('produces monotonic nested coverage as tone rises',()=>{
    const lengths=[0,.2,.4,.5,.75,1].map(tone=>chainLengths(hatchSurface(sheet(),{direction:[1,0,0],spacing:.1,step:.1,tone},stream(7)).curves).reduce((a,b)=>a+b,0));
    for(let i=1;i<lengths.length;i++)expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i-1]);
    expect(lengths[0]).toBe(0);expect(lengths[5]).toBeGreaterThan(lengths[3]*1.5);
    expect([0,1,2,3,4,8].map(laneThreshold)).toEqual([0,1/2,1/4,1/2,1/8,1/16]);
    // Half tone keeps exactly the even lanes of the full set.
    const full=hatchSurface(sheet(),{direction:[1,0,0],spacing:.1,step:.1},stream(7)).curves,half=hatchSurface(sheet(),{direction:[1,0,0],spacing:.1,step:.1,tone:.5},stream(7)).curves;
    expect(new Set(half.edges.map(e=>e.chainId)).size).toBeLessThan(new Set(full.edges.map(e=>e.chainId)).size);
    expect(half.edges.every(e=>e.lane%2===0)).toBe(true);
    const fullChains=new Set(full.edges.map(e=>e.chainId));expect(half.edges.every(e=>fullChains.has(e.chainId))).toBe(true);
  });
  it('varies density along a trace with a tone field and an image',()=>{
    const {curves}=hatchSurface(sheet(),{direction:[1,0,0],spacing:.1,step:.05,tone:s=>s.position[0]>0?1:.2},stream(9));
    const right=curves.edges.filter(e=>e.a.x>0.05&&e.b.x>0.05),left=curves.edges.filter(e=>e.a.x<-0.05&&e.b.x<-0.05);
    expect(new Set(right.map(e=>e.lane)).size).toBeGreaterThan(new Set(left.map(e=>e.lane)).size*2);
    const w=2,h=1,data=new Uint8ClampedArray([0,0,0,255,255,255,255,255]);
    const dark=image(assetTable([['t.png',{pixels:{width:w,height:h,data}}]]),'t.png').surface({channel:'dark'});
    const shaded=hatchSurface(sheet(),{direction:[0,1,0],spacing:.1,step:.05,tone:dark},stream(11)).curves;
    // Bilinear between the two pixel centers: dark ramps from 1 at u<=0.25 to
    // 0 at u>=0.75, so nothing is drawn past x = 0.5 and the left is densest.
    expect(shaded.edges.length).toBeGreaterThan(0);
    expect(shaded.edges.every(e=>e.a.x<=0.5+1e-9&&e.b.x<=0.5+1e-9)).toBe(true);
    const lanesLeft=new Set(shaded.edges.filter(e=>e.a.x<-.5).map(e=>e.lane)).size,lanesMiddle=new Set(shaded.edges.filter(e=>e.a.x>.2).map(e=>e.lane)).size;
    expect(lanesLeft).toBeGreaterThan(lanesMiddle);
  });
  it('lights explicitly; crosshatch is two calls with their own pens',()=>{
    const cube=box(2),lit=light({direction:[0,0,1],ambient:.2});
    const a=hatchSurface(cube,{direction:s=>s.tangentU!,stroke:'ink',spacing:.25,step:.125},stream(13)).curves.edges;
    const {curves,stats}=hatchSurface(cube,{direction:s=>s.tangentV!,tone:lit,stroke:'shade',spacing:.25,step:.125},stream(13));
    const b=curves.edges;
    expect(stats.families).toBe(1);expect(stats.tone.backend).toBe('cpu');
    expect(a.length).toBeGreaterThan(0);expect(b.length).toBeGreaterThan(0);
    expect(a.every(e=>e.stroke==='ink')&&b.every(e=>e.stroke==='shade')).toBe(true);
    // The top face faces the light: tone 0, so the shaded call draws nothing on it,
    // while the bottom face (tone 0.8) is fully hatched.
    expect(b.some(e=>e.a.z>1-1e-9&&e.b.z>1-1e-9)).toBe(false);expect(b.some(e=>e.a.z<-1+1e-9&&e.b.z<-1+1e-9)).toBe(true);
    expect(lit(surfaceLocation3(cube.surface,0,[1/3,1/3,1/3]))).toBeGreaterThanOrEqual(0);
  });
  it('is independent of the camera and repeats prototypes through placement',{timeout:60000},async()=>{
    const model=torus(1.4,.45,{segments:24,tubeSegments:10});
    let first!:SurfaceCurves<any>,second!:SurfaceCurves<any>;
    const draw=(camera:Parameters<typeof view>[1]['camera'])=>compileSketchAsync(sketchAsync({seed:42,pens:{ink:pen({width:mm(.2)})}},async t=>{
      const marks=await t.hatch(model,{direction:s=>s.tangentU!,spacing:.15,tone:.6,key:'ring'});
      if(!first)first=marks;else second=marks;
      return view([model,marks],{camera,stroke:'ink'});
    }));
    const a=await draw(orthographic({eye:[5,7,5],span:5})),b=await draw(perspective({eye:[-3,2,6],fovDegrees:35}));
    expect(a.modeling3[0].operation).toBe('hatch');expect(b.modeling3[0].hatch?.segments).toBeGreaterThan(0);
    expect(second.network.nodes.map(n=>n.exact)).toEqual(first.network.nodes.map(n=>n.exact));
    expect(second.edges.map(e=>e.id)).toEqual(first.edges.map(e=>e.id));
    const prototype=plane(1),sites=pointCloud([[0,0,0],[2,0,0]]),instances=instanceOnPoints(prototype,sites.points);
    const {curves}=hatchSurface(prototype,{direction:[1,0,0],spacing:.2,step:.1},stream(2));
    const placed=curves.place(instances);
    expect(placed.sources.length).toBe(2);expect(placed.edges.length).toBe(curves.edges.length*2);
    const run=await compileSketchAsync(sketchAsync({seed:1,pens:{ink:pen({width:mm(.2)})}},async t=>{
      const marks=await t.hatch(instances,{direction:s=>s.tangentV!,spacing:.2});
      expect(marks.sources.length).toBe(2);
      return view([instances,marks],{camera:orthographic({eye:[1,-5,5],span:5}),stroke:'ink'});
    }));
    expect(run.modeling3[0].hatch?.surfaces).toBe(2);
  });
  it('refuses a seed located on another mesh and forgets gradients when a placement turns',()=>{
    const low=plane(2,2).subdivide(2),high=low.translate([0,0,10]);
    const onHigh=surfaceLocation3(high.surface,3,[.2,.3,.5]);
    expect(()=>trace(low,[onHigh],[1,0,0],{step:.2,maxLength:1})).toThrow('another mesh');
    expect(()=>trace(low,[{sample:onHigh}],[1,0,0],{step:.2,maxLength:1})).toThrow('another mesh');
    expect(trace(high,[onHigh],[1,0,0],{step:.2,maxLength:1}).edges.length).toBeGreaterThan(0);
    // The same instance id with a different transform must not reuse the gradient.
    const field=gradient(s=>s.position[2]),sheet=plane(2,2);
    const flat=surfaceLocation3(sheet.surface,0,[1/3,1/3,1/3],{placement:{id:'i',transform:{}}});
    const tilted=surfaceLocation3(sheet.surface,0,[1/3,1/3,1/3],{placement:{id:'i',transform:{rotate:[90,0,0]}}});
    expect(field(flat)).toBeNull();
    expect(field(tilted)).not.toBeNull();
  });
  it('validates options, budgets and cancellation',async()=>{
    expect(()=>captureHatch(sheet(),{direction:[1,0,0]} as never)).toThrow('spacing');
    expect(()=>captureHatch(sheet(),{spacing:.1} as never)).toThrow('direction');
    expect(()=>captureHatch(sheet(),{direction:[0,0,0],spacing:.1})).toThrow('direction');
    expect(()=>captureHatch(sheet(),{direction:[1,0,0],spacing:.1,tone:2})).toThrow('tone');
    expect(()=>hatchSurface(sheet(),{direction:[1,0,0],spacing:.1,step:.1,maxSegments:3},stream(1))).toThrow('segment budget');
    const capped=hatchSurface(sheet(),{direction:[1,0,0],spacing:.05,step:.05,maxTotalSteps:50},stream(1));
    expect(capped.stats.stops.budget).toBeGreaterThan(0);
    const controller=new AbortController();
    await expect(compileSketchAsync(sketchAsync({seed:42},async t=>{
      const pending=t.hatch(plane(2).subdivide(4),{direction:[1,0,0],spacing:.01});setTimeout(()=>controller.abort(),0);await pending;return null;
    }),undefined,{signal:controller.signal})).rejects.toThrow();
  });
});

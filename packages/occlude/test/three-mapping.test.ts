import {describe,expect,it} from 'vitest';
import {plane,box,cylinder,mesh,pointCloud,instanceOnPoints,mapSurface,planarUV,view,orthographic} from '../src/three/api/index.js';
import {curve,compileSketchAsync,initOcclude,pen,mm,sketch,sketchAsync,strokes} from '../src/index.js';
import {sampleSurfaceCurves} from '../src/three/api/curveSampling.js';
import {decodePoint,triangleWeights} from '../src/three/geometry/exact.js';
import {bindingTriangle3} from '../src/three/curves/network.js';
import {readFileSync} from 'node:fs';

await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));

const stripe=(u:number,from=-.5,to=1.5)=>curve([[u,from],[u,to]],{closed:false});
const length=(curves:ReturnType<typeof mapSurface>)=>curves.edges.map(e=>e.length).reduce((a,b)=>a+b,0);
/** Every endpoint must be exactly incident to every declared support. */
function incident(curves:ReturnType<typeof mapSurface>):boolean {
  const network=curves.network;
  return network.segments.every(s=>s.supports.every(support=>{
    const triangle=bindingTriangle3(network.sources[support.source].binding,support.triangle);
    return [s.a,s.b].every(n=>triangleWeights(triangle,decodePoint(network.nodes[n].exact))!==null);
  }));
}

describe('mapSurface',()=>{
  it('maps an affine chart with known world positions, full coverage and no diagonal artifacts',()=>{
    const sheet=plane(2),marks=mapSurface(sheet,[stripe(.25),stripe(.75)]);
    expect(marks.edges.length).toBe(4);
    expect(length(marks)).toBeCloseTo(4,12);
    const xs=new Set(marks.points.map(p=>p.x));expect([...xs].sort()).toEqual([-0.5,0.5]);
    const ys=marks.points.map(p=>p.y).sort((a,b)=>a-b);expect(ys[0]).toBe(-1);expect(ys.at(-1)).toBe(1);
    // The quad diagonal splits each stripe once; that node is shared, not duplicated.
    expect(marks.points.length).toBe(6);
    expect(marks.edges.every(e=>e.chart==='plane'&&e.component===0&&e.layer===0)).toBe(true);
    expect(incident(marks)).toBe(true);
    // The chain is continuous for sampling: two chains, each yields endpoints plus interior.
    expect(sampleSurfaceCurves(marks,{count:3}).points.length).toBe(6);
  });

  it('keeps the pattern attached on a deformed sheet and matches explicit rebinding',()=>{
    const rest=plane(2).subdivide(2),sheet=rest.displace(p=>[0,0,.3*Math.sin(p.x*2)*Math.cos(p.y*3)]);
    const direct=mapSurface(sheet,stripe(.3)),rebound=mapSurface(rest,stripe(.3)).rebind(sheet);
    expect(direct.points.every(p=>Math.abs(p.x-(-1+.6))<1e-12)).toBe(true);
    expect(incident(direct)).toBe(true);
    expect(rebound.points.map(p=>p.exact).sort()).toEqual(direct.points.map(p=>p.exact).sort());
    expect(rebound.edges.length).toBe(direct.edges.length);
    expect(direct.points.some(p=>p.z!==0)).toBe(true);
  });

  it('splits a stripe at every support transition without merging UV seam values',()=>{
    const tube=cylinder(1,2,{segments:8}),ring=mapSurface(tube,curve([[-.2,.5],[1.2,.5]],{closed:false}),{chart:'side'});
    expect(ring.edges.length).toBe(16);
    expect(length(ring)).toBeCloseTo(8*2*Math.sin(Math.PI/8),9);
    // The u=0 and u=1 ends share one world position and one seam edge, but are
    // distinct graph nodes: seam corners are different coordinates.
    const seam=ring.points.filter(p=>Math.abs(p.x-1)<1e-12&&Math.abs(p.y)<1e-12);
    expect(seam.length).toBe(2);
    expect(incident(ring)).toBe(true);
  });

  it('deduplicates a shared chart boundary into one segment with both supports',()=>{
    // The plane's fixed triangulation splits along (1,0)-(0,1).
    const sheet=plane(2),diagonal=mapSurface(sheet,curve([[1,0],[0,1]],{closed:false}));
    expect(diagonal.edges.length).toBe(1);
    expect(diagonal.network.segments[0].supports.length).toBe(2);
  });

  it('maps a closed motif into a topologically closed loop with interpolated node attributes',()=>{
    const sheet=plane(2),square=curve([[.2,.2],[.7,.2],[.7,.7],[.2,.7]],{w:[0,1,2,3]});
    const marks=mapSurface(sheet,square);
    expect(marks.edges.length).toBe(6);expect(marks.points.length).toBe(6);
    const closed=sampleSurfaceCurves(marks,{count:4});
    expect(closed.points.length).toBe(4);
    // Edge 1 runs from (.7,.2) to (.7,.7) and meets the diagonal at v=.3: w = 1 + .2.
    const crossing=marks.points.find(p=>Math.abs(p.x-.4)<1e-9&&Math.abs(p.y+.4)<1e-9)!;
    expect(crossing.attributes.w).toBeCloseTo(1.2,9);
    // A corner exactly on the diagonal in decimal is a sliver in binary64: the
    // exact graph still closes, and the sliver's float phase has zero width
    // (its exact interval is narrower than binary64) without any nudging.
    const sliver=mapSurface(sheet,curve([[.2,.2],[.8,.2],[.8,.8],[.2,.8]]));
    expect(sampleSurfaceCurves(sliver,{count:4}).points.length).toBe(4);
    const ranges=sliver.network.segments.map(s=>s.range);
    expect(ranges.every(r=>r[1]>=r[0]&&r[0]>=0&&r[1]<=1)).toBe(true);expect(ranges.some(r=>r[1]===r[0])).toBe(true);
    const ending=mapSurface(box(1),curve([[.9,.1],[.9,.9]],{closed:false}),{chart:'f1'});
    expect(ending.network.segments.every(s=>s.range[0]>=0&&s.range[1]<=1&&s.range[1]>=s.range[0])).toBe(true);
  });

  it('repeats overlapping islands and selects one chart on request',()=>{
    const cube=box(1),all=mapSurface(cube,stripe(.5)),one=mapSurface(cube,stripe(.5),{chart:'f0'});
    expect(new Set(all.edges.map(e=>e.chart)).size).toBe(6);
    expect(all.edges.length).toBe(12);expect(one.edges.length).toBe(2);
    expect(one.edges.every(e=>e.chart==='f0')).toBe(true);
    expect(()=>mapSurface(cube,stripe(.5),{chart:'missing'})).not.toThrow();
    expect(mapSurface(cube,stripe(.5),{chart:'missing'}).edges.length).toBe(0);
  });

  it('assigns overlap layers when one physical sheet folds onto itself in chart space',()=>{
    // A sheet folded back over itself along x=1: both faces project onto the same square.
    const folded=planarUV(mesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[0,1,1]],[[0,1,2,3],[2,1,4,5]]));
    const marks=mapSurface(folded,curve([[.5,-.5],[.5,1.5]],{closed:false}));
    expect(marks.edges.length).toBe(4);
    const chains=new Set(marks.edges.map(e=>e.chainId));expect(chains.size).toBe(2);
    expect(new Set(marks.edges.map(e=>e.layer))).toEqual(new Set([0,1]));
  });

  it('places sketch-unit material through an explicit frame, never paper percentages',()=>{
    const sheet=plane(2),marks=mapSurface(sheet,curve([[25,-10],[25,110]],{closed:false}),{frame:{width:100}});
    expect(marks.points.map(p=>p.x)).toEqual([-0.5,-0.5,-0.5]);
    expect(()=>mapSurface(sheet,stripe(.5),{frame:{width:0}})).toThrow('frame');
  });

  it('repeats prototype marks at instance placements without realization',()=>{
    const prototype=plane(1),marks=mapSurface(prototype,stripe(.5)),sites=pointCloud([[0,0,0],[3,0,0]]);
    const placed=marks.place(instanceOnPoints(prototype,sites.points));
    expect(placed.sources.length).toBe(2);expect(placed.edges.length).toBe(4);
    expect(new Set(placed.points.map(p=>p.x))).toEqual(new Set([0,3]));
    expect(placed.edges.map(e=>e.instance).filter((v,i,a)=>a.indexOf(v)===i).length).toBe(2);
    expect(view([instanceOnPoints(prototype,sites.points),placed],{camera:orthographic({eye:[5,7,6],span:6})})).toBeTruthy();
  });

  it('enforces budgets and validates inputs',()=>{
    const sheet=plane(2);
    expect(()=>mapSurface(sheet,stripe(.5),{maxCandidates:1})).toThrow('candidate budget');
    expect(()=>mapSurface(sheet,stripe(.5),{maxInputSegments:0})).toThrow('input point/segment budget');
    expect(()=>mapSurface(sheet,stripe(.5),{budget:{maxNodes:1}})).toThrow('node budget');
    expect(()=>mapSurface(sheet,[] as never)).toThrow('resolved numeric materials');
    expect(()=>mapSurface(sheet,stripe(.5),{uv:'missing'})).toThrow();
  });

  it('runs through the async toolkit with stats, and cancels before adoption',async()=>{
    let marks!:ReturnType<typeof mapSurface>;
    const run=await compileSketchAsync(sketchAsync({seed:42,pens:{ink:pen({width:mm(.2)})}},async t=>{
      const sheet=plane(2).subdivide(3);
      marks=await t.mapSurface(sheet,t.times(8,(_,u)=>stripe((u+.5)/8)));
      return view([sheet,marks],{camera:orthographic({eye:[5,7,6],span:4}),stroke:'ink'});
    }));
    expect(run.modeling3[0].operation).toBe('mapSurface');
    expect(run.modeling3[0].mapping?.outputSegments).toBe(marks.edges.length);
    expect(marks.edges.length).toBeGreaterThan(8);
    const controller=new AbortController();
    await expect(compileSketchAsync(sketchAsync({seed:42},async t=>{
      const pending=t.mapSurface(plane(2).subdivide(4),t.times(64,(_,u)=>stripe((u+.5)/64)));setTimeout(()=>controller.abort(),0);await pending;return null;
    }),undefined,{signal:controller.signal})).rejects.toThrow();
  });

  it('draws mapped marks as ordinary strokes, hidden by the rest of the surface',async()=>{
    // A folded sheet: the marks on the far half are behind the near half.
    const sheet=mesh([[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0],[-1,-1,2],[-1,1,2]],[[0,1,2,3],[2,1,4,5]]).cornerAttributes({uv:c=>[c.point.x*.5+.5,c.point.y*.5+.5] as const,chart:c=>c.face.id});
    const marks=mapSurface(sheet,[stripe(.25),stripe(.75)]);
    expect(marks.edges.length).toBe(8);
    const draw=(select:(lines:import('../src/three/api/projected.js').ProjectedLines)=>import('../src/three/api/projected.js').ProjectedCurves)=>compileSketchAsync(sketch({seed:1,pens:{ink:pen({width:mm(.2)})}},()=>view([sheet,marks],{camera:orthographic({eye:[0,0,10],target:[0,0,0],up:[0,1,0],span:4}),stroke:'ink'},lines=>strokes(select(lines),{stroke:'ink'}))));
    const run=await draw(lines=>lines.visible.filter(c=>c.kinds.has('mapped')));
    const classified=[...run.scenes3.values()][0],mapped=classified.features.filter(f=>f.feature.supportedCurve);
    expect(mapped.length).toBe(8);
    // Seen from straight above, the folded-back half (f1) covers the flat half
    // (f0) and hides its marks; f0's own triangles never exempt them.
    const upper=mapped.filter(f=>f.feature.attributes.chart==='f1'),lower=mapped.filter(f=>f.feature.attributes.chart==='f0');
    expect(upper.length).toBe(4);expect(lower.length).toBe(4);
    expect(upper.every(f=>f.hidden.length===0&&f.visible.length===1)).toBe(true);
    expect(lower.every(f=>f.visible.length===0)).toBe(true);
  });
});

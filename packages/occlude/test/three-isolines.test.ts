import {describe,expect,it} from 'vitest';
import {plane,sphere,cylinder,view,orthographic} from '../src/three/api/index.js';
import {isolines} from '../src/three/api/isolines.js';
import {compileSketchAsync,initOcclude,pen,mm,sketchAsync} from '../src/index.js';
import {sampleSurfaceCurves} from '../src/three/api/curveSampling.js';
import {decodePoint,triangleWeights} from '../src/three/geometry/exact.js';
import {bindingTriangle3} from '../src/three/curves/network.js';
import {readFileSync} from 'node:fs';

await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));

type Curves=ReturnType<typeof isolines>;
const total=(c:Curves)=>c.edges.map(e=>e.length).reduce((a,b)=>a+b,0);
function incident(curves:Curves):boolean {
  const n=curves.network;
  return n.segments.every(s=>s.supports.every(sup=>{const tri=bindingTriangle3(n.sources[sup.source].binding,sup.triangle);return [s.a,s.b].every(i=>triangleWeights(tri,decodePoint(n.nodes[i].exact))!==null);}));
}
/** Chains as ordered node sequences, via the degree structure. */
function chains(curves:Curves):{closed:boolean;length:number}[] {
  const groups=new Map<string,typeof curves.network.segments[number][]>();
  for(const s of curves.network.segments){const l=groups.get(s.chainId)??[];l.push(s);groups.set(s.chainId,l);}
  return [...groups.values()].map(list=>{list.sort((a,b)=>a.range[0]-b.range[0]);return {closed:list[0].a===list.at(-1)!.b,length:list.reduce((n,s)=>n+s.length,0)};});
}

describe('isolines',()=>{
  it('contours a numeric point attribute and a callback identically',()=>{
    const sheet=plane(2).subdivide(3).attributes({h:p=>p.x}),levels=[-.3,.1,.55];
    const byName=isolines(sheet,'h',{levels}),byField=isolines(sheet,c=>c.point.x,{levels});
    expect(byName.edges.length).toBe(byField.edges.length);
    for(const [li,level] of levels.entries()){
      const pieces=byName.edges.filter(e=>e.levelIndex===li);
      expect(pieces.every(e=>Math.abs(e.a.x-level)<1e-12&&Math.abs(e.b.x-level)<1e-12&&e.level===level)).toBe(true);
      expect(pieces.map(e=>e.length).reduce((a,b)=>a+b,0)).toBeCloseTo(2,10);
    }
    expect(incident(byName)).toBe(true);
    expect(chains(byName)).toHaveLength(3);
    expect(chains(byName).every(c=>!c.closed)).toBe(true);
  });
  it('closes latitude loops on a sphere near the analytic circumference',()=>{
    const ball=sphere(1,{segments:32,rings:16}),lines=isolines(ball,c=>c.point.z,{levels:[.31,-.62]});
    const rows=chains(lines);expect(rows).toHaveLength(2);expect(rows.every(r=>r.closed)).toBe(true);
    for(const [li,z] of [.31,-.62].entries()){
      const circumference=2*Math.PI*Math.sqrt(1-z*z),measured=lines.edges.filter(e=>e.levelIndex===li).map(e=>e.length).reduce((a,b)=>a+b,0);
      expect(Math.abs(measured-circumference)/circumference).toBeLessThan(.03);
    }
    expect(incident(lines)).toBe(true);
    expect(sampleSurfaceCurves(lines,{count:5}).points.length).toBe(10);
  });
  it('builds a cross-contour from stored coordinates as one closed loop, and keeps seams honest',()=>{
    const tube=cylinder(1,2,{segments:8}),ring=isolines(tube,c=>c.chart==='side'?(c.uv as number[])[1]:-1,{levels:[.5]});
    const rows=chains(ring);expect(rows).toHaveLength(1);expect(rows[0].closed).toBe(true);
    expect(rows[0].length).toBeCloseTo(8*2*Math.sin(Math.PI/8),9);
    const seam=isolines(tube,c=>c.chart==='side'?(c.uv as number[])[0]:-1,{levels:[.0625]});
    // u = 1/16 crosses each side quad's u-edge at interior points, open at top/bottom rims.
    expect(chains(seam).every(c=>!c.closed)).toBe(true);
    expect(total(seam)).toBeCloseTo(2,9);
    // A level in u on the seam quad from either side: nodes are not merged across corners with different values.
    const wrap=isolines(tube,c=>c.chart==='side'?(c.uv as number[])[0]:-1,{levels:[0]});
    expect(wrap.edges.length).toBe(0);
  });
  it('handles a level through vertices with the half-open rule and no zero-length pieces',()=>{
    const sheet=plane(2).subdivide(2).attributes({h:p=>p.x}),lines=isolines(sheet,'h',{levels:[0,.5]});
    expect(lines.network.segments.every(s=>s.length>0)).toBe(true);
    const rows=chains(lines);expect(rows).toHaveLength(2);
    expect(rows.map(r=>r.length).every(l=>Math.abs(l-2)<1e-10)).toBe(true);
    expect(lines.edges.filter(e=>e.index===0).every(e=>e.a.x===0&&e.b.x===0)).toBe(true);
    expect(incident(lines)).toBe(true);
  });
  it('resolves count and spacing level specifications',()=>{
    const sheet=plane(2).subdivide(2).attributes({h:p=>p.x});
    expect(new Set(isolines(sheet,'h',{levels:{count:3}}).edges.map(e=>e.level))).toEqual(new Set([-.5,0,.5]));
    expect(new Set(isolines(sheet,'h',{levels:{spacing:.4,offset:.1}}).edges.map(e=>e.level)).size).toBe(5);
    expect(isolines(sheet,'h',{levels:[]}).edges.length).toBe(0);
    expect(isolines(sheet,'h',{levels:{count:0}}).edges.length).toBe(0);
    expect(isolines(sheet,'h',{levels:{spacing:0}}).edges.length).toBe(0);
    // One unusable level leaves the others alone.
    expect(new Set(isolines(sheet,'h',{levels:[0,Number.NaN,.5]}).edges.map(e=>e.level))).toEqual(new Set([0,.5]));
    expect(()=>isolines(sheet,'missing',{levels:[0]})).toThrow('missing');
  });
  it('enforces budgets and validates inputs',()=>{
    const sheet=plane(2).subdivide(3).attributes({h:p=>p.x});
    // The mesh, the options and the field are read at the call, so a mistake
    // in them is reported there. A capacity is a fact about the network, and
    // the network is built when something asks for it — the same place
    // `intersections` reports its own budgets.
    expect(()=>isolines(sheet,'h',{levels:[.1],maxSegments:1}).network).toThrow('segment budget');
    expect(()=>isolines(sheet,'h',{levels:[.1],maxNodes:1}).network).toThrow('node budget');
    expect(()=>isolines(sheet,'h',{levels:[.1],budget:{maxNodes:1}}).network).toThrow();
    expect(()=>isolines({} as never,'h',{levels:[0]})).toThrow('mesh');
  });
  it('renders through view as ordinary supported curves',async()=>{
    const run=await compileSketchAsync(sketchAsync({seed:1,pens:{ink:pen({width:mm(.2)})}},async()=>{
      const model=plane(2).subdivide(3).displace(p=>[0,0,.4*Math.sin(p.x*2)]).attributes({h:p=>p.z});
      return view([model,isolines(model,'h',{levels:{count:4}})],{camera:orthographic({eye:[5,7,6],span:4}),stroke:'ink'});
    }));
    const scene=[...run.scenes3.values()][0];
    expect(scene.features.some(f=>f.feature.supportedCurve)).toBe(true);
  });
});

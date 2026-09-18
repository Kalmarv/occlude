import {Material} from '../../material.js';
import {Mesh} from './mesh.js';
import {SurfaceCurves,type SurfaceCurveOptions} from './supported.js';
import {identity} from './identity.js';
import {chartIndexJob3} from '../curves/chartIndex.js';
import {clipChartSegment3,mapChartClip3,type UV2} from '../curves/chartClip.js';
import {surfaceBinding3,bindingTriangle3,surfaceCurveNetworkJob3,type SurfaceCurveNetworkInput3,type SurfaceCurveBudget3} from '../curves/network.js';
import {worldBounds3} from '../geometry/bounds.js';
import {gcd,ratioNumber,type Ratio,type H,type V} from '../geometry/exact.js';
import {runGeometryJob3} from '../geometry/job.js';
import type {Attributes3} from '../geometry/surface.js';

/** Where pattern coordinates lie in the chart. The default is the unit square:
 * numeric materials are already chart coordinates. A sketch-unit material from
 * `t.material`/`t.sample` names the rectangle of its coordinates that should
 * cover the chart; nothing is ever interpreted as a percentage of paper. */
export interface ChartFrame {readonly x?:number;readonly y?:number;readonly width:number;readonly height?:number}
export interface SurfaceMappingOptions extends SurfaceCurveOptions {
  readonly uv?:string;
  readonly chartAttribute?:string;
  /** Omit to map every chart, including overlapping islands. */
  readonly chart?:string|number;
  readonly frame?:ChartFrame;
  readonly maxInputPoints?:number;
  readonly maxInputSegments?:number;
  readonly maxTriangles?:number;
  readonly maxCandidates?:number;
  readonly budget?:SurfaceCurveBudget3;
}
/** Every mapped segment names its chart and physical sheet; a pattern column
 * on the source material rides along as a numeric edge attribute. */
export type MappedAttributes={chart:string|number;component:number;pattern:number;layer:number};
export interface SurfaceMappingStats {
  readonly candidates:number;readonly pointContacts:number;readonly overlapLayers:number;
  readonly duplicateSupports:number;readonly outputNodes:number;readonly outputSegments:number;
  readonly inputSegments:number;readonly exactBytes:number;
}
function limit(value:number|undefined,fallback:number,name:string):number {
  const n=value??fallback;if(!(n===Infinity||Number.isSafeInteger(n))||n<0)throw new Error(`surface mapping ${name} budget must be a nonnegative integer or Infinity`);return n;
}
/** A frame with no extent maps nothing: the patterns are dropped rather than
 * divided by zero, and the sketch keeps its other drawings. */
function checkFrame(frame:ChartFrame|undefined):Required<ChartFrame>|undefined {
  const value={x:frame?.x??0,y:frame?.y??0,width:frame?.width??1,height:frame?.height??frame?.width??1};
  return Object.values(value).every(Number.isFinite)&&value.width>0&&value.height>0?value:undefined;
}
/** Capture mutable material columns before any asynchronous task boundary. */
export function captureSurfaceMapping(mesh:Mesh<any,any,any,any>,pattern:Material|readonly Material[],options:SurfaceMappingOptions={}) {
  if(!(mesh instanceof Mesh))throw new Error('mapSurface requires a mesh');
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('surface mapping options must be an object');
  const settings=structuredClone(options),patterns=pattern instanceof Material?[pattern]:pattern;
  if(!Array.isArray(patterns)||!patterns.length||patterns.some(p=>!(p instanceof Material)))throw new Error('mapSurface requires resolved numeric materials; use t.material or t.sample for frame-dependent shapes');
  const maxPoints=limit(settings.maxInputPoints,Infinity,'input points'),maxSegments=limit(settings.maxInputSegments,Infinity,'input segments');
  if(mesh.surface.triangles.length>limit(settings.maxTriangles,Infinity,'triangles'))throw new Error('surface mapping exceeds triangle budget');
  limit(settings.maxCandidates,Infinity,'candidate');
  for(const name of [settings.uv??'uv',settings.chartAttribute??'chart'])if(typeof name!=='string'||!name)throw new Error('surface mapping coordinate columns must be nonempty strings');
  if(settings.chart!==undefined&&!(typeof settings.chart==='string'||typeof settings.chart==='number'&&Number.isFinite(settings.chart)))throw new Error('surface mapping chart must be a string or finite number');
  const frame=checkFrame(settings.frame);
  let points=0,segments=0;
  for(const material of patterns){points+=material.n;segments+=material.edgeCount;if(points>maxPoints||segments>maxSegments)throw new Error('surface mapping exceeds input point/segment budget');}
  // A pattern whose coordinates the frame cannot represent is left out; the
  // other patterns still map.
  const captured=frame===undefined?[]:patterns.flatMap(p=>{
    if(!p.x.every(Number.isFinite)||!p.y.every(Number.isFinite))return [];
    const columns=(input:Readonly<Record<string,Float64Array>>)=>Object.fromEntries(Object.entries(input).map(([name,value])=>[name,value.slice()]));
    const x=Float64Array.from(p.x as Iterable<number>,v=>(v-frame.x)/frame.width),y=Float64Array.from(p.y as Iterable<number>,v=>(v-frame.y)/frame.height);
    if(!x.every(Number.isFinite)||!y.every(Number.isFinite))return [];
    return [new Material(x,y,columns(p.attrs),p.edgeList.slice(),0,[],columns(p.edgeAttrs),{...p.transfers},{...p.edgeTransfers})];
  });
  return {mesh,patterns:captured,settings};
}
function parameter(edge:number,count:number,t:Ratio):Ratio {
  const n=BigInt(edge)*t[1]+t[0],d=BigInt(count)*t[1],g=gcd(n,d);return [n/g,d/g];
}
const sameRatio=(a:Ratio,b:Ratio)=>a[0]*b[1]===b[0]*a[1];
/** Generator orchestration keeps exact construction and graph adoption atomic. */
export function* surfaceMappingJob(captured:ReturnType<typeof captureSurfaceMapping>,onProgress?:(event:{operation:'mapSurface';done:number;total?:number})=>void) {
  const {mesh,patterns,settings}=captured,surface=mesh.surface,binding=surfaceBinding3(surface);
  const charts=yield*chartIndexJob3(surface,settings.uv,settings.chartAttribute,settings.chart);
  const budget=settings.budget??{},maxNodes=limit(budget.maxNodes,Infinity,'node'),maxSegments=limit(budget.maxSegments,Infinity,'segment'),maxSupports=limit(budget.maxSupports,Infinity,'support'),maxBytes=limit(budget.maxExactBytes,Infinity,'exact byte'),maxBits=limit(budget.maxCoordinateBits,32768,'coordinate bit'),maxCandidates=settings.maxCandidates??Infinity;
  const nodes:SurfaceCurveNetworkInput3['nodes'][number][]=[],segments:SurfaceCurveNetworkInput3['segments'][number][]=[];
  const nodeIds=new Map<string,string>(),segmentIds=new Map<string,number>();
  const stats={candidates:0,pointContacts:0,overlapLayers:0,duplicateSupports:0,outputNodes:0,outputSegments:0,inputSegments:0,exactBytes:0};
  // Same-component UV overlap maps a chain onto several sheets of one physical
  // component. Each gets its own layer chain so ranges never collide.
  const layers=new Map<string,{ranges:[Ratio,Ratio][]}[]>();
  let supports=0;
  function node(chain:string,component:number,triangle:number,weights:V,p:H,t:Ratio,closed:boolean,attributes:Attributes3):string {
    // Actual attachment simplex distinguishes coincident unrelated triangles;
    // a shared position never merges unrelated chains or layers.
    const simplex=surface.triangles[triangle].vertices.filter((_,i)=>weights[i]!==0n).sort((a,b)=>a-b);
    const seam=closed&&(t[0]===0n||t[0]===t[1]),key=JSON.stringify([chain,component,simplex,p.map(String),seam?'seam':t.map(String)]);
    const previous=nodeIds.get(key);if(previous)return previous;
    if(nodes.length>=maxNodes)throw new Error('surface mapping exceeds node budget');
    for(const n of p){if(n.toString(2).length>maxBits)throw new Error('surface mapping exceeds coordinate bit budget');stats.exactBytes+=n.toString().length*2;}
    if(stats.exactBytes>maxBytes)throw new Error('surface mapping exceeds exact byte budget');
    const id=identity('mapped-node',key);nodeIds.set(key,id);nodes.push({id,point:p,attributes});return id;
  }
  function layer(chain:string,range:readonly [Ratio,Ratio],na:string,nb:string):{id:string;index:number}|null {
    const rows=layers.get(chain)??[];if(!layers.has(chain))layers.set(chain,rows);
    for(let i=0;i<rows.length;i++){
      const collides=rows[i].ranges.some(([lo,hi])=>!(range[1][0]*lo[1]<=lo[0]*range[1][1]||hi[0]*range[0][1]<=range[0][0]*hi[1]));
      if(!collides){rows[i].ranges.push([range[0],range[1]]);return {id:i?identity('mapped-layer',chain,i):chain,index:i};}
      // The identical interval on identical nodes is a boundary duplicate.
      const same=rows[i].ranges.some(([lo,hi])=>sameRatio(lo,range[0])&&sameRatio(hi,range[1]));
      if(same&&segmentIds.has(JSON.stringify([i?identity('mapped-layer',chain,i):chain,na,nb,range[0].map(String),range[1].map(String)])))return {id:i?identity('mapped-layer',chain,i):chain,index:i};
    }
    rows.push({ranges:[[range[0],range[1]]]});stats.overlapLayers+=rows.length>1?1:0;
    const i=rows.length-1;return {id:i?identity('mapped-layer',chain,i):chain,index:i};
  }
  const totalInput=patterns.reduce((n,p)=>n+p.edgeCount,0);
  for(let pi=0;pi<patterns.length;pi++){
    const material=patterns[pi],edgeRows=new Map<string,number>();
    for(let e=0;e<material.edgeCount;e++){
      const a=material.edgeList[e*2],b=material.edgeList[e*2+1];edgeRows.set(`${a}:${b}`,e);if(!edgeRows.has(`${b}:${a}`))edgeRows.set(`${b}:${a}`,e);
      if((e&127)===127)yield;
    }
    const chains=material.curves();yield;
    const pointColumns=Object.entries(material.attrs);
    for(let ci=0;ci<chains.length;ci++){
      const path=chains[ci],count=path.indices.length-(path.closed?0:1),chain=identity('mapped-chain',settings.key??mesh.key??'default',pi,ci);
      for(let e=0;e<count;e++){
        const ia=path.indices[e],ib=path.indices[(e+1)%path.indices.length],a:UV2=[material.x[ia],material.y[ia]],b:UV2=[material.x[ib],material.y[ib]];
        stats.inputSegments++;
        if((stats.inputSegments&63)===0)onProgress?.({operation:'mapSurface',done:stats.inputSegments,total:totalInput});
        if(a[0]===b[0]&&a[1]===b[1])continue;
        const row=edgeRows.get(`${ia}:${ib}`)!;
        const edgeAttributes:Attributes3=Object.fromEntries(Object.entries(material.edgeAttrs).map(([name,values])=>[name,values[row]]));
        const bounds=worldBounds3([[a[0],a[1],0],[b[0],b[1],0]]);
        for(const index of charts.index.query(bounds)){
          if(++stats.candidates>maxCandidates)throw new Error('surface mapping exceeds candidate budget');
          const chart=charts.rows[index],clip=clipChartSegment3(chart.uv,a,b);
          if(clip?.kind==='point')stats.pointContacts++;
          if(clip?.kind==='segment'){
            const [first,last]=mapChartClip3(clip,bindingTriangle3(binding,chart.triangle));
            const t0=parameter(e,count,clip.range[0]),t1=parameter(e,count,clip.range[1]);
            const range=[ratioNumber(t0),ratioNumber(t1)] as const;
            const attributesAt=(t:Ratio)=>{const s=ratioNumber(t);return Object.fromEntries(pointColumns.map(([name,values])=>[name,values[ia]*(1-s)+values[ib]*s]));};
            const componentChain=identity('mapped-component-chain',chain,chart.component);
            const na=node(chain,chart.component,chart.triangle,clip.weightsA,first,t0,path.closed,attributesAt(clip.range[0]));
            const nb=node(chain,chart.component,chart.triangle,clip.weightsB,last,t1,path.closed,attributesAt(clip.range[1]));
            const sheet=layer(componentChain,[t0,t1],na,nb);if(!sheet)continue;
            const key=JSON.stringify([sheet.id,na,nb,t0.map(String),t1.map(String)]),old=segmentIds.get(key),support={source:0,triangle:chart.triangle};
            supports+=3;if(supports>maxSupports)throw new Error('surface mapping exceeds support budget');
            if(old!==undefined){const previous=segments[old];if(!previous.supports.some(s=>s.triangle===chart.triangle))segments[old]={...previous,supports:[...previous.supports,support]};stats.duplicateSupports++;}
            else {
              if(segments.length>=maxSegments)throw new Error('surface mapping exceeds segment budget');
              segmentIds.set(key,segments.length);
              segments.push({id:identity('mapped-segment',key),kind:'mapped',a:na,b:nb,chainId:sheet.id,range,supports:[support],attributes:{...edgeAttributes,chart:chart.chart,component:chart.component,pattern:pi,layer:sheet.index}});
            }
          }
          if((stats.candidates&127)===0)yield;
        }
        yield;
      }
    }
  }
  const network=yield*surfaceCurveNetworkJob3({sources:[{id:'surface',binding}],nodes,segments},budget);
  stats.outputNodes=network.nodes.length;stats.outputSegments=network.segments.length;
  return {curves:new SurfaceCurves<MappedAttributes>(network,{key:settings.key,stroke:settings.stroke}),stats:Object.freeze(stats) as SurfaceMappingStats};
}
/** Map resolved 2D material through stored chart coordinates onto supported
 * surface curves. Straight pattern segments map exactly; a curved motif is
 * represented by the polyline you supply (its flattening contract is the 2D
 * conversion's own count/spacing/tolerance). Use `await t.mapSurface(...)` in
 * `sketchAsync` for substantial cancellable workloads. */
export function mapSurface(mesh:Mesh<any,any,any,any>,pattern:Material|readonly Material[],options:SurfaceMappingOptions={}):SurfaceCurves<MappedAttributes> {
  return runGeometryJob3(surfaceMappingJob(captureSurfaceMapping(mesh,pattern,options))).value.curves;
}

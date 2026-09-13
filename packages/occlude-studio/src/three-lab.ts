import {SurfaceQueries3} from 'occlude/src/three/queries/surface.js';
import {GpuSurfaceQueries3} from 'occlude/src/compute/webgpu/queries.js';
import {surface3} from 'occlude/src/three/geometry/surface.js';
import {Rng} from 'occlude/src/random.js';
import {grid3,FaceSelection3,extrudeFaces3} from 'occlude/src/three/geometry/model.js';
import {deformSurfaceCpu3} from 'occlude/src/three/geometry/deform.js';
import {GpuDeform3} from 'occlude/src/compute/webgpu/deform.js';
import type {Surface3} from 'occlude/src/three/geometry/surface.js';
import { constructStrokes3 } from 'occlude/src/three/strokes/construct.js';
import { paperStrokes3 } from 'occlude/src/three/strokes/paper.js';
import { box3 } from 'occlude/src/three/geometry/surface.js';
import { featureSnapshot3, FeatureKind3 } from 'occlude/src/three/features/snapshot.js';
import { classifySceneCpu3, classifySceneGpu3, type ClassifiedScene3 } from 'occlude/src/three/visibility/scene.js';
import type { CameraFrame3 } from 'occlude/src/three/camera.js';
import { exportSvg, initOcclude, line, mm, paper, pen, sketch } from 'occlude';
import { cameraFrame3, toPaper3 } from 'occlude/src/three/camera.js';
import { lerp3, type Triangle3, type Vec3 } from 'occlude/src/three/math.js';
import { hiddenInterval3, occlusionVolume3, visibleIntervals3, type Interval3 } from 'occlude/src/three/visibility/interval.js';
import { GpuIntervals3 } from 'occlude/src/compute/webgpu/interval.js';
import { ThreeWorkerClient } from './three/client.js';
import './three-lab.css';

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const evidence = document.querySelector<HTMLPreElement>('#evidence')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const download = document.querySelector<HTMLButtonElement>('#download')!;
const scene = document.querySelector<HTMLSelectElement>('#scene')!;
const orbit = document.querySelector<HTMLInputElement>('#orbit')!;
const featureFilter = document.querySelector<HTMLSelectElement>('#features')!;
const projection = document.querySelector<HTMLSelectElement>('#projection')!;
let canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
// This dedicated laboratory exposes its kernels for browser conformance checks
// against the exact production bundle (no Vite /@fs imports required).
Object.assign(window, { threeLabApi: { createBenchmarkWorker: () => new Worker(new URL('./three/benchmark.ts', import.meta.url), { type: 'module' }), GpuIntervals3, SurfaceQueries3, GpuSurfaceQueries3, surface3, GpuDeform3, grid3, FaceSelection3, extrudeFaces3, deformSurfaceCpu3, hiddenInterval3, occlusionVolume3, ThreeWorkerClient, cameraFrame3, box3, featureSnapshot3, classifySceneCpu3, classifySceneGpu3, constructStrokes3, paperStrokes3 } });

let client: ThreeWorkerClient | null = null, svg = '', revision = 0;

const firstBox = box3([2,2,2]); firstBox.edges[0].attributes.marked = true;
const secondBox = box3([2,1,2],[1,.4,.5]);
const objects = [{id:'box',surface:firstBox,attributes:{group:'primary'}}];
let meshCache: { drawing: ClassifiedScene3; frame: CameraFrame3; metadata: Record<string, unknown> } | null = null;
let adoptedMeshDispatches = 0;
let relief:Surface3|null=null,reliefPending:Promise<Surface3>|null=null,modelBuilds=0,modelStats:unknown=null,queryStats:unknown=null,queryEdits=0;
async function reliefModel():Promise<Surface3> {
  if(relief)return relief;
  if(!reliefPending)reliefPending=(async()=>{
    const grid=grid3(8,8,[4,4]);
    grid.faces.forEach(f=>{f.attributes.importance=new Rng(`relief:42:${f.id}`).float();});
    const selection=new FaceSelection3(grid).filter(f=>f.index%8%2===0&&Math.floor(f.index/8)%2===0);
    const raised=extrudeFaces3(grid,selection,f=>.3+.9*Math.abs(Number(f.attributes.importance)),{operation:'relief:42'});
    const pinned=raised.points.flatMap((p,i)=>Math.abs(p.position[0])===2||Math.abs(p.position[1])===2?[i]:[]);
    const displacements=raised.points.map(p=>[0,0,.002*Math.sin(p.position[0]*3+p.position[1]*2)] as Vec3);
    const result=await client!.deform({surface:raised,deformation:{iterations:24,relaxation:.025,displacements,pinned},geometryRevision:3,cameraRevision:0});
    const modeled=result.deformation.surface;
    const selectedPoints=modeled.points.flatMap((p,i)=>p.attributes.parentPoint?[i]:[]);
    const ceiling=surface3([[-3,-3,.55],[3,-3,1.15],[3,3,1.15],[-3,3,.55]],[[0,1,2,3]]);
    const queried=await client!.query({querySurface:ceiling,rayQueries:[],nearestQueries:selectedPoints.map(i=>({point:modeled.points[i].position})),geometryRevision:3,cameraRevision:0});
    queried.queries.nearest.hits.forEach((hit,j)=>{const p=modeled.points[selectedPoints[j]];if(hit&&p.position[2]>hit.point[2]){p.position=hit.point;p.attributes.constraintDistance=hit.distance;queryEdits++;}});
    queryStats=queried.queries.nearest.stats;
    modelBuilds++;modelStats=result.deformation.stats;relief=modeled;return relief;
  })().finally(()=>{reliefPending=null;});
  return reliefPending;
}


function styleMesh(reused: boolean): void {
  if (!meshCache) return;
  const { drawing, frame, metadata } = meshCache;
  const selected = drawing.features.filter(({feature:f}) => featureFilter.value === 'silhouette' ? !!(f.flags & FeatureKind3.silhouette) : featureFilter.value === 'marked' ? !!(f.flags & FeatureKind3.marked) : !!(f.flags & (FeatureKind3.boundary|FeatureKind3.silhouette|FeatureKind3.marked|FeatureKind3.wire)) || f.creaseAngle >= 30);
  const selectedIds=new Set(selected.map(f=>f.feature.id));
  const constructed=constructStrokes3(drawing,[{id:'outline',stroke:'outline',select:f=>selectedIds.has(f.id)}]);
  const marks = [...paperStrokes3(constructed),...selected.flatMap(({feature,hidden}) => {
    const a=toPaper3(frame,feature.a),b=toPaper3(frame,feature.b),length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const dashes: ReturnType<typeof line>[]=[];
    if (length>0) for(const range of hidden) {
      const start=toPaper3(frame,lerp3(feature.a,feature.b,range[0]));
      const end=toPaper3(frame,lerp3(feature.a,feature.b,range[1]));
      const lo=Math.hypot(start[0]-a[0],start[1]-a[1]),hi=Math.hypot(end[0]-a[0],end[1]-a[1]);
      for(let distance=Math.floor(lo/4)*4;distance<hi;distance+=4) {
        const from=Math.max(lo,distance)/length,to=Math.min(hi,distance+2)/length;
        if(from<to)dashes.push(line(mm(a[0]+(b[0]-a[0])*from),mm(a[1]+(b[1]-a[1])*from),mm(a[0]+(b[0]-a[0])*to),mm(a[1]+(b[1]-a[1])*to),{stroke:'hidden',preserveStroke:true}));
      }
    }
    return dashes;
  })];
  svg=exportSvg(sketch({paper:paper({width:mm(150),height:mm(100)}),margin:0,seed:42,pens:{outline:pen({width:mm(.3),color:'#14283a'}),hidden:pen({width:mm(.2),color:'#9c6b79'})}},()=>marks));
  document.querySelector('#vectors')!.innerHTML=svg; download.disabled=false;
  const report={...metadata,features:drawing.features.length,constructedStrokes:constructed.length,selected:selected.length,visibleRuns:selected.reduce((n,f)=>n+f.visible.length,0),hiddenRuns:selected.reduce((n,f)=>n+f.hidden.length,0),stats:drawing.stats,visibilityReused:reused,adoptedMeshDispatches,svgPaths:(svg.match(/<path\b/g)??[]).length};
  evidence.textContent=JSON.stringify(report,null,2);Object.assign(window,{threeEvidence:report});
  status.textContent=`${selected.length} selected features · ${drawing.stats.candidates} candidate pairs · ${reused?'cached visibility reused':`${drawing.stats.dispatches} GPU dispatches`}`;
}
async function runMesh(): Promise<void> {
  const currentRevision=++revision, sceneName=scene.value, projectionName=projection.value;
  status.textContent='Classifying mesh visibility…';
  try {
    client ??= new ThreeWorkerClient(canvas); await initOcclude(); if(currentRevision!==revision)return;
    const angle=Number(orbit.value)*Math.PI/180;
    const frame=cameraFrame3({...(projectionName==='perspective'?{kind:'perspective' as const,fovDegrees:45}:{kind:'orthographic' as const,span:6}),eye:[7*Math.cos(angle),7*Math.sin(angle),5],target:[0,0,0],near:.1,far:100},{x:0,y:0,width:150,height:100});
    const sceneObjects=sceneName==='relief'?[{id:'relief',surface:await reliefModel()}]:sceneName==='box'?objects:[...objects,{id:'crossing',surface:secondBox}];
    if(currentRevision!==revision)return;
    const wires=sceneName!=='overlap'?[]:[{id:'wire',points:[[-3,0,.2],[3,0,.2]] as Vec3[]}];
    const result=await client.renderScene({frame,objects:sceneObjects,wires,geometryRevision:sceneName==='relief'?3:sceneName==='box'?1:2,cameraRevision:currentRevision});
    if(currentRevision!==revision)return;
    adoptedMeshDispatches+=result.drawing.stats.dispatches;
    meshCache={drawing:result.drawing,frame,metadata:{passed:true,scene:sceneName,modelBuilds,modelStats,queryStats,queryEdits,projection:projectionName,worker:result.worker,adapter:result.adapter,cameraRevision:currentRevision,deviceGeneration:result.deviceGeneration}};
    styleMesh(false);
  } catch(error) { if(currentRevision!==revision || (error instanceof Error && error.name==='AbortError'))return;status.textContent=String(error);console.error(error); }
}
async function run(): Promise<void> {
  if (scene.value !== 'triangle') return runMesh();
  const currentRevision = ++revision, projectionName = projection.value;
  const current = () => currentRevision === revision;
  // The previous committed SVG stays exportable while a new view is pending.
  status.textContent = 'Computing geometric intervals…';
  try {
    const started = performance.now();
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. Open this page in a supported browser over HTTPS or localhost.');
    client ??= new ThreeWorkerClient(canvas);
    await initOcclude();
    if (!current()) return;
    const perspective = projectionName === 'perspective';
    const frame = cameraFrame3({ ...(perspective ? { kind: 'perspective' as const, fovDegrees: 90 } : { kind: 'orthographic' as const, span: 4 }), eye: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], near: 0.1, far: 20 }, { x: 0, y: 0, width: 150, height: 100 });
    const triangle: Triangle3 = [[-1, -1, -2], [1, -1, -2], [0, 1, -2]];
    const a: Vec3 = [-2, 0, -4], b: Vec3 = [2, 0, -4];
    const volume = occlusionVolume3(triangle, perspective)!;
    const cpuStart = performance.now();
    const reference = hiddenInterval3(a, b, volume)!;
    const cpuMs = performance.now() - cpuStart;
    const rendered = await client.render({ frame, triangles: [triangle], wires: [[a, b]], pairs: [{ a, b, volume }], geometryRevision: 1, cameraRevision: currentRevision });
    if (!current()) return;
    const { gpu, cold, deviceReadyMs } = rendered;
    const hidden = gpu.intervals[0];
    const expected = perspective ? [0.25, 0.75] : [0.375, 0.625];
    if (!hidden || hidden.some((v, i) => Math.abs(v - expected[i]) > 1e-5)) throw new Error(`GPU interval failed analytic fixture: ${JSON.stringify(hidden)}`);
    const visible = visibleIntervals3([hidden]);
    // Two downstream selections/styles share the one classified result. Physical
    // dash gaps are materialized; the MVP stroke graph replaces this tiny recipe.
    const segment = (range: Interval3, yOffset: number, name: string) => {
      const p = toPaper3(frame, lerp3(a, b, range[0])), q = toPaper3(frame, lerp3(a, b, range[1]));
      return line(mm(p[0]), mm(p[1] + yOffset), mm(q[0]), mm(q[1] + yOffset), { stroke: name, bridge: mm(0) });
    };
    const dashes: Interval3[] = [];
    const projectedLength = Math.abs(toPaper3(frame, b)[0] - toPaper3(frame, a)[0]);
    for (let distance = 0; distance < projectedLength; distance += 4) {
      const lo = Math.max(hidden[0], distance / projectedLength), hi = Math.min(hidden[1], (distance + 2) / projectedLength);
      if (lo < hi) dashes.push([lo, hi]);
    }
    const def = sketch({ paper: paper({ width: mm(150), height: mm(140) }), margin: 0, seed: 42, pens: { outline: pen({ width: mm(0.35), color: '#14283a' }), hidden: pen({ width: mm(0.25), color: '#8b5160' }) } }, () => [
      ...visible.map(range => segment(range, -20, 'outline')),
      ...visible.map(range => segment(range, 40, 'outline')),
      ...dashes.map(range => segment(range, 40, 'hidden')),
    ]);
    svg = exportSvg(def);
    document.querySelector('#vectors')!.innerHTML = svg;
    const info = rendered.adapter;
    const report = { passed: true, cold, deviceReadyMs, totalMs: performance.now() - started, projection: projectionName, worker: rendered.worker, deviceGeneration: rendered.deviceGeneration, cameraRevision: rendered.cameraRevision, adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter }, reference, expected, gpu, cpuMs, styleSelections: 2, svgPaths: (svg.match(/<path\b/g) ?? []).length, userAgent: navigator.userAgent };
    evidence.textContent = JSON.stringify(report, null, 2);
    (window as unknown as { threeEvidence: unknown }).threeEvidence = report;
    status.textContent = `Analytic fixture passed · ${gpu.dispatches} GPU dispatch · ${gpu.refinements} CPU refinements · ${info.isFallbackAdapter ? 'fallback adapter' : 'adapter reports hardware'}`;
    download.disabled = false;
  } catch (error) {
    if (!current() || (error instanceof Error && error.name === 'AbortError')) return;
    status.textContent = String(error); evidence.textContent = String(error); console.error(error);
  }
}
runButton.addEventListener('click', () => void run());
scene.addEventListener('change', () => void run());
orbit.addEventListener('change', () => { if(scene.value!=='triangle')void run(); });
featureFilter.addEventListener('change',()=>{if(scene.value!=='triangle')styleMesh(true);});
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a'); a.href = url; a.download = 'occlude-3d-visibility.svg'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.querySelector('#cancel')!.addEventListener('click', () => {
  revision++; client?.cancel(); status.textContent = 'Render cancelled · previous committed vectors retained';
});
document.querySelector('#restart')!.addEventListener('click', () => {
  revision++; const previous = client; client = null; void previous?.dispose();
  const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
  canvas.replaceWith(replacement); canvas = replacement;
  void run();
});
window.addEventListener('pagehide', () => { revision++; void client?.dispose(); });
void run();

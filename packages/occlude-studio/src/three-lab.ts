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
const projection = document.querySelector<HTMLSelectElement>('#projection')!;
let canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
// This dedicated laboratory exposes its kernels for browser conformance checks
// against the exact production bundle (no Vite /@fs imports required).
Object.assign(window, { threeLabApi: { GpuIntervals3, hiddenInterval3, occlusionVolume3, ThreeWorkerClient, cameraFrame3 } });

let client: ThreeWorkerClient | null = null, svg = '', revision = 0;

async function run(): Promise<void> {
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

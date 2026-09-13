import { exportSvg, initOcclude, line, mm, paper, pen, sketch } from 'occlude';
import { cameraFrame3, toPaper3 } from 'occlude/src/three/camera.js';
import { lerp3, type Triangle3, type Vec3 } from 'occlude/src/three/math.js';
import { hiddenInterval3, occlusionVolume3, visibleIntervals3, type Interval3 } from 'occlude/src/three/visibility/interval.js';
import { GpuIntervals3 } from 'occlude/src/compute/webgpu/interval.js';
import { GpuViewport3 } from 'occlude/src/compute/webgpu/viewport.js';
import './three-lab.css';

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const evidence = document.querySelector<HTMLPreElement>('#evidence')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const download = document.querySelector<HTMLButtonElement>('#download')!;
const projection = document.querySelector<HTMLSelectElement>('#projection')!;
const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
// This dedicated laboratory exposes its kernels for browser conformance checks
// against the exact production bundle (no Vite /@fs imports required).
Object.assign(window, { threeLabApi: { GpuIntervals3, hiddenInterval3, occlusionVolume3 } });

let session: GpuIntervals3 | null = null, viewport: GpuViewport3 | null = null, svg = '';

async function run(): Promise<void> {
  runButton.disabled = true; download.disabled = true;
  status.textContent = 'Computing geometric intervals…';
  try {
    const started = performance.now(), cold = session === null;
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. Open this page in a supported browser over HTTPS or localhost.');
    session ??= await GpuIntervals3.create(navigator.gpu);
    viewport ??= new GpuViewport3(session.device, canvas, navigator.gpu.getPreferredCanvasFormat());
    const deviceReadyMs = performance.now() - started;
    await initOcclude();
    const perspective = projection.value === 'perspective';
    const frame = cameraFrame3({ ...(perspective ? { kind: 'perspective' as const, fovDegrees: 90 } : { kind: 'orthographic' as const, span: 4 }), eye: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], near: 0.1, far: 20 }, { x: 0, y: 0, width: 150, height: 100 });
    const triangle: Triangle3 = [[-1, -1, -2], [1, -1, -2], [0, 1, -2]];
    const a: Vec3 = [-2, 0, -4], b: Vec3 = [2, 0, -4];
    const volume = occlusionVolume3(triangle, perspective)!;
    const cpuStart = performance.now();
    const reference = hiddenInterval3(a, b, volume)!;
    const cpuMs = performance.now() - cpuStart;
    const gpu = await session.classify([{ a, b, volume }]);
    const hidden = gpu.intervals[0];
    const expected = perspective ? [0.25, 0.75] : [0.375, 0.625];
    if (!hidden || hidden.some((v, i) => Math.abs(v - expected[i]) > 1e-5)) throw new Error(`GPU interval failed analytic fixture: ${JSON.stringify(hidden)}`);
    const visible = visibleIntervals3([hidden]);
    viewport.draw(frame, [triangle], [[a, b]]);
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
    const info = session.adapterInfo;
    const report = { passed: true, cold, deviceReadyMs, totalMs: performance.now() - started, projection: projection.value, adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter }, reference, expected, gpu, cpuMs, styleSelections: 2, svgPaths: (svg.match(/<path\b/g) ?? []).length, userAgent: navigator.userAgent };
    evidence.textContent = JSON.stringify(report, null, 2);
    (window as unknown as { threeEvidence: unknown }).threeEvidence = report;
    status.textContent = `Analytic fixture passed · ${gpu.dispatches} GPU dispatch · ${gpu.refinements} CPU refinements · ${info.isFallbackAdapter ? 'fallback adapter' : 'adapter reports hardware'}`;
    download.disabled = false;
  } catch (error) { status.textContent = String(error); evidence.textContent = String(error); console.error(error); }
  finally { runButton.disabled = false; }
}
runButton.addEventListener('click', () => void run());
download.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a'); a.href = url; a.download = 'occlude-3d-visibility.svg'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => { viewport?.dispose(); void session?.dispose(); });
void run();

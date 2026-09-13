import { GpuDeform3 } from 'occlude/src/compute/webgpu/deform.js';
import { featureSnapshot3 } from 'occlude/src/three/features/snapshot.js';
import { classifySceneGpu3 } from 'occlude/src/three/visibility/scene.js';
import { GpuIntervals3 } from 'occlude/src/compute/webgpu/interval.js';
import { GpuViewport3 } from 'occlude/src/compute/webgpu/viewport.js';
import { ThreeJobQueue } from './jobs.js';
import type { ThreeJobInput, ThreeJobResult, ThreeWorkerRequest, ThreeWorkerResponse } from './protocol.js';

/** The dedicated construction worker owns both viewport and compute device.
 * Paper output consumes owned CPU intervals on the host after final adoption. */
class ThreeWorkerHost {
  private session: GpuIntervals3 | null = null;
  private viewport: GpuViewport3 | null = null;
  private generation = 0;
  private deformation:GpuDeform3|null=null;
  constructor(private canvas: OffscreenCanvas, private requireHardware: boolean) {}
  async render(input: ThreeJobInput, signal: AbortSignal): Promise<ThreeJobResult> {
    signal.throwIfAborted();
    const started = performance.now();
    const cold = this.session === null || !this.session.available;
    if (cold) {
      await this.release(); signal.throwIfAborted();
      if (!navigator.gpu) throw new Error('WebGPU unavailable in this worker; use HTTPS or localhost and a supported browser');
      this.session = await GpuIntervals3.create(navigator.gpu, { requireHardware: this.requireHardware });
      this.generation++;
      // A submitted job can be abandoned during adapter/pipeline creation.
      signal.throwIfAborted();
      this.viewport = new GpuViewport3(this.session.device, this.canvas, navigator.gpu.getPreferredCanvasFormat());
    }
    signal.throwIfAborted();
    // A cancelled initialization retains a valid device but has not yet made its viewport.
    this.viewport ??= new GpuViewport3(this.session!.device, this.canvas, navigator.gpu.getPreferredCanvasFormat());
    const session = this.session!, info = session.adapterInfo;
    const deviceReadyMs = performance.now() - started;
    const metadata = { adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter }, geometryRevision: input.geometryRevision, cameraRevision: input.cameraRevision, deviceGeneration: this.generation, deviceReadyMs, cold, worker: true as const };
    if ('deformation' in input) {
      this.deformation ??= await GpuDeform3.create(session.device);
      const deformation=await this.deformation.deform(input.surface,{...input.deformation,signal});
      signal.throwIfAborted();return {...metadata,deformation};
    }
    if ('objects' in input) {
      const snapshot = featureSnapshot3(input.objects, input.wires, input.frame);
      signal.throwIfAborted();
      this.viewport.draw(input.frame, snapshot.triangles, snapshot.features.map(f=>[f.a,f.b] as const));
      const drawing = await classifySceneGpu3(snapshot, session, { signal });
      signal.throwIfAborted();
      return { ...metadata, drawing };
    }
    this.viewport.draw(input.frame, input.triangles, input.wires);
    const gpu = await session.classify(input.pairs, { signal, parameterTolerance: input.parameterTolerance });
    signal.throwIfAborted();
    return { ...metadata, gpu };
  }
  async release(): Promise<void> {
    this.deformation=null;
    this.viewport?.dispose(); this.viewport = null;
    const session = this.session; this.session = null;
    await session?.dispose();
  }
}

const send = (message: ThreeWorkerResponse) => postMessage(message);
let host: ThreeWorkerHost | null = null;
const jobs = new ThreeJobQueue(
  (input, signal) => {
    if (!host) throw new Error('3D worker must receive its viewport before rendering');
    return host.render(input, signal);
  },
  (id, result) => send({ type: 'result', id, result }),
  (id, error) => send({ type: 'error', id, name: error instanceof Error ? error.name : 'Error', message: String(error) }),
);
onmessage = (event: MessageEvent<ThreeWorkerRequest>) => {
  const request = event.data;
  switch (request.type) {
    case 'init':
      if (host) { send({ type: 'error', id: -1, name: 'Error', message: '3D viewport already transferred' }); return; }
      host = new ThreeWorkerHost(request.canvas, request.requireHardware);
      break;
    case 'render': jobs.submit(request.id, request.input); break;
    case 'cancel': jobs.cancel(request.id); break;
    case 'dispose':
      void jobs.dispose().then(() => host?.release()).finally(() => { send({ type: 'disposed' }); close(); });
      break;
  }
};

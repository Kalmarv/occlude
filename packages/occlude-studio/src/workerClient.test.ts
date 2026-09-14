import { afterEach, expect, it, vi } from 'vitest';
import { RenderClient } from './workerClient.js';
import type { RunConfig } from './runner.js';

class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: Record<string, unknown>[] = [];
  onmessage?: (event: { data: Record<string, unknown> }) => void;
  onerror?: unknown;
  terminated = false;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: Record<string, unknown>) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(message: Record<string, unknown>) { this.onmessage?.({ data: message }); }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); FakeWorker.instances = []; });

it('cancels a superseded camera commit without restarting its retained worker', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const client = new RenderClient();
  try {
    const first = client.render({ cameraCommit: { executionId: 10, planHash: 'old', scene: 0,
      camera: { kind: 'orthographic', span: 4, eye: [1,2,3], target: [0,0,0], near: .1, far: 10 } } });
    clock.mockReturnValue(2000); // a normal render would have been preempted
    const next = client.render({ js: 'new sketch', cfg: {} as RunConfig }).catch(error => error);
    const worker = FakeWorker.instances[0];
    expect(worker.messages.map(message => message.type)).toEqual(['render-camera', 'cancel-camera']);
    expect(worker.messages[1].id).toBe(worker.messages[0].id);
    expect(FakeWorker.instances).toHaveLength(1); expect(worker.terminated).toBe(false);
    worker.reply({ type: 'error', id: worker.messages[0].id, message: 'aborted', cancelled: true });
    expect(await first).toBeNull();
    expect(worker.messages[2].type).toBe('render');
    worker.reply({ type: 'error', id: worker.messages[2].id, message: 'new sketch failed' });
    expect((await next).message).toBe('new sketch failed');
  } finally { client.dispose(); }
});

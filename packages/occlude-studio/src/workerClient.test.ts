import { afterEach, expect, it, vi } from 'vitest';
import * as occlude from 'occlude';
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
    expect(worker.messages.map(message => message.type)).toEqual(['render-camera', 'cancel-render']);
    expect(worker.messages[1].id).toBe(worker.messages[0].id);
    expect(FakeWorker.instances).toHaveLength(1); expect(worker.terminated).toBe(false);
    worker.reply({ type: 'error', id: worker.messages[0].id, message: 'aborted', cancelled: true });
    expect(await first).toBeNull();
    expect(worker.messages[2].type).toBe('render');
    worker.reply({ type: 'error', id: worker.messages[2].id, message: 'new sketch failed' });
    expect((await next).message).toBe('new sketch failed');
  } finally { client.dispose(); }
});


it('discards a late successful render before starting a replacement that fails', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const decode = vi.spyOn(occlude, 'decodeRender');
  const client = new RenderClient();
  try {
    const first = client.render({ js: 'obsolete', cfg: {} as RunConfig });
    const worker = FakeWorker.instances[0], oldId = worker.messages[0].id;
    const next = client.render({ js: 'new failure', cfg: {} as RunConfig }).catch(error => error);
    worker.reply({ type: 'render', id: oldId });
    expect(await first).toBeNull(); expect(decode).not.toHaveBeenCalled();
    expect(worker.messages.map(m => m.type)).toEqual(['render','cancel-render','discard-render','render']);
    worker.reply({ type: 'error', id: worker.messages.at(-1)!.id, message: 'new failure' });
    expect((await next).message).toBe('new failure');
    expect(worker.messages.some(m => m.type === 'accept-render')).toBe(false);
  } finally { client.dispose(); }
});

it('accepts decoded current results before their exports and rejects an obsolete input revision', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(occlude, 'decodeRender').mockReturnValue({} as ReturnType<typeof occlude.decodeRender>);
  const client = new RenderClient();
  try {
    const accepted = client.render({ js: 'current', cfg: {} as RunConfig });
    const worker = FakeWorker.instances[0];
    expect(worker.messages[0].deferAdoption).toBe(true);
    worker.reply({ type: 'render', id: worker.messages[0].id, planHash: 'committed' });
    expect(await accepted).not.toBeNull();
    const exported = client.planSvg({ planHash: 'committed', from: 0, to: 1 }, 100, 100, undefined);
    expect(worker.messages.map(m => m.type)).toEqual(['render','accept-render','plan-svg']);
    worker.reply({ type: 'plan-svg', id: worker.messages.at(-1)!.id, svg: '<svg/>' });
    expect(await exported).toBe('<svg/>');
    let current = true;
    const stale = client.render({ js: 'old inputs', cfg: {} as RunConfig }, () => current);
    const id = worker.messages.at(-1)!.id; current = false;
    worker.reply({ type: 'render', id });
    expect(await stale).toBeNull();
    expect(worker.messages.at(-1)).toEqual({ type: 'discard-render', id });
  } finally { client.dispose(); }
});

it('cancels work before a debounced replacement exists and discards undecodable results', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const client = new RenderClient();
  try {
    const stale = client.render({ js: 'old', cfg: {} as RunConfig });
    const worker = FakeWorker.instances[0], id = worker.messages[0].id;
    client.cancelRender();
    worker.reply({ type: 'render', id });
    expect(await stale).toBeNull();
    vi.spyOn(occlude, 'decodeRender').mockImplementation(() => { throw new Error('bad reply'); });
    const bad = client.render({ js: 'bad', cfg: {} as RunConfig }).catch(error => error);
    const badId = worker.messages.at(-1)!.id;
    worker.reply({ type: 'render', id: badId });
    expect((await bad).message).toBe('bad reply');
    expect(worker.messages.at(-1)).toEqual({ type: 'discard-render', id: badId });
  } finally { client.dispose(); }
});

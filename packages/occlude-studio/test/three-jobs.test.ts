import { describe, expect, it, vi } from 'vitest';
import { ThreeJobQueue } from '../src/three/jobs.js';
import type { ThreeRenderInput, ThreeRenderResult } from '../src/three/protocol.js';

const input = (cameraRevision: number) => ({ cameraRevision }) as ThreeRenderInput;
const result = (cameraRevision: number) => ({ cameraRevision }) as ThreeRenderResult;
const deferred = <T>() => { let resolve!: (v: T) => void, reject!: (v: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('3D worker job ownership', () => {
  it('coalesces camera bursts and refuses late results even if GPU work ignores abort', async () => {
    const gates = [deferred<ThreeRenderResult>(), deferred<ThreeRenderResult>()];
    const signals: AbortSignal[] = [], starts: number[] = [], published: number[] = [];
    const queue = new ThreeJobQueue((value, signal) => { starts.push(value.cameraRevision); signals.push(signal); return gates[starts.length - 1].promise; }, id => published.push(id), () => { throw new Error('unexpected failure'); });
    queue.submit(1, input(1)); queue.submit(2, input(2)); queue.submit(3, input(3));
    expect(starts).toEqual([1]); expect(signals[0].aborted).toBe(true);
    gates[0].resolve(result(1)); await settle();
    expect(starts).toEqual([1, 3]); expect(published).toEqual([]);
    gates[1].resolve(result(3)); await settle();
    expect(published).toEqual([3]); await queue.dispose();
  });
  it('cancelled old IDs cannot abort a newer active job', async () => {
    const gate = deferred<ThreeRenderResult>(), publish = vi.fn(); let signal!: AbortSignal;
    const queue = new ThreeJobQueue((_, s) => { signal = s; return gate.promise; }, publish, vi.fn());
    queue.submit(2, input(2)); queue.cancel(1); expect(signal.aborted).toBe(false);
    queue.cancel(2); expect(signal.aborted).toBe(true);
    gate.resolve(result(2)); await settle(); expect(publish).not.toHaveBeenCalled(); await queue.dispose();
  });
  it('disposal waits for an outstanding lease and forbids publication', async () => {
    const gate = deferred<ThreeRenderResult>(), publish = vi.fn(), fail = vi.fn();
    const queue = new ThreeJobQueue(() => gate.promise, publish, fail);
    queue.submit(1, input(1)); let released = false;
    const disposal = queue.dispose().then(() => { released = true; }); await settle();
    expect(released).toBe(false); gate.resolve(result(1)); await disposal;
    expect(publish).not.toHaveBeenCalled(); queue.submit(2, input(2));
    expect(fail).toHaveBeenCalledWith(2, expect.objectContaining({ name: 'AbortError' }));
  });
  it('recovers from synchronous errors without stranding a same-turn submission', async () => {
    const publish = vi.fn(), fail = vi.fn();
    const queue = new ThreeJobQueue(value => { if (value.cameraRevision === 1) throw new Error('bad geometry'); return Promise.resolve(result(value.cameraRevision)); }, publish, fail);
    queue.submit(1, input(1)); queue.submit(2, input(2)); await settle();
    expect(fail).toHaveBeenCalledWith(1, expect.any(Error)); expect(publish).toHaveBeenCalledWith(2, result(2)); await queue.dispose();
  });
  it('suppresses a superseded failure and removes a cancelled pending view', async () => {
    const gate = deferred<ThreeRenderResult>(), run = vi.fn(() => gate.promise), publish = vi.fn(), fail = vi.fn();
    const queue = new ThreeJobQueue(run, publish, fail);
    queue.submit(1, input(1)); queue.submit(2, input(2)); queue.cancel(2);
    gate.reject(new Error('lost old device')); await settle();
    expect(run).toHaveBeenCalledTimes(1); expect(fail).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled(); await queue.dispose();
  });
});

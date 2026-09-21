/**
 * The classifier's worker pool.
 *
 * One pool per process, spawned the first time a scene is big enough to want
 * it and kept afterwards. A worker is handed the scene once per run and then
 * pulls ranges of features from a shared cursor, so a worker that draws an
 * easy range comes back for more instead of idling while another grinds a
 * silhouette that crosses the whole model. Nothing here decides an interval:
 * every range is classified by the same `classifyFeature3` the serial loop
 * calls, and the rows are assembled by index, so the answer is the serial
 * answer.
 *
 * The browser spawns a module worker; node spawns a `node:worker_threads`
 * one. Both are reached through the same small channel below. If neither can
 * be had — no `Worker`, a content policy, a failed import — the caller runs
 * the serial loop and gets the same drawing.
 */
import type { Interval3 } from './interval.js';
import type { ClassifyPayload3 } from './scene.js';

/** A range of features per message. 153 k features on the globe case is 600
 * chunks: fine enough that one slow range costs a percent of the run, coarse
 * enough that the message per chunk is noise. */
const CHUNK = 256;
/** Assembled rows in feature order, and the candidate pairs they tested. */
export interface ClassifyPoolRun3 { readonly hidden: Interval3[][]; readonly candidates: number }
interface WorkerReply3 { readonly epoch: number; readonly from: number; readonly counts: Int32Array; readonly intervals: Float64Array; readonly candidates: number; readonly error?: string }

/** Both worker flavours through one door. The message and failure handlers
 * are registered once, at spawn, and read the fields a run sets: a listener
 * added per run would pile up on a pool that outlives every render.
 * `active` is node's ref/unref — an idle pool must not keep a tool's process
 * alive, and a running one must. */
interface Channel3 {
  handle: ((reply: WorkerReply3) => void) | null;
  fail: ((error: unknown) => void) | null;
  post(message: unknown): void;
  active(on: boolean): void;
  terminate(): void;
}

const nodeWorkers = ['node', 'worker_threads'].join(':');

const browser = (): boolean => typeof Worker === 'function';
/** Worker count: what the caller asked, else `OCCLUDE_WORKERS`, else the
 * default for where this is running. A browser page is the artist's own
 * machine and takes every core. Node is a tool — the docs checker, the bench,
 * plotstats — and those run on a shared server beside other services, so the
 * default there is half the cores. Each worker also holds its own copy of the
 * scene (a few hundred megabytes on the globe case), which is the second
 * reason not to take the whole box. `OCCLUDE_WORKERS` overrides either. */
export function poolWorkerCount3(explicit?: number): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OCCLUDE_WORKERS;
  const asked = explicit ?? (env === undefined || env === '' ? undefined : Number(env));
  if (asked !== undefined && Number.isFinite(asked)) return Math.max(1, Math.floor(asked));
  const cores = globalThis.navigator?.hardwareConcurrency ?? 1;
  return Math.max(1, Math.floor(browser() ? cores : cores / 2));
}

async function spawn3(): Promise<Channel3 | null> {
  try {
    if (browser()) {
      // Written out literally: this spelling is what a bundler reads to emit
      // the worker as its own chunk, in the studio's render worker too.
      const worker = new Worker(new URL('./classify.worker.ts', import.meta.url), { type: 'module', name: 'occlude-classify' });
      const channel: Channel3 = {
        handle: null, fail: null,
        post: (message) => worker.postMessage(message),
        active: () => {},
        terminate: () => worker.terminate(),
      };
      worker.onmessage = (event) => channel.handle?.(event.data as WorkerReply3);
      worker.onerror = (event) => channel.fail?.(new Error((event as ErrorEvent).message || 'classify worker failed'));
      return channel;
    }
    const { Worker: NodeWorker } = await import(/* @vite-ignore */ nodeWorkers) as typeof import('node:worker_threads');
    // Under a TypeScript runner the worker file is the source beside this one;
    // a built package's is the emitted sibling. `tsx` is asked for explicitly
    // because a worker spawned from a test runner does not inherit one.
    const source = import.meta.url.endsWith('.ts');
    const worker = new NodeWorker(new URL(`./classify.worker${source ? '.ts' : '.js'}`, import.meta.url), source ? { execArgv: ['--import', 'tsx'] } : {});
    worker.unref();
    const channel: Channel3 = {
      handle: null, fail: null,
      post: (message) => worker.postMessage(message),
      active: (on) => { if (on) worker.ref(); else worker.unref(); },
      terminate: () => { void worker.terminate(); },
    };
    worker.on('message', (reply: WorkerReply3) => channel.handle?.(reply));
    worker.on('error', (error) => channel.fail?.(error));
    worker.on('exit', (code) => { if (code !== 0) channel.fail?.(new Error(`classify worker exited with ${code}`)); });
    return channel;
  } catch {
    return null;
  }
}

class Pool3 {
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly channels: readonly Channel3[]) {}
  terminate(): void { for (const channel of this.channels) { channel.handle = null; channel.fail = null; channel.terminate(); } }
  /** Runs are serialised: one scene is in the workers at a time, so a second
   * view waits rather than interleaving its chunks with the first view's. */
  run(payload: ClassifyPayload3, featureCount: number, signal?: AbortSignal): Promise<ClassifyPoolRun3> {
    const run = this.queue.then(() => this.classify(payload, featureCount, signal));
    this.queue = run.catch(() => {});
    return run;
  }
  private classify(payload: ClassifyPayload3, featureCount: number, signal?: AbortSignal): Promise<ClassifyPoolRun3> {
    const epoch = ++this.epoch;
    const hidden: Interval3[][] = new Array(featureCount);
    const workers = this.channels.length;
    // Each worker starts on its own contiguous share and walks forward. The
    // features of a scene come out of capture object by object and triangle by
    // triangle, so neighbouring indices meet neighbouring occluders: a worker
    // that keeps to one band touches a fraction of the model's exact geometry
    // instead of all of it, and builds a fraction of it. When a band runs out
    // its worker takes the tail of whichever band has most left — the owner is
    // still reading that band from the front, so the two do not collide.
    const span = Math.ceil(featureCount / workers) || 1;
    const at = new Int32Array(workers), end = new Int32Array(workers);
    for (let k = 0; k < workers; k++) { at[k] = Math.min(featureCount, k * span); end[k] = Math.min(featureCount, (k + 1) * span); }
    const take = (k: number): readonly [number, number] | null => {
      if (at[k] < end[k]) { const from = at[k]; at[k] = Math.min(end[k], from + CHUNK); return [from, at[k]]; }
      let fullest = -1, most = 0;
      for (let j = 0; j < workers; j++) { const left = end[j] - at[j]; if (left > most) { most = left; fullest = j; } }
      if (fullest < 0) return null;
      const to = end[fullest];
      end[fullest] = Math.max(at[fullest], to - CHUNK);
      return [end[fullest], to];
    };
    let candidates = 0, outstanding = 0, settled = false;
    return new Promise<ClassifyPoolRun3>((resolve, reject) => {
      const stop = (): void => {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        for (const channel of this.channels) { channel.handle = null; channel.fail = null; channel.active(false); }
      };
      const onAbort = (): void => { if (settled) return; const reason = signal?.reason; stop(); reject(reason instanceof Error ? reason : new Error('classification aborted')); };
      const fail = (error: unknown): void => { if (settled) return; stop(); reject(error instanceof Error ? error : new Error(String(error))); };
      const next = (channel: Channel3, k: number): void => {
        if (settled) return;
        const range = take(k);
        if (!range) { if (outstanding === 0) { stop(); resolve({ hidden, candidates }); } return; }
        outstanding++;
        channel.post({ epoch, from: range[0], to: range[1] });
      };
      this.channels.forEach((channel, k) => {
        channel.active(true);
        channel.fail = fail;
        channel.handle = (reply) => {
          // A reply from a run that was aborted names an older epoch; its work
          // is dropped rather than mixed into this one's rows.
          if (settled || reply.epoch !== epoch) return;
          if (reply.error) { fail(new Error(reply.error)); return; }
          let at = 0;
          for (let k = 0; k < reply.counts.length; k++) {
            const row: Interval3[] = [];
            for (let c = 0; c < reply.counts[k]; c++) { row.push([reply.intervals[at], reply.intervals[at + 1]]); at += 2; }
            hidden[reply.from + k] = row;
          }
          candidates += reply.candidates;
          outstanding--;
          next(channel, k);
        };
        // The scene is posted once per run; the chunks that follow name only
        // the range, so the payload crosses each wire exactly one time.
        channel.post({ epoch, scene: payload });
      });
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.channels.forEach((channel, k) => next(channel, k));
    });
  }
}

let pooled: Promise<Pool3 | null> | undefined;
let pooledSize = 0;
function pool3(workers: number): Promise<Pool3 | null> {
  if (pooled && pooledSize === workers) return pooled;
  const previous = pooled;
  pooledSize = workers;
  return pooled = (async () => {
    (await previous)?.terminate();
    const spawned = await Promise.all(Array.from({ length: workers }, spawn3));
    const channels = spawned.filter((channel): channel is Channel3 => channel !== null);
    if (channels.length !== workers) { for (const channel of channels) channel.terminate(); return null; }
    return new Pool3(channels);
  })();
}

/** The pool's answer for one scene, or null when no pool could be had or a
 * worker failed — the caller then runs the serial loop, which is the same
 * answer. A failure retires the pool, so the next render spawns a fresh one.
 * An abort is the caller's own and is rethrown. */
export async function classifyWithPool3(payload: ClassifyPayload3, featureCount: number, options: { signal?: AbortSignal; workers?: number } = {}): Promise<ClassifyPoolRun3 | null> {
  const workers = poolWorkerCount3(options.workers);
  if (workers < 2) return null;
  const pool = await pool3(workers);
  if (!pool) return null;
  try {
    return await pool.run(payload, featureCount, options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    void (await pooled)?.terminate();
    pooled = undefined; pooledSize = 0;
    return null;
  }
}

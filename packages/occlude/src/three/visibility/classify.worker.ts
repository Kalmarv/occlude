/**
 * One core of the hidden-line classifier.
 *
 * The pool hands this the scene once, then a range of feature indices at a
 * time. Each range runs the same `classifyFeature3` the serial loop runs, over
 * a source holding the same numbers the snapshot held, so the intervals are
 * the serial intervals — a feature's answer reads nothing but the scene and
 * its own index. The rows go back flat: one count per feature and the pairs
 * end to end, which the pool reads into `hidden[i]` at the right index.
 */
import { classifyFeature3, classifyFilter3, classifySource3, type ClassifyPayload3, type ClassifySource3 } from './scene.js';
import type { Interval3 } from './interval.js';
import type { RasterFilter3 } from './raster.js';

interface SceneMessage3 { readonly epoch: number; readonly scene: ClassifyPayload3 }
interface ChunkMessage3 { readonly epoch: number; readonly from: number; readonly to: number }
type Message3 = SceneMessage3 | ChunkMessage3;

let post: (message: unknown, transfer: ArrayBuffer[]) => void = () => {};
let source: ClassifySource3 | null = null;
let filter: RasterFilter3 | undefined;
let epoch = -1;
const walked: number[] = [];

function handle(message: Message3): void {
  if ('scene' in message) {
    // The raster filter and the projected index are derived, not sent: each
    // worker builds its own from the same numbers, in parallel with the
    // others, which costs less than serialising either.
    epoch = message.epoch;
    source = classifySource3(message.scene);
    filter = classifyFilter3(source);
    return;
  }
  if (message.epoch !== epoch || !source) return;
  const counts = new Int32Array(message.to - message.from), rows: Interval3[] = [];
  let candidates = 0;
  try {
    for (let i = message.from; i < message.to; i++) {
      const before = rows.length;
      candidates += classifyFeature3(source, filter, i, walked, rows);
      counts[i - message.from] = rows.length - before;
    }
  } catch (error) {
    post({ epoch: message.epoch, from: message.from, counts: new Int32Array(0), intervals: new Float64Array(0), candidates: 0, error: error instanceof Error ? error.message : String(error) }, []);
    return;
  }
  const intervals = new Float64Array(rows.length * 2);
  for (let k = 0; k < rows.length; k++) { intervals[k * 2] = rows[k][0]; intervals[k * 2 + 1] = rows[k][1]; }
  post({ epoch: message.epoch, from: message.from, counts, intervals, candidates }, [counts.buffer, intervals.buffer]);
}

if (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function') {
  const scope = self as unknown as { postMessage(message: unknown, transfer: ArrayBuffer[]): void; onmessage: ((event: { data: Message3 }) => void) | null };
  post = (message, transfer) => scope.postMessage(message, transfer);
  scope.onmessage = (event) => handle(event.data);
} else {
  // Node queues a port's messages until a listener attaches, so reaching for
  // the port asynchronously loses nothing. The browser branch above stays
  // synchronous, where that guarantee does not hold.
  void import(/* @vite-ignore */ ['node', 'worker_threads'].join(':')).then(({ parentPort }: typeof import('node:worker_threads')) => {
    post = (message, transfer) => parentPort?.postMessage(message, transfer as never);
    parentPort?.on('message', handle);
  });
}

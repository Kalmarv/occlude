/** Created only by Run. Termination cancels without touching the renderer. */
import { optimizeRequest } from "./optimization-runner.js";
import type { OptimizationRequest } from "./optimization.js";
self.onmessage = async ({ data }: MessageEvent<OptimizationRequest>) => {
  try {
    const result = await optimizeRequest(data, (stage) =>
      self.postMessage({ stage }),
    );
    self.postMessage(
      { result },
      {
        transfer: [
          result.buffer.buffer,
          result.before.buffer,
          result.after.buffer,
          result.stats.buffer,
        ],
      },
    );
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};

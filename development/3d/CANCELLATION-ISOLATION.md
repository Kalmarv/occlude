# Cancellation boundaries and execution isolation

The direct Playwright robustness worker exercises production compute classes on NVIDIA hardware. Boundary injection temporarily wraps real WebGPU methods inside this verification worker; no testing hook or cancellation policy was added to the application.

## GPU leases

The control sends 513 identical analytical pairs through a 16,384-byte GPU session (128 pairs per dispatch). A tight parameter tolerance forces 513 CPU refinements across five dispatches, with exact expected intervals [0.375, 0.625]. Four cancellations then occur at the following boundaries:

| Boundary | Injection | Required observation |
| --- | --- | --- |
| Upload | Immediately after the real `queue.writeBuffer` | Original abort reason rejects; no dispatch or map occurs. |
| Dispatch | Immediately after the real `queue.submit` | One submitted batch drains its map, then rejects. |
| Readback | Once the real `mapAsync` resolves | Mapped data is released and the lease rejects. |
| Before CPU refinement | Once the real `popErrorScope` resolves after readback/unmapping | The check before the synchronous refinement loop rejects. |

After every cancellation, another full control job must produce all 513 exact intervals. Explicit buffer count must remain fixed and every buffer must be unmapped. An additional three-job queue has its middle job aborted before acquiring the lease; the first and last succeed. Disposal must destroy every tracked explicit buffer.

This establishes cancellation at asynchronous boundaries and immediately before refinement. It does not claim that a new worker message interrupts synchronous JavaScript midway through a refinement loop. Main Studio's revision/staged-publication protocol rejects superseded results independently of whether old computation has already finished; [STUDIO-ADOPTION.md](STUDIO-ADOPTION.md) covers late completion, newer failures and camera commitment in the actual UI. Worker restart and GPU device-loss recovery remain explicitly deferred by the user, with page reload accepted.

## Execution isolation

Four input sets vary projection kind/camera, physical paper size, resolved pen width/color, seed, captured text asset, and generated box dimensions/position. The asset value and seeded random value actually control source geometry. Each set runs both headless CPU and hardware GPU classification, producing eight standalone reference executions. Eight new executions are then started together, paused inside their asynchronous sketch functions, and released in a deliberately different order. GPU jobs share one production `GpuSceneCompute3` host. Each execution must exactly match its own standalone SVG, realized feature data, camera frame, paper, pen, seed, captured asset and reported budget. At least four distinct SVGs prove that the varied inputs affect output.

A generator failure after successful GPU classification and an execution aborted after GPU completion must both reject. Another concurrent GPU execution must match its standalone result, and an earlier execution must still export its exact prior SVG. Finally, host disposal must destroy all tracked explicit buffers. This measures explicit resource lifetime, not opaque driver allocation.

Source hardware evidence: [robustness-source/report.json](robustness-source/report.json). Reproduce against the isolated served build with `DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-robustness.mjs`. The harness uses `three.html` solely to launch the computation worker; this is not a claim that the laboratory substitutes for main Studio UI tests.

Served acceptance passed: [robustness/report.json](robustness/report.json), Chrome 145.0.7632.109 with a nonfallback NVIDIA Turing adapter. The final barrier version waits for all eight sketches to enter their paused state before releasing any. All four cancellation boundaries, queued abort, failed generation, canceled execution, prior export and exact interleaved comparisons pass; zero explicit buffers remain after disposal. `robustness-build.log` records all `pnpm check` gates passing, unchanged docs ink and WASM `8bf0034cb79606aa8d6c7293496a1b7e`. Production container identities and start times remain unchanged. This slice adds verification only; application geometry, toolpaths and UI are unchanged.

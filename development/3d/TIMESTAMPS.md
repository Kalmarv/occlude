# Visibility GPU timestamps and performance refresh

The GPU interval session now requests the optional `timestamp-query` feature when the adapter supports it and the explicit memory budget can hold the extra timing buffers. Each compute pass writes start/end timestamps. Results are resolved and copied next to the ordinary interval readback, so timing adds no second map/wait per batch. `gpuMs` sums those compute-pass durations; unsupported or disabled timing leaves the field absent. An empty timed workload reports zero.

The scene classifier accumulates this optional value without changing interval output. `classified.stats.gpuMs` measures visibility compute passes only. It excludes shader/pipeline compilation, host packing/upload, result readback, CPU interval refinement, stroke construction, planning and export; ordinary wall-time measurements remain necessary. It also does not include modeling deformation/query shaders or construction-view rasterization. Browser timestamp precision/quantization is implementation-dependent; see [Chrome's timestamp-query description](https://developer.chrome.com/blog/new-in-webgpu-121).

The timer uses a two-entry query set, a 16-byte resolve buffer and 16 extra staging bytes. Those 32 explicit buffer bytes are reserved from the configured memory budget, and 16 timestamp-readback bytes per dispatch are included in transfer accounting. At the minimum 128-byte budget, timing is disabled so the single-pair capacity remains usable. Query-set/browser/driver internal allocations are not represented by explicit buffer-byte counts. All timer resources are destroyed with the session.

`tools/verify-timestamps.mjs` runs direct Playwright against the served lab API to verify the computation module. It tests enabled timing, explicit disabling, minimum-budget fallback, and a wrapper that hides the adapter's timestamp feature to exercise unsupported-feature fallback on the same hardware. Every mode performs repeated multi-batch reads and checks the exact analytical intervals, dispatch/transfer accounting, bounded resident bytes and optional timing semantics. The hidden-feature case is a simulated capability omission, not a claim to have tested another adapter. Main Studio is checked separately through its live 3D examples and export.

Run from the worktree root:

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-timestamps.mjs
DISPLAY=:93 OCCLUDE_GPU_EVIDENCE=../../development/3d/benchmark-timestamps pnpm --filter occlude-studio exec node tools/benchmark-three.mjs
```

The benchmark records three alternating CPU/GPU visibility runs, all GPU kernel samples and their median, end-to-end times, model/snapshot/export costs, candidate/interval/refinement counts, transfers, explicit buffer peaks, startup and orbit. The scene fixtures, comparison assertions and finishing path are unchanged from the previous benchmark. It requires exact CPU/GPU interval topology and checks all interval parameters, rather than accepting a timer result alone.

## Served-bundle measurements

NVIDIA GeForce RTX 2060 / Turing, driver 595.71.05; Chrome 145.0.7632.109. Worker WASM startup 13.5 ms; GPU device/pipeline startup 819.6 ms. The normal verification browser flags were used; no additional timestamp-precision override was added.

| Scene | CPU visibility median | GPU compute-pass median | GPU visibility wall median | Snapshot through SVG |
| --- | ---: | ---: | ---: | ---: |
| grid-4 | 0.8 ms | 0.0101 ms | 11.1 ms | 30.4 ms |
| grid-16 | 8.3 ms | 0.0090 ms | 87.3 ms | 145.0 ms |
| grid-40 | 46.7 ms | 0.0377 ms | 385.1 ms | 579.7 ms |
| grid-80 | 162.5 ms | 0.0940 ms | 1340.6 ms | 2081.7 ms |
| grid-100 | 256.0 ms | 0.1757 ms | 2027.5 ms | 3273.7 ms |
| city-30 | 674.7 ms | 0.3166 ms | 3822.1 ms | 4258.4 ms |

All six workloads preserve exact CPU/GPU interval topology and report zero maximum parameter difference. The GPU visibility path remains slower than the CPU oracle throughout this sample range; there is no observed crossover or acceleration claim. The tiny compute-pass durations do not explain the full cost: host processing, submission/readback and refinement dominate. This measurement does not isolate their individual contributions.

The 20,000-triangle retained viewport uploads geometry once and achieves a 41.8 FPS worker-side warm rate, excluding main-thread presentation. Its explicit interval-plus-viewport buffers peak at 9593392 bytes, plus a 3763200-byte depth texture. The benchmark also retains the old CPU-projected viewport as a comparison, whose allocations contribute to the larger overall peak; it is not the main Studio orbit path. Pathological overlap still reports the explicit candidate limit instead of dropping geometry.

Evidence: [complete benchmark report](benchmark-timestamps/report.json), [city SVG](benchmark-timestamps/city-30.svg), [timestamp capability/readback checks](timestamps/report.json), and [main Studio 3D examples/export report](playwright-timestamps/report.json). The source-server timestamp check is preserved separately in timestamps-source/report.json.

Main Studio, including presentation, measured **31.7 FPS** over 118 presented frames for the same 20,000-triangle grid. It issued zero sketch renders during orbit and retained the exact committed plan. Evidence: [Studio orbit report](benchmark-timestamps/studio-orbit.json) and [inspected screenshot](benchmark-timestamps/studio-orbit.png). This is a development-machine measurement, not a universal hardware guarantee.

Validation: complete isolated-container `pnpm check` passed all gates; WASM remains `615f9d1b7a63396d451fd33aac18b559` and docs ink is unchanged. Only the isolated dev service was rebuilt/deployed. Served timestamp/fallback checks, full visibility benchmark, main Studio orbit benchmark, and all eight 3D live examples plus Studio SVG export passed. The live-example verifier records the expected empty-store API 404s separately and no page errors. Production container IDs and start times remained unchanged.

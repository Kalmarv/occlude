# M5 performance baseline

Historical measurements below. [TIMESTAMPS.md](TIMESTAMPS.md) contains the current served-bundle refresh, compute-pass timestamps and retained-viewport results; the slow legacy orbit numbers below are not the current main Studio path.

The benchmark runs in a dedicated browser worker against the same CPU visibility oracle, streamed GPU classifier, stroke constructor, paper adapter and SVG exporter used by the implementation. It compares complete hidden/visible interval topology and parameter endpoints for every feature. Three measurements alternate CPU/GPU ordering; cold worker WASM and GPU device/pipeline startup are reported separately. Candidate transfer/readback and CPU refinement are included in wall time. Kernel timestamps are not yet collected.

Run the verified dev bundle with:

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/benchmark-three.mjs
```

Set `OCCLUDE_GPU_URL=http://127.0.0.1:5277` for the source server or `OCCLUDE_GPU_EVIDENCE` for another output directory. The laboratory exposes a bundled benchmark worker factory; the benchmark does not access source modules through `/@fs` when run against the served bundle. Hardware NVIDIA is required. Output includes per-case progress, report.json and a representative city SVG.

The smooth-grid workload has a small deterministic sinusoidal displacement. The city contains 900 boxes with deterministic varying heights and substantial overlap. All source edges participate in classification. The 100×100 grid meets the pilot workload at 20,000 triangles and 20,200 features; the city has 10,800 of each. A separate 100-box overlap test deliberately exceeds an explicit 10,000-pair capacity and verifies an actionable error rather than silent feature loss.

Initial source measurements on NVIDIA Turing:

| Scene | Triangles | Features | Candidate pairs | CPU visibility median | GPU visibility median | Snapshot through SVG |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Grid 4 | 32 | 40 | 208 | 0.7 ms | 26.1 ms | 44.4 ms |
| Grid 16 | 512 | 544 | 4,020 | 6.0 ms | 65.3 ms | 119.0 ms |
| Grid 40 | 3,200 | 3,280 | 26,128 | 38.3 ms | 378.0 ms | 568.5 ms |
| Grid 80 | 12,800 | 12,960 | 105,696 | 168.3 ms | 1,286.3 ms | 2,129.4 ms |
| Grid 100 | 20,000 | 20,200 | 165,450 | 260.0 ms | 2,045.6 ms | 3,154.0 ms |
| City 30 | 10,800 | 10,800 | 274,701 | 664.7 ms | 3,911.6 ms | 4,338.5 ms |

No CPU/GPU interval mismatch was observed (maximum parameter error zero on these workloads). GPU visibility is slower throughout this sample range: no crossover or acceleration claim is supported. Near-contact refinement dominates the grid; the city also requires cross-pair topology refinement, so its refinement count can exceed the candidate count. Final-vector timings are in the low-single-digit-second range for these fixtures, excluding procedural model generation.

The existing construction renderer misses the orbit target: a 20k-triangle scene at 1120×840 takes a warm median 147.7 ms per frame (6.8 FPS). This includes world-to-camera CPU projection, CPU clipping/packing, GPU raster submission, bitmap creation and queue completion; main-thread presentation is additional. Explicit GPU buffers peak at 12,737,408 bytes, plus a 3,763,200-byte depth texture. The interval buffers alone occupy 8 MiB. Browser/driver allocations and JS heap are not included in this buffer accounting.

The next optimization is retained world-space vertex buffers with GPU camera projection, avoiding CPU geometry reconstruction on every orbit frame. Broader performance, GPU timestamp instrumentation and the full M5 audit remain unfinished. Production-bundle measurements below supersede source timings for handoff claims.

Full isolated-image `pnpm check` passes: Rust 10.3s, TS 21.7s, library types 5.5s, Studio types 5.0s, live docs 12.6s, ink 14.5s, build 37.1s and smoke 2.2s. WASM remains `615f9d1b7a63396d451fd33aac18b559`; existing 2D ink is unchanged. Only the isolated dev service was deployed. Source measurements are preserved in benchmark/source-report.json.

## Served-bundle measurements

NVIDIA GeForce RTX 2060, 595.71.05, 6144; Chrome 145.0.7632.109. Worker WASM startup 14.5 ms; GPU device/pipeline startup 788.1 ms.

| Scene | CPU visibility median | GPU visibility median | Snapshot through SVG |
| --- | ---: | ---: | ---: |
| grid-4 | 0.8 ms | 9.5 ms | 30.4 ms |
| grid-16 | 6.8 ms | 70.8 ms | 129.6 ms |
| grid-40 | 49.7 ms | 397.0 ms | 621.7 ms |
| grid-80 | 166.4 ms | 1382.6 ms | 2055.2 ms |
| grid-100 | 256.6 ms | 2136.9 ms | 3366.5 ms |
| city-30 | 665.0 ms | 3994.9 ms | 4453.8 ms |

Large-grid orbit: 149.0 ms warm median (6.7 FPS). The served bundle confirms the same correctness, slower GPU visibility, and unmet orbit target as the source baseline. Explicit buffer/depth allocations are unchanged. Evidence: benchmark/report.json and benchmark/city-30.svg.

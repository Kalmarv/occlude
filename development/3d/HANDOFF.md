# Occlude 3D M0–M5 handoff

The procedural 3D MVP is implemented in the isolated clone `/home/kalmarv/containers/occlude-3d`, branch `feat/3d-webgpu`, pushed incrementally to `origin/dev`. The original scope and clause-level evidence are in [ACCEPTANCE.md](ACCEPTANCE.md); automatic worker-restart/device-loss recovery remains explicitly deferred by the user. [COMMITS.md](COMMITS.md) lists the implementation history from `c705cdeb` through the final verification commit `20347d9`; this handoff is the following documentation commit.

## Open it and try the demos

The isolated dev Studio listens on **0.0.0.0:5273**, used by **https://dev-occlude.ivyhq.xyz**. Local hardware verification uses `http://127.0.0.1:5273`; it does not claim an authenticated Cloudflare session. The service serves the verified built bundle through `server.mjs`, avoiding raw Vite `/@fs` URLs. Production remains separate.

The three demos are installed in the isolated **dev sketch store** as `visibility-laboratory`, `procedural-relief` and `paper-composition`. Refresh Studio’s Sketches page to open them. The paper composition uses the portable bundled version. Their source/export files are also available below:

| Demo | Source | Vector/export evidence |
| --- | --- | --- |
| Visibility laboratory | [visibility-laboratory.ts](demos/visibility-laboratory.ts) | [SVG](playwright-visibility-demo/visibility.svg): clean/hidden, dashed/wobbled and contour/wire interpretations share one classification; console reports source strokes and GPU counters. |
| Procedural relief | [procedural-relief.ts](demos/procedural-relief.ts) | [SVG](playwright-relief/relief.svg): seed selection, extrusion, eight deformation passes, effective ceiling query, attribute hatch and sections. |
| Imperial paper composition | [paper-composition.ts](demos/paper-composition.ts) | [Portable bundled sketch](playwright-paper-composition/paper-composition.ts), [SVG](playwright-paper-composition/composition.svg): Letter paper, imported model in two colors, one-off pen, labels/mask and committed camera. |

Open the named sketches from the dev store, or use **Import** for the files. For the unbundled paper-composition source, use the starter `Letter` paper and `pigma-01-black` model, or import the portable bundled version. Use **3D** to explore; **Commit view** creates the new committed vector result. Exploration alone leaves the exported drawing unchanged. Change the relief seed to see different sites. [Demo instructions](demos/README.md) describe the remaining controls and assertions.

## Implemented API

[docs/three.md](../../docs/three.md) contains eight executable examples and signatures. Ordinary 2D sketches remain synchronous; GPU work uses `sketchAsync`, `compileSketchAsync` and `renderAsync`. A synchronous sketch can return `lineArt3`, resolved by the async renderer.

- Model data: `surface3`, `grid3`, `box3`, `pointCloud3`, open wire point arrays; `FaceSelection3`, `PointSelection3`, `EdgeSelection3`; explicit transforms, owned edits, `extrudeFaces3`, `stepsSurface3`.
- GPU/CPU batches: `t.deform3` for fixed-topology displacement/gather relaxation; `t.querySurface3` for batched ray, segment and nearest-surface queries. CPU evaluates arbitrary JS callbacks and topology edits.
- Line data: `lineArt3`, `t.classify3`, `FeatureSelection3`, `constructStrokes3`, `t.strokes3`; filter/group/inspect source attributes and visible/hidden intervals, then apply named pens and ordinary supported ordered modifiers.
- Surface decoration: `section3` generates mesh-plane intersections; `hatch3` generates physical paper spacing with support provenance, crosshatch and per-face parameters.
- Retained composition: `drawing3(scene, (view, t) => ...)` retains the interpretation needed by `commitCamera3`. Explicit `cameras3` configuration persists/downloads camera overrides.

```ts
import { sketch, box3, lineArt3, pen, mm } from 'occlude';

export default sketch({ seed: 42, pens: {
  outline: pen({ width: mm(0.3), color: '#18202A' }),
} }, () => lineArt3({
  objects: [{ id: 'box', surface: box3([2, 1, 1]) }],
  camera: { kind: 'orthographic', span: 4,
    eye: [4, 6, 5], target: [0, 0, 0], near: 0.1, far: 30 },
  lineSets: [{ id: 'visible', stroke: 'outline' }],
}));
```

The small example above was compiled with `compileSketchAsync` on the CPU path and exported as [handoff-example.svg](handoff-example.svg). The older synchronous `plotstats` helper diagnoses async rendering required for deferred 3D scenes; use the async API for headless 3D.

## Architecture and limits

Editable f64 model geometry is captured into an immutable scene/snapshot. Polygon topology, stable IDs, attributes and support mappings survive triangulation and visibility splitting. A conservative projected BVH streams candidate pairs to the geometric WebGPU interval shader; uncertain pairs refine against the robust f64 CPU oracle. Hidden unions and visible complements become inspectable stroke values. Chaining/selection/styling then lower into the existing recording, physical planning and SVG/G-code path. One existing timing model and captured paper/pen settings remain authoritative.

The Studio render worker owns a lazy GPU host, reusable pipelines/buffers and an OffscreenCanvas. Modeling and visibility use bounded serialized leases; retained world geometry enables camera-only GPU viewport updates. The main thread receives ImageBitmaps and source-linked pick data. Camera exploration consumes no new model randomness. A revision/accept/discard protocol prevents obsolete completed work replacing the last committed export. Cancellation is cooperative at asynchronous boundaries; synchronous JS cannot process another worker message until it yields. [Cancellation evidence](CANCELLATION-ISOLATION.md) covers failed jobs, buffer cleanup, interleaved inputs and prior-export preservation.

The additional 3D paper budget is `min(0.005 mm, narrowest resolved nib / 20)`, with half allocated to interval reconstruction and half reserved for f64 projection. It derives a conservative parameter tolerance from clipped projected speed, including perspective depth changes and overscan. This is a tested policy, not an arbitrary-magnitude numerical guarantee. The existing 2D input grid remains separate: 0.005 mm grid, up to approximately 0.003535534 mm geometric 2D displacement. [Precision note](PAPER-PRECISION.md) explains the stress cases and numerical limits.

Hatch is view-dependent physical paper spacing lifted onto the represented surface; it is not Krbn curvature-following hatch. Sections cut a mesh with planes, not with another box. Meshes are piecewise planar/triangular: no exact smooth silhouettes or cross-device byte-identity promise. Independent-face extrusion rejects adjacent selected faces. Later curved hatch can supply new support-attached candidates; mesh import can supply the same polygon data, without replacing the renderer.

Saved results retain the actual committed plan/SVG/settings and explanatory camera/model/backend provenance. Reopening does not rerun modeling or depend on newly edited libraries. A downloaded sketch instead bundles definitions/camera and regenerates through the documented backend. The final hardware checks verify both paths separately.

## Performance on the development machine

NVIDIA RTX 2060/Turing, driver 595.71.05, Chrome 145.0.7632.109. Three alternating CPU/GPU samples per workload, medians below; final bundle at `20347d9`. WASM initialization was 19.4 ms and GPU device/pipeline initialization 803.1 ms in this run. “Through SVG” includes snapshot, GPU visibility wall time, stroke construction and finishing/export, excluding model construction and startup.

| Scene | Triangles / features | CPU visibility | GPU visibility wall | Through SVG |
| --- | ---: | ---: | ---: | ---: |
| grid-4 | 32 / 40 | 0.5 ms | 8.6 ms | 31.4 ms |
| grid-16 | 512 / 544 | 7.3 ms | 69.5 ms | 137.8 ms |
| grid-40 | 3,200 / 3,280 | 39.3 ms | 405.9 ms | 638.8 ms |
| grid-80 | 12,800 / 12,960 | 187.6 ms | 1,448.1 ms | 2,159.5 ms |
| grid-100 | 20,000 / 20,200 | 265.4 ms | 2,356.2 ms | 3,672.0 ms |
| city-30 (900 boxes) | 10,800 / 10,800 | 698.5 ms | 4,083.7 ms | 4,578.2 ms |

All six workloads match CPU interval topology and parameters. GPU visibility is slower across this sample range; no acceleration or crossover claim. Grid-100 has 165,450 candidates and 162,726 refinements; the city has 274,701 candidates and 295,197 refinement operations, including repeat cross-pair topology refinement. Tiny kernel times (0.198/0.318 ms respectively) do not represent total cost. Transfers are approximately 18.53/30.77 MB. Full counters, limits and pathological-overlap diagnostics are in [benchmark-final/report.json](benchmark-final/report.json).

The retained 20,000-triangle viewport uploads geometry once and measures 39.8 FPS in the worker, excluding presentation. Its interval-plus-viewport explicit buffers peak at 9,593,392 bytes plus a 3,763,200-byte depth texture. The report's larger 12,737,312-byte total includes the legacy viewport comparison. Driver-internal memory is not measured. Main Studio measured **30.4 presented FPS** over 118 frames, with zero sketch renders and an unchanged plan during orbit ([report](benchmark-final/studio-orbit.json)); these are machine-specific measurements, not universal budgets. Compare historical measurements in TIMESTAMPS.md without inferring causation from timing variation.

## Verification and reproduction

From `/home/kalmarv/containers/occlude-3d`:

```sh
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev config
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
```

Only name the isolated `dev` service. The image builds WASM, then runs every `pnpm check` gate: Rust and TS tests, both typechecks, live docs, ink baseline, build, WASM identity and server/assets smoke. The final documentation build passes all nine gates ([FINAL-GATES.json](FINAL-GATES.json)). Verified WASM is `8bf0034cb79606aa8d6c7293496a1b7e`. These are local/container checks, not a remote CI claim. Existing non-3D stable ink stays unchanged; church seed 42 remains 15,601 chains, 96,037 mm drawing, 16,515 mm travel and 381.0 estimated minutes. Deliberate 3D phase/wobble baseline changes are documented in PHASE.md and STYLE-IDENTITY.md.

Hardware verification uses direct Playwright, never ProofShot. On this machine the task Xvfb display is `:93`, Chrome `/usr/bin/google-chrome`, Vulkan ICD `/usr/share/vulkan/icd.d/nvidia_icd.json`; the drivers contain the required browser flags. A different machine must supply its own supported hardware adapter/display.

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-precision.mjs
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-robustness.mjs
DISPLAY=:93 OCCLUDE_CONSTRUCTION_CHECK=1 OCCLUDE_CAMERA_CHECK=1 OCCLUDE_CAMERA_CONFIG_CHECK=1 OCCLUDE_PERSISTENCE_CHECK=1 pnpm --filter occlude-studio exec node tools/verify-scenes.mjs
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-adoption.mjs
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/benchmark-three.mjs
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/benchmark-studio.mjs
```

`verify-scenes`' optional flags are essential for the construction/camera/persistence assertions. Final reports are in [playwright-final](playwright-final/report.json), including construction.json, camera-commit.json, camera-config.json and persistence.json. [Final adoption](playwright-final-adoption/report.json) checks late obsolete replies. The lab page is only a computation harness for precision/robustness/benchmarks; actual UI behavior is tested in main Studio. Expected empty-store API 404s are recorded separately; no page errors occurred. Demo verification commands are in demos/README.md.

Blender 5.2.1 LTS is a pinned development reference, not built from source or needed at runtime. [Reference setup, checksum, sparse source and licensing](reference/README.md). All eight intended Line Art coverage fixtures match; six Freestyle fixtures match and two crossing-box cases differ. Independent rays support keeping Occlude's output; Freestyle's internal cause is not established. [Exact differences](reference/FREESTYLE.md) remain explicit, including intentionally failing strict comparator reports.

## Feedback to revisit

- **Camera controls:** overwriting the camera and rerunning a sketch is a valid workflow. Discuss the user's further control ideas together. The retained Commit view restriction on eager fixed projected strokes remains; `drawing3` retains their interpretation.
- **Crease tolerance:** the user caught inconsistent ground-grid lines. Numerical false creases were fixed in `0c6b91c`; those lines should have been caught before their report. Discuss a user-controlled artistic crease tolerance separately.
- **Hatch/intersections:** Krbn-style curvature-following hatch and box-box intersection curves remain post-M5.
- **Recovery:** worker restart and GPU device-loss recovery are explicitly deferred; the user accepts reloading the page. These are not passing recovery checks.

Original production tracked files remain at `c705cdeb`, original container IDs/start times are unchanged, and task stores/mounts are separate. This task did not modify production data, restart/deploy production, or connect a plotter. The unrelated untracked `mango.jpeg` in the original tree is preserved. This is a task-isolation statement, not a claim that external users could not change live data during development.

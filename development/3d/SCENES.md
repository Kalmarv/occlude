# Deferred scenes in Studio

`lineArt3` captures editable surfaces, wires, camera and line-set options as a deferred drawable. It is a member of the ordinary `Tree`, including arrays/groups/clips. Synchronous compilation diagnoses async rendering as required. `compileSketchAsync` resolves scenes before emitting any returned drawing; headless resolution uses the existing CPU geometric reference unless the host explicitly provides `compute3`.

Resolution projects into the execution's drawable paper rectangle by default. An explicit viewport is absolute paper mm. The adapter calls the established inverse paper-to-user mapping before creating ordinary protected strokes. This keeps margins, origin and yUp handling at the single existing recording boundary. Group transforms affect the resulting 2D strokes, and paper clips/masks/order apply through the existing emitter. No opaque face masks are synthesized.

Each execution owns a `scenes3` map of captured scene values to classified results. Repeated placement of the same value reuses visibility in that run. Scene geometry and configuration are captured at construction; callbacks remain caller-owned code and must be pure functions of feature rows. This does not claim cross-run style/model/camera caching.

`GpuSceneCompute3` is an explicit host resource. Construction/import does not request an adapter; the first classification does. It shares one interval device/pipeline across requests, recreates after loss only for the next explicit request, and disposes safely after pending initialization/work. Studio's existing serialized render worker supplies this resource automatically. There is no silent CPU fallback in Studio. Its reply includes adapter and per-scene compute diagnostics.

Public exports now include the scene factory/types, camera types, surface/box factories, feature flags and line-set types. The topic page `docs/three.md` has live orthographic overlap/label and perspective visible/hidden selection examples. Both also run through the headless CPU docs checker and ink oracle.

Evidence:

- `three-scene.test.ts`: actual vector output equality for letterboxed margins, top-left/center origins, yDown/yUp, repeated placements, group transforms, explicit perspective viewport and paper clipping; captured input mutation and cancelled result rejection.
- `tools/verify-scenes.mjs`: direct Playwright on NVIDIA hardware. Two public sketches render through the docs worker; opening the crossing-box example in the main Studio renders again on the worker GPU. Export requests use that worker's cached plan and write an SVG. Main-thread adapter requests remain zero. See `playwright-scenes`.
- Earlier 2D docs ink stays unchanged; two 3D example hashes are added explicitly.

Still pending: GPU modeling/query operations on the bound toolkit, generic 3D selections/instances/point clouds, ordered stroke phase/modifier completion, M4 hatch and plane sections, main Studio camera/viewport/persistence/caching, and M5 performance/reference/handoff requirements. Box-to-box intersection curves remain beyond M5.

The final isolated dev image passes full `pnpm check`: Rust 11.1s, TS 21.1s, library types 5.4s, Studio types 5.1s, docs 12.8s, ink 14.4s, build 36.0s, smoke 2.2s. WASM is unchanged (`c21c4ef21cb4091b6019b1aa440f6bea`). The church regression is unchanged at seed 42: 15,601 chains, 96,037 mm drawing, 16,515 mm travel, 381.0 minutes (task-local before/after logs).

The served-bundle Playwright report also records existing preview-host 404s for `/api/pens`, `/api/papers`, and `/api/plot-progress`. The tested docs-to-Studio flow explicitly carries its captured docs pens/paper settings; this is not evidence for persistent user-library or machine-service integration on Vite preview. No production or plotter service was contacted.

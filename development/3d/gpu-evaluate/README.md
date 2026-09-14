# GPU surface evaluation (fork C slice, 2026-09-14)

Batched evaluation of surface locations for M7 tone/hatch work. Not yet
consumed by `t.hatch`; the main slice integrates it. Not browser-verified here.

## API

- `packages/occlude/src/three/surface/evaluate.ts`
  - `packSurfaceTarget3({surface, placement?, uvAttribute?})`: placed vertices
    (9 f64/triangle), geometric normals with the same edge-scaled cross rule as
    `surfaceLocation3` and mirror flip (3 f64/triangle), per-corner UV
    (6 f64/triangle, present only when every corner has a finite pair). Weakly
    cached on the surface snapshot, at most 4 placement/column configurations.
  - `evaluateSurfaceCpu3(target, batch, recipe?)`: reference; direct array
    computation, `stats.backend === 'cpu'`.
  - `evaluateLocation3` (single location, shared by GPU fallback) and
    `validateEvaluationBatch3`.
  - `ambiguousTone3(tone, thresholds)`: indices within `TONE_QUANTUM` (2^-10)
    of their threshold, per `decideTone3`.
- `packages/occlude/src/compute/webgpu/surfaceEvaluate.ts`: `GpuSurfaceEvaluation3`
  (`create(device, target, {memoryBudgetBytes?, batchSize?})`, `evaluate(batch,
  recipe?, {signal})`, `dispose()`).
- `SceneCompute3.evaluateSurface?(target, batch, recipe, {signal})` in
  `three/scene.ts`, implemented on `GpuSceneCompute3` with the same bounded
  target policy as surface queries (4 most recent packed targets, half the
  memory budget retained, oversized target occupies the cache alone; cleared
  on device recreation and dispose).

## Device layout and accounting

| Buffer | Layout | Bytes |
| --- | --- | --- |
| Triangle (storage, once per target) | a,b,c vec4f (xyz normalized by target origin/scale), n vec4f, uv a.xy b.zw, uv c.xy pad | 96 per triangle |
| Location (storage, per batch) | tri u32, w0 w1 w2 f32 | 16 per location |
| Result (storage + staging, per batch) | position vec4f, normal vec4f, (u, v, tone, 0) | 48 per location, counted once in `transferBytes` |
| Params (uniform) | direction.xyz + ambient; image width/height; kind and flag words | 48 per call |
| Pixels (storage) | packed RGBA u32, prefiltered on CPU | 4 per pixel, uploaded once per recipe per session; a 4-byte dummy binds when no image |

Batch cap: `min(batchSize ?? 16384, (budget - target bytes) / 112,
maxStorageBufferBindingSize / 48, maxComputeWorkgroupsPerDimension * 64)`.
`stats.transferBytes` = location upload + result readback (+ pixels/params);
`stats.targetUploadBytes` is the triangle upload on a cache miss;
`stats.dispatches` counts batches; `stats.refinements` counts locations the
CPU reference evaluated instead (non-finite packing, coordinates beyond 1e6
after normalization, model-space light recipes, image recipes without a chart,
or a CPU-only target). Phases use `PhaseClock3`; cancellation is checked before
each batch and after each readback; a disposed session rejects.

## Agreement contract

GPU output is f32. The shader implements the tone module formulas literally:
light `1 - (ambient + (1-ambient) * ramp(max(0, n·L)))`, smooth ramp
`c²(3-2c)`; image bilinear between pixel centers after wrap (clamp/repeat) and
origin flip (bottom-left default), channel lum 0.2126/0.7152/0.0722, dark
`1-lum`, a = alpha, divided by 255 after weighting. Normals are computed on the
CPU in f64 and uploaded, so light tone differs from the reference only by f32
rounding of the dot product and ramp. Decisions against a threshold use
`decideTone3`; anything within `TONE_QUANTUM` is re-evaluated by the CPU
reference (`ambiguousTone3`), so backends agree on every accept/reject.
Positions are normalized by the target extent before upload and restored on
readback; expect ~1e-7 relative error, never used for support or visibility.

## Verification status

- `test/three-surface-evaluate.test.ts`: 6 passing CPU tests (placed, mirrored,
  nonuniformly scaled box and torus against `surfaceLocation3`; light tone
  identical to `lightTone3` after f32 rounding; image identical to
  `imageValue3` on the same double-precision UV; model-space light; malformed
  batches; missing chart with an image recipe; ambiguity helper). One GPU test
  skips under Node (no `navigator.gpu`).
- Not verified without a browser: shader compilation on a real adapter, the
  f32 agreement bound, batch splitting above the cap, cache eviction timing,
  cancellation mid-batch. To verify in Studio: run a `sketchAsync` sketch in
  the served bundle with Playwright (see `surface-uv/verify-live.mjs`), call
  `compute3.evaluateSurface` through whatever toolkit binding the main slice
  adds, and compare its `tone` array with `evaluateSurfaceCpu3` on the same
  batch: every `|gpu - cpu| < TONE_QUANTUM`, `stats.backend === 'gpu'`,
  `stats.dispatches === ceil(n / cap)`, nonfallback adapter. The vitest GPU
  case can also be run under a browser-mode vitest runner if one is configured.

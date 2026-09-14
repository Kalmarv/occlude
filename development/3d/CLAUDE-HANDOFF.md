# Claude handoff — M6/M7/selected-M8 surface drawing and progressive rendering

Prepared 2026-09-14/15 (Claude Fable 5.1), continuing the Codex handoff of the
same day. Read with **[3dpt2.md](3dpt2.md)** (the assignment) and
[M6-M8-PROGRESS.md](M6-M8-PROGRESS.md) (checkpoint log).

## 1. State and isolation

- Worktree `/home/kalmarv/containers/occlude-3d`, branch `feat/3d-webgpu`,
  pushed to `origin/dev`. Starting commit this session: `bae1191`. Final
  commit: `dbae2ff` (pushed to `origin/dev`).
- Dev service: Compose project `occlude-3d`, container `occlude-3d-dev-1`,
  host port 5273, served stamp `bae1191-surface-final`. Stores under this
  checkout's `packages/occlude-studio/dev-store/` (`ivy.png` uploaded there
  through the asset API).
- Never work in `/home/kalmarv/containers/occlude` (production checkout). No
  production deploy, no plotter. Preserve untracked `development/3d/md`.

## 2. Delivered this session

| Area | Public surface | Code | Tests / evidence |
| --- | --- | --- | --- |
| Vector mapping | `mapSurface`, `await t.mapSurface`, `curves.place(instances)`, `frame`, `chart`, overlap `layer` | `three/api/mapping.ts`, `three/curves/chartClip.ts`, `chartIndex.ts`, `three/api/supported.ts` | `three-mapping.test.ts`, `three-chart-clip.test.ts` |
| Image chart bridge | `t.image(name).surface({channel, origin, wrap, area, uv})` | `imageAsset.ts`, `three/surface/tone.ts` | `three-surface-image.test.ts` |
| Surface fields | `light`, `gradient`, `curvature`, `across`; `tangentU/tangentV` | `three/surface/fields.ts`, `three/geometry/curvature.ts`, `location.ts` | `three-curvature.test.ts`, `three-hatch-surface.test.ts` |
| Tracer and hatch | `trace`, `await t.hatch` (families, tone lanes, pens) | `three/surface/trace.ts`, `three/api/hatch.ts`, `three/modeling.ts` | `three-hatch-surface.test.ts` |
| GPU surface evaluation | `SceneCompute3.evaluateSurface`, CPU reference | `compute/webgpu/surfaceEvaluate.ts`, `scene.ts`, `three/surface/evaluate.ts` | `three-surface-evaluate.test.ts`; served: light recipes evaluated on the RTX 2060 |
| Isolines | `isolines(mesh, field, {levels})` | `three/curves/isolines.ts`, `three/api/isolines.ts` | `three-isolines.test.ts` |
| Connected extrusion | `mesh.extrude(faces, offset, {key})` | `three/geometry/extrude.ts`, `three/api/mesh.ts` | `three-extrude-region.test.ts` |
| View pens | generated marks drawn in their `stroke` attribute's pen | `three/api/view.ts` | docs examples |
| Docs | `docs/three.md` ordinary-first, nine new live examples (three#19–27) | `surface-drawing/ink-change.json` | 258 examples in the ink fixture |
| Progressive rendering | `draft` channel: stage pictures, modeling progress, disposable preview layer | `three/resolve.ts`, `api.ts`, studio `runner/render-worker/workerClient/preview/main.ts` | `three-stage-events.test.ts`, `workerClient.test.ts`, `progressive/live` |

Contracts, limits and the corrections made after the first served check are
in [surface-drawing/README.md](surface-drawing/README.md); progressive design and
implementation notes in [PROGRESSIVE-RENDERING.md](PROGRESSIVE-RENDERING.md);
performance in [benchmark-surface/README.md](benchmark-surface/README.md).

Dev sketch store demos: `mapped-stripes`, `rest-motif`, `field-ingredients`,
`tonal-hatch`, `curvature-crosshatch`, `image-tone`, `scalar-isolines`,
`diffused-extrusion`, `two-views` (plus the earlier `crossing-forms`,
`sampled-seams`, `rest-coordinates`). Sources under `surface-drawing/demos/`.

### API ergonomics batch (after camera controls)

The owner's API review (`api-3d.md`, untracked) approved items 1, 2, 4, 6, 7,
8, 9, 10, 11, 17, 18; all built, documented on `docs/three.md`, tested in
`test/three-api-ergonomics.test.ts`, evidence in `api-ergonomics/README.md`
(what changed, the ink mapping for three#21/#23, the TypeScript finding that
keeps the steps shorthand object-only). `OPTIMIZATION-BRIEF.md` is the brief
for the planned 3D performance pass by another agent.

## 3. Verification

- Docker verified build (`surface-drawing/build.log`): all nine gates.
- Served Studio, NVIDIA adapter, nonfallback, no Monaco diagnostics, SVG paths:
  `surface-drawing/live/report.json` (three#19–27, screenshots inspected),
  `progressive/live/report.json` (stage order, replacement, mid-render draft
  screenshot), `benchmark-surface/gpu.json`.
- Church routing unchanged; other docs pages byte-identical.

## 4. Still open from 3dpt2.md

- Broader M6 rendered-seam evidence (oblique, near/far clipping) beyond the
  crossing-forms example and the intersection oracles.
- Studio A–E workflow pass beyond served example checks: save/download/reopen
  of a hatched result, orbit/commit per view of the two-views demo.
- Final requirement-by-requirement audit table.
- Performance: a dedicated optimization pass (user: "deepseek"). Measured
  this session (`benchmark-surface/README.md`, `surface-drawing/README.md`):
  the tracer is CPU-bound (occupancy test, location objects); 3D visibility
  on dense scenes is bound by candidate streaming, packing, readback and
  finalize even after refinement was cut from ~100% to 30–80% of candidates
  (blanket rational refinement removed, endpoint-touch pairs certified empty,
  watertight seams closed, depth-cutoff pruning). The user's woven-vessel
  sketch (35k features against 33k triangles with hidden lines) still exceeds
  the 60 s Studio watchdog: 20 s exact on the CPU reference. First things to
  try: stream candidates in typed arrays instead of per-pair objects, split
  classification across workers per feature range, and decide clearly
  separated pairs entirely on the GPU. Tile/multi-core WASM finish is a core
  redesign; planning is global.
- Explicitly deferred: M9, inset/bevel/smooth subdivision, full UV unwrap,
  suggestive contours, automatic device recovery, author pre-view checkpoints
  and per-feature draft chunks.

## 5. Workflow reminders

Same as before: `pnpm check` is the definition of done; deliberate ink changes
re-save `packages/occlude/test/fixtures/docs-ink.json` in the same commit with
a mapping; Docker build with a traceable `OCCLUDE_BUILD_STAMP`, `up -d dev`,
then Playwright from `packages/occlude-studio` with `DISPLAY=:93` (Xvfb `:93`
was started this session; check `xdpyinfo -display :93`). Asset uploads:
`PUT /api/assets/<name>` with the bytes; responses are `no-store`.

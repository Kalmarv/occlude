# Surface drawing checkpoint (M7 mapping, tracing, tone, hatch, isolines; selected M8 extrusion)

Base commit `bae1191` (dev). Dev-only build stamps `bae1191-surface-drawing` (first served check, examples 19–22), `bae1191-surface-progressive` (docs fixes, ninth example, progressive drafts; progressive served check) and `bae1191-surface-final` (tracer fixes, zero-width phase contract, final served checks and GPU benchmark).
No production deployment, no plotter operation.

## Delivered in this checkpoint

| Area | Public surface | Implementation | Tests |
| --- | --- | --- | --- |
| Vector mapping | `mapSurface(mesh, material[], {uv, chartAttribute, chart, frame, budgets})`, `await t.mapSurface(...)`, `curves.place(instances)` | `three/api/mapping.ts`, `three/curves/chartClip.ts`, `three/curves/chartIndex.ts`, `three/api/supported.ts` | `test/three-mapping.test.ts` (12), `test/three-chart-clip.test.ts` (4) |
| Image chart bridge | `t.image(name).surface({channel, origin, wrap, area, uv})` | `imageAsset.ts`, `three/surface/tone.ts` | `test/three-surface-image.test.ts` (3) |
| Surface fields | `light`, `gradient`, `curvature`, `across`; `tangentU/tangentV` on locations | `three/surface/fields.ts`, `three/geometry/curvature.ts`, `three/geometry/location.ts` | `test/three-curvature.test.ts` (7), `test/three-hatch-surface.test.ts` |
| Tracer | `trace(mesh, seeds, direction, {step, ...})` | `three/surface/trace.ts`, `three/api/hatch.ts` | `test/three-hatch-surface.test.ts` (13) |
| Seeded hatch | `await t.hatch(meshOrInstances, {direction, spacing, tone, stroke, families, ...})` | `three/api/hatch.ts`, `three/modeling.ts` | same |
| GPU surface evaluation | `SceneCompute3.evaluateSurface` (host), CPU reference `evaluateSurfaceCpu3` | `compute/webgpu/surfaceEvaluate.ts`, `compute/webgpu/scene.ts`, `three/surface/evaluate.ts` | `test/three-surface-evaluate.test.ts` (6 CPU, 1 browser-only) |
| Scalar isolines | `isolines(mesh, field, {levels})` | `three/curves/isolines.ts`, `three/api/isolines.ts` | `test/three-isolines.test.ts` (7) |
| Connected extrusion | `mesh.extrude(faces, offset, {key})` | `three/geometry/extrude.ts`, `three/api/mesh.ts` | `test/three-extrude-region.test.ts` (8) |
| View pens | `view` default drawing groups generated marks by their `stroke` attribute | `three/api/view.ts` | docs examples 22, 25 |
| Docs | `docs/three.md` reorganised ordinary-first; new sections for all of the above; explicit-scene material moved to the end | `ink-change.json` maps every new key to its old key | 36 page examples (nine new: three#19–27), 258 total |

## Contracts and limits (honest statements)

- Mapping is exact for straight pattern segments on the represented triangles.
  Curved motifs are the polylines the caller supplies; their flattening is
  the 2D conversion's own count/spacing/tolerance. `frame` is the only
  conversion from sketch units to chart units.
- Same-component chart overlap yields numbered `layer` chains; overlapping
  islands (distinct charts) each receive the pattern; `chart` selects one.
  Float `range` values are phase metadata kept strictly increasing per chain
  by ulp bumps when a binary64 sliver rounds to zero width.
- Tracing walks actual adjacency; direction is transported across each edge;
  loops close exactly only when the trace returns inside its start triangle,
  otherwise they stop open within `loopDistance`. `maxLength`/`maxSteps` apply
  per direction from a seed.
- Spacing is surface (world) distance with a Jobard–Lefer occupancy test
  guarded by connected component, normal agreement (60°) and tangent slab. It
  is not geodesic distance; equal spacing is approximate on strongly curved
  regions and across seed-tree boundaries (lines can approach 0.5 spacing).
- Tone selects lanes in nested octaves (`laneThreshold`): density is quantized
  to powers of two of the base spacing; a segment draws when both ends exceed
  the lane threshold. This is a tonal approximation, not reflectance.
- Curvature is an estimate on the polygon mesh (Rusinkiewicz-style tensor,
  angle-weighted, no averaging across creases above `creaseDegrees`);
  confidence below `minConfidence` reports no direction.
- Light recipe: `illumination = ambient + (1-ambient)*ramp(max(0, n·L))`,
  geometric normal, world by default; tone is its complement. No camera light.
- Image recipe: prefiltered once (box half-size `area` in chart units), bilinear
  between pixel centers, clamp/repeat, bottom-left origin by default, integer
  Rec. 709 luminance so white is exactly 1.
- GPU tone evaluation is f32; decisions within `TONE_QUANTUM = 2^-10` of a
  threshold are settled by the CPU reference, so CPU and GPU agree on which
  lanes draw. Byte identity across backends is not claimed.
- Isolines are exact for the linear interpolant of per-corner values;
  refinement is mesh subdivision; seams keep separate chains.
- Extrusion: one vector per connected component; caps keep IDs/attributes/UVs;
  walls on every region boundary edge; walls get `key:side:<component>` charts;
  self-intersection is not detected.

## Verification

- Library tests: see `tests.log`. Church routing unchanged (`church.log`).
- Docker verified build (`build.log`) runs all nine gates.
- Served Studio check with the NVIDIA adapter: `live/report.json`, one
  screenshot and SVG per example (`live/example-<n>.*`).
- Dev sketch store demos saved and read back: `deployment.json`.

## Corrections after the first served check

- Float phase ranges: a source interval narrower than binary64 (a corner a few
  ulps off a chart diagonal) now keeps a zero-width float range; the graph
  validator orders equal starts by end and consumers scale by the width. The
  earlier ulp-nudging was removed.
- Tracer: a direction that converges onto a vertex (a gradient sink at a
  sphere pole) stops as `degenerate` after three zero-length exits instead of
  bouncing across the fan until `maxSteps` (14.9 s to 1.2 s on the sphere
  meridians; identical output).
- Tracer cost: per-triangle geometry cached in surface locations, lazy
  attribute interpolation, side-seed walks run blind (no location built),
  allocation-free occupancy test (torus crosshatch 23.8 s to 8.2 s; the
  crosshatch workload 54 s to 6.4 s). A full optimization pass is planned
  separately by the user.
- Docs: tonal example lit from above with a tone floor; sphere fields example
  added; two-views inset framed and clipped deliberately; asset responses are
  `no-store` so an edge cannot keep serving a pre-upload 404.

## Visibility and capacity changes (same session, after the user's vessel sketch)

- Candidate generation now prunes by camera depth: an occluder whose nearest
  point is farther than a feature's farthest point cannot hide it under either
  projection (`visibility/index.ts`, `depthCutoff3`, with a rounding envelope so
  exact-incidence cases stay). Woven vessel (35k features, 33k triangles) on
  the CPU reference: 3.77M to 2.26M pairs, 29 s to 20 s; all 36 3D docs
  examples byte-identical.
- GPU refinement: hidden intervals of two edge-adjacent triangles of one
  object that abut end-to-start within the tolerance are closed at their seam
  instead of both being re-evaluated exactly (`refinementTargets3`). Their
  occlusion is watertight across the shared edge, so no real gap exists there;
  a gap narrower than the paper tolerance across such an edge is not preserved,
  which is within the existing interval budget. Unrelated abutments and every
  other near endpoint are still refined exactly.
- Capacities: every count/byte budget option now defaults to unlimited
  (`Infinity`); explicit caps still throw before allocation. Kept: the exact
  coordinate bit guard, GPU memory/batch limits, scatter `maxAttempts` and the
  trace `maxLength` termination. Tests that relied on default caps pass them
  explicitly.
- GPU interval session: the earlier blanket CPU refinement of every pair with a
  rational basis (all supported curves) is removed; those pairs use the same
  f32 certificate as mesh edges. The shader certifies a pair empty when one
  endpoint lies on an occluder plane within its error and the other is
  certainly outside, provided the sliver it could hide is shorter than the
  parameter tolerance (`intervalShader.ts`). Refinement fell from ~100% to
  30–80% of candidates; see `benchmark-surface/README.md`. Correctness rests on
  the existing certificate contract; the served example set renders correctly
  on the NVIDIA adapter, but there is no byte oracle for the GPU path.

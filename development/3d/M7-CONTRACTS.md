# M7/M8 parallel-slice contracts (2026-09-14, Claude)

Shared rules for slices implemented in parallel in this checkout. Every slice
reads `3dpt2.md`, `CLAUDE.md`, `SURFACE-CONTRACT.md` and `CLAUDE-HANDOFF.md`.

## File ownership (do not edit files another slice owns)

| Slice | Owns | Must not edit |
| --- | --- | --- |
| Mapping/tracing/hatch (main) | `three/api/mapping.ts`, `three/curves/chart*.ts`, `three/surface/*` (tone.ts exists), `three/api/index.ts`, `src/api.ts`, `three/modeling.ts`, `imageAsset.ts`, `docs/three.md`, ink fixtures | — |
| Connected extrusion (fork A) | new `three/geometry/extrude.ts`, `Mesh.extrude` method in `three/api/mesh.ts` (append only), new test `test/three-extrude-region.test.ts`, `development/3d/extrusion/` | index.ts, api.ts, docs |
| Curvature (fork B) | new `three/geometry/curvature.ts`, new test `test/three-curvature.test.ts`, `development/3d/curvature/` | everything else |
| GPU surface evaluation (fork C) | new `three/surface/evaluate.ts` (CPU reference), new `compute/webgpu/surfaceEvaluate.ts`, `three/scene.ts` (extend `SceneCompute3` only), `compute/webgpu/scene.ts` (add the method + bounded cache), new tests, `development/3d/gpu-evaluate/` | tone.ts formulas (read only), location.ts, api.ts, docs |

Tests run with `pnpm --filter occlude exec vitest run test/<file>` from the
checkout root; typecheck with `pnpm --filter occlude typecheck`. Do not run
Docker, deploy, commit or push: the main slice integrates and commits.

## Surface context

Fields over a surface receive a `SurfaceLocation3` (`three/geometry/location.ts`):
`position`/`normal` (world when placed, else model), `modelPosition`/`modelNormal`,
`uv`, `chart`, `tangentU`/`tangentV` (unit, world, absent without a regular chart),
`pointAttributes`/`faceAttributes`/`cornerAttributes`, `triangle`, `barycentric`.

## Tone (`three/surface/tone.ts`)

0 = light, 1 = dark. Built-in recipes are data (`LightRecipe3`, `ImageRecipe3`);
`lightTone3(normal, recipe)` and `imageValue3(uv, recipe)` are the CPU reference
formulas. Light: `illumination = ambient + (1-ambient)*ramp(max(0, n·L))`,
`tone = 1 - illumination`, geometric normal, world space by default. Image:
prefiltered pixels, bilinear between pixel centers, `origin` bottom-left by
default (v up), `wrap` clamp or repeat, channel lum/dark/a. Decisions compare
tone with a threshold under `decideTone3`: within `TONE_QUANTUM = 2^-10` the
decision is ambiguous and is settled by the CPU reference. GPU output is f32;
agreement is required within that quantum, never byte identity.

## GPU surface evaluation (fork C)

```ts
interface SurfaceEvaluationTarget3 { surface:Surface3 /* snapshot */; placement?:SurfacePlacement3; uvAttribute?:string; chartAttribute?:string }
interface SurfaceEvaluationBatch3 { triangle:Uint32Array; weights:Float32Array /* 3 per location, sum 1 */ }
interface SurfaceEvaluationResult3 { position:Float32Array; normal:Float32Array; uv?:Float32Array; tone?:Float32Array; stats:{ backend:'cpu'|'gpu'; dispatches:number; transferBytes:number; cacheHit:boolean; targetUploadBytes:number; timings:PhaseTimings3 } }
evaluateSurfaceCpu3(target, batch, recipe?) : SurfaceEvaluationResult3   // reference, same formulas as location.ts geometricNormal + tone.ts
class GpuSurfaceEvaluation3 { static create(device, target, recipe?) ; evaluate(batch, {signal}) ; dispose() }
SceneCompute3.evaluateSurface?(target, batch, recipe, {signal}) : Promise<SurfaceEvaluationResult3>
```
Pack triangle vertices (placed), per-corner UV, per-triangle normal on the
device once per target (bounded LRU of 4 targets, byte budget shared with the
existing query-target policy). Many locations per dispatch (batch cap like
queries). Image recipes upload the prefiltered pixels as a storage buffer or
texture. Report phase timings with `PhaseClock3`. Cancellation between batches
via the signal; a disposed session rejects. Non-finite or out-of-range packing
falls back to the CPU reference per location and counts as `refinements`.

## Curvature (fork B)

```ts
estimateCurvature3(surface:Surface3, options?:{ smoothing?:number; creaseDegrees?:number }) : CurvatureEstimate3
curvatureAt3(estimate, triangle:number, barycentric:Vec3) : { min:Vec3; max:Vec3; kMin:number; kMax:number; confidence:number }
```
Per-vertex principal curvatures/directions estimated from the represented
triangles (Rusinkiewicz-style per-triangle tensor from vertex normals, area
weighted at vertices; vertex normals angle-weighted; no averaging across edges
whose dihedral exceeds `creaseDegrees`, default 60; boundary vertices use their
one-sided ring). Directions are unoriented lines: interpolate by aligning each
vertex direction's sign with the first vertex before weighting, then project
onto the triangle plane and re-orthogonalize. `confidence` in [0,1] grows with
anisotropy `|kMax-kMin| / (|kMax|+|kMin|+eps)`; umbilic/flat regions report
near 0. Document neighbourhood, weighting, smoothing, boundary and crease
policy in the file header; tests use sphere (umbilic), cylinder (kMax ≈ 1/r
around, min along axis), plane (zero), torus and a saddle.

## Connected extrusion (fork A)

`mesh.extrude(faces, offset, options?)` on `Mesh`:
- `faces`: a `MeshFaces` selection of THIS mesh revision (same check as `MeshEdit`).
- `offset`: `Vec3 | ((region:ExtrudeRegion)=>Vec3) | { distance: number | ((region)=>number) }`;
  `ExtrudeRegion = { index:number; faces:MeshFaces; normal:Vec3 (area-weighted mean, unit); center:Vec3; area:number }`.
  `distance` requires a well-defined region direction (mean normal length before
  normalisation ≥ 0.5 of the area sum); otherwise an error names the region.
- One vector per connected component (`faces.components()`); zero vector on any
  component is an error naming it; negative/reversed vectors recess.
- Cap: the selected faces translated, retaining face IDs, corner IDs, corner
  attributes (UV included), face attributes and fixed triangulation. Interior
  region points (all incident faces selected) move; boundary points are
  duplicated with IDs `JSON.stringify(['extrude', key, 'point', pointId])` and
  copied attributes; the original stays with the unselected faces.
- Walls: one quad per region boundary edge (exactly one selected incident
  face), including open mesh boundary edges and hole loops; wound so the wall
  faces outward relative to the selected face's orientation. IDs
  `['extrude', key, 'side', edgeId]`. Face attributes copied from the incident
  selected face; corner attributes copied from that face's corners at the shared
  vertices, then if a `uv` corner column exists: `uv = [loop arclength fraction, 0|1]`,
  `chart = key + ':side:' + componentIndex` (only when a `chart` column exists).
  Provenance `{operation:'extrude', parents:[...]}` on new points/faces/corners.
  Do not add `role`/`parentFace` attribute columns.
- A selected component with no boundary edge (closed shell) is an error that
  suggests `translate`. `key` option (default `'extrude'`) makes generated IDs
  stable; a second extrusion with the same key on already-generated IDs must
  still be unique (assembly throws on duplicate IDs; include the mesh iteration
  or throw a clear error).
- Keep `extrudeFaces3` (independent) unchanged.

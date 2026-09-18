# occlude architecture

This documents how the implementation actually fits together and where
each responsibility lives. What is measured, still open, or deliberately
parked lives beside it in [Working notes](#/notes); the design laws are in
`CLAUDE.md` at the repository root.

## The one-sentence model

The plotter is a canvas whose pixel is the pen nib: later opaque shapes
overwrite earlier ones, but the "framebuffer" is a list of vector fragments
and overwriting is done analytically — every cut lands at a true intersection
parameter on the original curve, and flattening happens only at export.

The engine's whole job is ink physics: **it decides what survives to paper,
never what gets drawn.** Patterns, textures, and scalar fields are
sketch-space JS.

## Where things live

```
crates/occlude-core/src/
  vec2, bbox            primitives of the primitives
  primitive             Line / Arc / Cubic: eval, split, bbox, normalise
                        (cusp splitting, colinear-cubic demotion)
  poly                  root finding: Cardano+Newton (cubics),
                        Bernstein subdivision (degree ≤ 6)
  intersect             the pair matrix; coincident overlaps return the other
                        primitive's endpoint projections as split points
  region                contours + winding rule; y-monotone ray casting with
                        a welded chain; O(1) circle fast path; on_boundary
  clip                  split/classify a span partition against one region
  cleanup               nib-width rules (tap/coverage), merge, seam dedupe
  fill                  FillKind (Pending / Custom / Mask) and SuppliedFill —
                        the engine generates NO patterns
  modifier              the modifier tape (pre/post stages) and field grids
  index                 uniform grid; BVH when occluder sizes vary wildly
  pipeline              prepare() → Prepared → finish(): the two passes,
                        rayon-sharded by shape on native
  synth                 synthetic supplied ink for benches, stress scenes and
                        property tests — benchmark input, never a fill
  scene::dump           loads a dump-scene directory (buffers + JS fills
                        sidecar) for replay and the golden test
  plan, fragment        chain merge → nearest-neighbour + 2-opt tour →
                        bridging: the ordered DrawingPlan and its bytes
  gcode, profile        G-code per pen from a plan range; machine profile
  svg, raster           exact-curve SVG; PNG raster export
  snap                  the 0.005 mm input grid
  scene                 the buffer protocol (all strides documented at the top)
  wasm_api              thin bindgen wrappers: wasm_prepare / wasm_finish +
                        exports

packages/occlude/src/
  units, matrix         L values (percent/w/h/long/mm), affine transforms
  execution             ONE object per run (no module-level sketch state
                        anywhere): the inputs a host resolved — paper, the
                        captured pen library, seed, assets, fills — the
                        sketch's declared paper/pens/margin, the recording
                        (shapes, clips, stacks), the seeded streams and
                        addressed draws, probes, inspections, plan and
                        draw requests; plus the pure `pen`/`paper` vocabulary
  api, shapes           the declarative API: sketch(), shape values, groups,
                        clips, modifiers; compileSketch records them. `origin`
                        is the pivot rotate and scale turn about (`'center'` is
                        the drawable's middle), threaded through composeChain as
                        T(o)·R·S·T(−o) and through the sketch-time conversions
  fillModule, fills     the fill contract (fillAsset, rulings) and resolution
  fills/*.ts            the built-in fill files (hatch, crosshatch, solid,
                        stipple) — ink-immutable, resolved from the package
  field                 Fields as augmented callables: rotate/translate/scale,
                        within (domain bounds), the vector-field rule
  record                resolve → lower → transform → snap (paper known here);
                        also the frame-less lowering within() uses
  render                scene encoding, fragment decoding, exports; the
  sceneBuffers,           primitive codec, the between-pass fill jobs, the
  fillJobs, wasmRender    two wasm calls and the prepared handle's lifetime,
  fieldGrid               engine field grids (plan, then evaluate)
  isolines, streamlines, sketch-time generators (marching squares, evenly
  points, distance      spaced streamlines, scatter/relax/settle, signed
                        distance); shaper: knot curves as functions
  material, vec, views, the material vocabulary: vertices with attribute
  steps, forces,          columns and an edge list (material), vectors,
  relation, query,        view identity, the edit batch, force recipes,
  faces                   selections and extraction, spatial edge queries,
                          planarization and faces
  plan, motion          the DrawingPlan as a value (selection, resolveDraw,
                        encode/decode), estimatePlanMs and the motion model
  boundary, material    the area contract and the trim: `loopCrossings` finds
                        where an edge crosses a loop (the cut point is taken on
                        the boundary edge, so an axis-aligned frame's ends land
                        exactly on it), `withinMaterial` cuts the outside away
                        and carries each cut vertex's columns by their declared
                        policy; `within` on the toolkit dispatches a field, a
                        material, a point selection or a face collection
  draw                  Canvas 2D preview (exact arcs/cubics, no flattening)
  docsExamples          DOC_PAGES and the live-fence settings shared by the
                        docs site and the checker

packages/occlude-studio/
  server.mjs            production server: dist + the store APIs
  sketch-store.mjs      /api/sketches, pens, profiles, plot log (.ts files);
  sketch-git.mjs          every save a commit, forks and snapshots as refs
  result-store.mjs      /api/results — saved selections: plan bytes, frozen
                        SVG, pens, paper, profile, provenance; immutable
  fill-store.mjs        /api/fills — the fill library (.ts files); /js strips
  fill-transpile.mjs      types with Node's built-in stripper (the ONE
                          transpile step for stored fills)
  asset-store.mjs       /api/assets — SVGs and images
  src/editor            Monaco + occlude types as extra libs; emit via the
                        TS worker (CommonJS) — the main thread never RUNS it
  src/render-worker     owns the whole sketch runtime: asset + fill capture,
  src/runner              one Execution per render (its hooks handed to the
                          module before it evaluates), `@user/pens` and
                          `@user/papers` served from the captured libraries,
                          encode, wasm, the retained plan and export state
  src/workerClient      coalescing render requests + the watchdog
  src/preview, panels   paper bench, sketch/fill libraries, pen tray,
                        paper/machine, plot, export
  src/drawing           the Drawing panel: reads the sketch's t.plan/t.draw
                        result; ghosts omitted ink in the preview only
  src/docs              the docs site: topic pages, inline editors, lazy
                        whole-drawable previews
  src/fillEmbed         export embedding + import reconciliation of fills
  src/store             localStorage persistence
```

## Build and verification

One toolchain, pinned in three files the tools read themselves:
`rust-toolchain.toml` (rustc 1.98.0 + the `wasm32-unknown-unknown` target,
honoured by rustup natively and in the image), `.node-version` (24.21.0)
and the root `package.json` `packageManager` field (pnpm 10.30.1). The
Dockerfile pins the rest: the `node:24.21.0-bookworm-slim` base image by
digest, wasm-pack 0.13.1 by release-tarball sha256, and the same three
versions as build args. To update: change the pin, rebuild, and let the
wasm gate tell you whether the crate's bytes moved (a compiler bump that
changes the wasm is an ink change to review, not a version bump to wave
through). The reference platform is linux/amd64; the build needs network
access to fetch crates, npm packages, rustup and wasm-pack.

The build order is the one the README gives a developer, because
`occlude-core` is a `link:` dependency on the wasm-pack output: crate
first, then `pnpm install --frozen-lockfile`, then the gates. The wasm is
built with the production feature set (`wasm,contour-sdf`, default
features off); a native `cargo test` runs with `parallel` on, so the two
are different builds of one source and the `wasm` gate is what ties the
bundle to the crate.

**Gate map** — `pnpm check` (`check.mjs`) prints one line per gate; the
Docker `verified` stage runs the identical command after building the wasm
from source, so the studio image exists only when every gate passed:

| gate | command | proves |
|---|---|---|
| rust | `cargo test -p occlude-core` | the engine's unit, property and golden-scene tests |
| ts | `pnpm -r test` | the library and studio vitest suites |
| types | `pnpm --filter occlude typecheck` | `src`, `tools` and `test` compile |
| studio | `pnpm --filter occlude-studio typecheck` | the studio compiles (vite only strips types) and `server.mjs` parses |
| docs | `docs:check` | every `ts live` fence on every topic page renders, with no ink outside the drawable |
| ink | `docs:hashes --check` | every fence renders the bytes in `test/fixtures/docs-ink.json` |
| build | `pnpm build` | the library emits declarations; the studio bundles |
| wasm | md5 in `check.mjs` | the bundled wasm is the crate's build, byte for byte |
| smoke | `pnpm smoke` | a sketch with an arc, a cubic, a contour-filled disc, a hatched rect and a mask renders through the compiled wasm to a parseable SVG (`tools/smoke.ts`); the production server, started on a free port, answers every page, module, worker and the wasm asset the bundles resolve, and the served wasm is the crate's (`tools/smoke-server.mjs`) |

Beyond the gates, the oracles a toolpath-affecting change consults by
hand: `plotstats church.ts --seed 42` (381.0 min, 16 515 travel mm at
0b661f7) and `renderhash --check` over the reference sketches.

**Reproducibility** here means a clean checkout with the pinned toolchain
produces a working build whose geometry is stable — the ink oracle and the
wasm gate are the proof. It does not mean byte-identical bundles: the
studio embeds a build stamp (commit + time) that the compose file passes
in as `OCCLUDE_BUILD_STAMP`, and the plan hash's `engine` field carries it,
so two builds of one commit agree on geometry and disagree on plan hashes
by design (compare geometry and settings separately when checking parity).

**Containers.** `docker-compose.yml` has two services: `studio`, the
verified dist behind `server.mjs` with the sketch, fill, asset and result
libraries bind-mounted from the checkout (one library, shared with a
native server), and `dev` (profile `dev`), vite over bind-mounted sources
from the same verified image — the seed of the eventual containerised dev
build. BuildKit cache mounts keep the cargo registry, the cargo target dir
and the pnpm store across builds, so a source change rebuilds only what
changed; `docker builder prune` returns to the cold path, which must still
pass. Nothing a developer's machine produced enters the context
(`.dockerignore`): no `pkg`, `node_modules`, `target`, `dist`, `.git`, the
studio's runtime stores, or the owner's local scratch directory.

## The render pipeline (two wasm calls, one runtime)

Everything from sketch execution to the second wasm call happens in ONE
runtime — the studio's render worker, or node for the tools. The main
thread owns the editor only: it emits TypeScript to JS and posts source +
config; results come back as buffers plus decode metadata.

1. **Execute + record (JS)** — the emitted sketch module runs; `sketch()`
   values are recorded with unresolved units and transform-chain
   snapshots. Assets and custom fills the source references (literal
   names) are preloaded first.
2. **Encode (JS)** — `encodeScene` resolves units, lowers to
   lines/arcs/cubics, applies transforms (arcs → cubics only if
   non-conformal), snaps everything to the 0.005 mm grid, rasterises
   modifier fields, and builds flat buffers. Filled shapes get a **fill
   job** (a closure — the scene never crosses a thread) and
   `fill_kind = Pending`.
3. **Pass 1 (Rust, `wasm_prepare`)** — pre-stage modifiers (smooth /
   roughen / deform), sort by z (draw index breaks ties), build regions and
   the occluder index, drop shapes fully inside a later region or fully off
   paper, mark shapes with no later overlap **clean**. Returns a `Prepared`
   handle plus each surviving filled shape's FINAL outline.
4. **Fills (JS)** — each fill job runs against its post-deform outline:
   `fill('name', params)` resolves a fill module (built-ins from the
   package, custom ones from the registry the host filled), inline
   closures run as-is. Randomness is a seeded sub-stream keyed by draw
   order. Output is marks: lines/arcs/cubics/polylines/dots — encoded as
   **chains** (a polyline is one pen stroke) and dots.
5. **Pass 2 (Rust, `wasm_finish`)** — clip the supplied ink to its own
   region, then per primitive: query the index, cut against occluders
   front-to-back, early-outing when nothing is left; clip regions (and the
   paper rect) apply first with polarity inverted. The nib rule judges
   outline contours and fill chains WHOLE. Cleanup: sub-nib pieces become
   tap candidates that exact ink coverage resolves; merge same-origin
   runs; drop coincident duplicates (shared snapped edges draw once).
   Post-stage modifiers (decimate / wobble / dash), bridging, fragments.

A render is atomic: requests coalesce on the main thread while one runs;
the watchdog (a wedged worker) is the only hard interruption. Pass 2 is
sharded by shape with rayon on native builds; generated fill primitives
carry provisional origins that a deterministic serial merge rebases, so
parallel output is bit-identical to serial.

## The 3D pipeline

3D resolves *before* the pipeline above runs. `compileSketchAsync` awaits the
sketch, classifies every captured scene, interprets each one as ordinary
strokes, and only then calls `emit` (`api.ts`, `three/resolve.ts`), so the
encoder sees 2D ink like any other. A synchronous `compileSketch` refuses a
sketch whose function returns a promise and names
`compileSketchAsync`/`renderAsync`: there is no way to await a scene inside
it. `docs/three.md` is the reference for the vocabulary; this section is the
machinery and the contracts.

```
packages/occlude/src/three/
  api/*                 the public vocabulary: mesh and primitives, curves,
                        view, hatch, isolines, mapping, intersections,
                        instances, sampling, prepared queries
  geometry/*            model, topology, corners, triangulation, curvature,
                        extrude, deform, location — and exact.ts, the
                        homogeneous BigInt kernel with its f64 sign filter
  features/snapshot     the immutable render snapshot: camera frame, source
                        segments with their phase, occluder triangles
  visibility/*          index (projected BVH + depth cutoff), scene
                        (candidate pairs, both classifiers, refinement
                        targets), interval / worldInterval (the hiding
                        test), precision (the paper-derived tolerance)
  curves/*              hatch rulings, isolines, plane sections, chart
                        clipping, the exact intersection network
  surface/*             tone, tangent fields, the tracer, the CPU surface
                        evaluator
  strokes/*             construct (classified runs → chained strokes) and
                        paper (strokes → recorded shapes)
  scene, resolve, timing  the captured scene, the resolve walk, PhaseClock3
  geometry/job          the task-yielding runner: 1024 checkpoints or ~8 ms
                        per slice, cancellable between them

packages/occlude/src/compute/webgpu/
  scene, surfaceEvaluate  the optional GPU host: batched surface/tone
  interval, intervalShader  evaluation, and the f32 interval classifier
                            (reference only — see "Exact classification")
```

### The four values, and who owns them

Editable geometry, an immutable render snapshot, a classified line drawing,
and the physical plot plan. Model geometry is CPU-owned f64 data: polygon
topology, stable semantic IDs, and point/edge/face/corner attributes;
derived triangulation retains face parentage. A render session owns its
camera, candidate index, GPU resources and classified intervals. **There is
no global active scene, camera or GPU job** — the classified result is
cached on the execution by scene (`exec.scenes3`), so line-set predicates
and styles reading the same scene never cause a second visibility dispatch.
Changing geometry, the camera or a candidate generator invalidates only the
dependent stages.

A mesh is an immutable owned revision. Rows carry a stable `id`, a local
`index` and a frozen `attributes` map; built-in row names (`id`, `index`,
`x`/`y`/`z`, `normal`, `center`, `area`, `a`, `b`, `length`, `points`,
`edges`, `faces`, `corners`, …) are reserved and rejected as attribute names
(`three/api/mesh.ts`). Selections retain their source revision and an editor
refuses a selection from another revision even when the IDs match; explicit
extraction is what makes an ownership change visible. Derived topology uses
compact deterministic IDs and records immediate parent IDs as provenance, so
allocation order, wall time and model RNG are irrelevant to identity.
Frozen passes (`.steps(n, (current, next, k), { every })`) read a frozen
input and accumulate edits exactly as 2D `Material.steps` does.

**Budget before allocation.** Every count and byte budget is validated and
throws before its first allocation, and **capacity options default to
`Infinity`** — the owner's decision after the surface-drawing session, which
removed every default cap. What keeps a finite default is a termination rule
or a device limit, not a capacity: the exact coordinate-bit guard
(`maxCoordinateBits` 32768 in `api/mapping.ts`), the scatter `maxAttempts`
(100 000 in `api/sampling.ts`), the isoline segment and node budgets
(250 000 in `curves/isolines.ts`), and the GPU memory and batch limits.

### Coordinates and the numerical boundary

World coordinates are right-handed with Z up. Camera space looks along
negative Z; near and far are positive distances. Projection maps depth to
WebGPU's [0, 1] range. Paper mapping uses an explicit drawable rectangle in
millimetres and reverses vertical direction at that boundary. **World units
never inherit paper units.**

CPU clipping precedes perspective division and retains the original
parameters and triangle parentage. Visibility classifies segment/triangle
occlusion half-spaces, unions the hidden intervals and complements them. A
conservative projected BVH with a camera-depth cutoff supplies bounded
candidate batches (`visibility/index.ts`): an occluder whose nearest point
is farther than a feature's farthest point cannot hide it under either
projection, with a rounding envelope so exact-incidence cases survive. There
is no large-scene all-pairs allocation.

The interval tolerance is derived from the physical frame, never fixed. The
execution supplies `paperToleranceMm = min(0.005 mm, narrowest resolved pen
width / 20)` — every resolved pen, because a cached classification may be
interpreted with another pen later in the same execution. Half of that
budget is allocated to interval reconstruction and half reserved for f64
projection arithmetic. `intervalTolerance3` divides it by the maximum
projected speed over all clipped features: orthographic speed is
`paperHeight / span * hypot(dx, dy)`; for perspective, with endpoint depths
`d0, d1 > 0`, the rational projection derivative peaks at the closer
endpoint, so the bound is the projected endpoint distance times
`max(d0,d1)/min(d0,d1)` scaled by the focal term. The result is capped at
the previous fixed `1e-5` so ordinary scenes cannot become coarser, and
overflow tightens it to the smallest positive f64 (which reaches WGSL as
zero, routing every uncertain cut to CPU refinement). `paperToleranceMm` and
`parameterTolerance` are both reported in the scene stats. This is a tested
working budget, not a numerical guarantee: the downstream 0.005 mm input
snap (`snap.rs`) displaces geometry by up to ~0.0035 mm in 2D and is a
separate, larger effect.

Source incidence is topological, never a distance hack. Only the incident
triangles on a mark's actual supporting placement are exempt from hiding it;
every other triangle on either mesh remains an occluder. Stored chart
coordinates stay attached through transforms and deformation, and a
topology-preserving rebind uses the retained identities and affine
coordinates rather than nearest-surface guessing. **No camera-space epsilon,
coordinate shift or blanket short-line suppression may replace source
incidence.**

### Exact classification: the CPU is the only classifier

`classifyForRun3` calls `classifySceneCpuJob3` unconditionally
(`three/resolve.ts`). The exact CPU classifier beat the GPU interval
classifier by 1.4× to 3.8× on every measured workload, because the GPU
classifies each pair in f32 and hands every pair its certificate cannot
settle back for exact refinement — 65 % of pairs on the heaviest workload —
so it paid the streaming, packing, dispatch and readback *and then* most of
the exact bill anyway. The numbers are in `docs/notes.md`.

`compute3` is still supplied by the Studio and still does GPU modeling
(surface and tone evaluation) and the construction viewport.
`classifySceneGpu3`, `compute/webgpu/interval.ts` and `intervalShader.ts`
remain in the tree as a reference backend: unexercised on the Studio path,
and able to disagree with the exact answer, which is a liability recorded in
`docs/notes.md` rather than resolved. `refinementTargets3`, the
watertight-abutment seam closing and `intervalTolerance3` exist to repair
f32 endpoints and therefore only do work inside that backend.

The exact kernel (`geometry/exact.ts`) is homogeneous BigInt arithmetic
guarded by a certified f64 sign filter: an f64 image of an exact 4-vector
divided by a positive power of two, with a running error bound, answering
±1 only when the f64 value provably exceeds its own bound and 0 — "ask the
exact arithmetic" — otherwise, including at zero. It introduces no
tolerance; it is Shewchuk's filter technique applied to the homogeneous dot
product. `at`/`plane` fully reduce (callers that key or compare a plane need
canonical values); `atScale`/`planeScale` strip only the common power of
two, which is projectively equivalent and cheaper.

### Surface tone and the GPU agreement contract

Tone is `0 = light, 1 = dark`. Built-in recipes are data: light is
`illumination = ambient + (1 - ambient) * ramp(max(0, n·L))` with a smooth
ramp `c²(3 - 2c)` and the geometric normal, world space by default, and tone
is its complement; image is prefiltered pixels, bilinear between pixel
centres, bottom-left origin by default, clamp or repeat wrap, and a lum /
dark / alpha channel with integer Rec. 709 luminance so white is exactly 1.

`decideTone3` compares tone against a threshold: within
`TONE_QUANTUM = 2**-10` (`three/surface/tone.ts`) the decision is *ambiguous*
and is settled by the CPU reference. GPU output is f32 and agreement is
required within that quantum — **byte identity across backends is never
claimed.**

### The GPU surface-evaluation buffers

Documented here on the same footing as the wasm strides, because it is a
protocol both sides must agree on (`compute/webgpu/surfaceEvaluate.ts`,
`three/surface/evaluate.ts`):

| buffer | layout | bytes |
|---|---|---|
| triangle (storage, once per target) | `a`, `b`, `c` vec4f normalized by the target origin/scale, `n` vec4f, corner UV as `a.xy b.zw` then `c.xy` + pad | 96 per triangle |
| location (storage, per batch) | `tri` u32, `w0 w1 w2` f32 | 16 per location |
| result (storage + staging, per batch) | position vec4f, normal vec4f, `(u, v, tone, 0)` | 48 per location |
| params (uniform) | direction.xyz + ambient, image width/height, kind and flag words | 48 per call |
| pixels (storage) | packed RGBA u32, prefiltered on the CPU | 4 per pixel |

Batch cap is `min(batchSize ?? 16384, (budget − target bytes) / 112,
maxStorageBufferBindingSize / 48, maxComputeWorkgroupsPerDimension * 64)`.
Packed targets are held in a bounded LRU of four, sharing the byte budget
with the query-target policy; an oversized target occupies the cache alone,
and both are cleared on device recreation. Normals are computed on the CPU
in f64 and uploaded, so light tone differs from the reference only by f32
rounding of the dot product and the ramp; positions are normalized before
upload and restored on readback (~1e-7 relative), and are never used for
support or visibility. Non-finite packing, out-of-range coordinates,
model-space light recipes and image recipes without a chart fall back to the
CPU reference per location and count as `refinements`.

### Hatch, isolines and extrusion

**A ruling is one stroke across faces.** `curves/hatch.ts` rules the *sheet*,
not the face: the band of the widened paper along the ruling normal is
divided at the requested spacing, and each row is one plane intersected
against every triangle of the group that spans it — "one plane, one chain,
for the row across every face of the group". Rulings cost the paper, so the
sheet is widened by one sheet diagonal on every side (styles that reach past
the edge keep their anchors) and each piece is clipped to that widened sheet
by Liang–Barsky in camera space. A ruling lying on the group's outer
boundary is dropped as the face outline, already drawn; one on an interior
edge between two grouped faces stays. Pieces that share a node — an edge
crossing between two triangles, of one face or of neighbouring faces — are
chained head to tail so the stroke constructor joins them into one pen-down
stroke. `t.hatch` traces **one direction family per call**; a crosshatch is a
second call with its own direction, tone and pen, and passing `families`
throws with that instruction.

**Junction runs pair by feature kind.** `strokes/construct.ts` groups run
endpoints by source identity. Two runs meeting there simply link. Where more
than two meet — a mesh vertex where a silhouette loop passes through the
edges of a fan — runs are grouped by their feature flags and a group links
only when it holds exactly *two* runs of that kind; every other end breaks
as `junction`. Links are further refused when the curve sources differ, the
sets are incompatible, the endpoints are farther apart than the tolerance,
or the turn exceeds the corner angle (which breaks as `corner`). Chains
start at deterministic source ends before loops are consumed.

**Isolines** interpolate linearly inside each fixed triangle and construct
the crossing point exactly on the represented edge, so incidence to both
triangles sharing that edge is exact. The half-open rule counts a corner
value equal to the level as above; a level through a vertex yields that
vertex as the node, so neighbouring triangles meet there and no zero-length
piece is emitted. Node identity is (level index, the unordered vertex pair
or single vertex, the corner values along that edge, the exact point), so a
seam — different corner values at one vertex, such as a cylinder's `u` seam
— keeps separate nodes and therefore separate chains.

**Extrusion** takes one vector per connected component
(`geometry/extrude.ts`). `{ distance }` uses the area-weighted mean normal
and is refused, naming the region, when that mean's length is below half the
summed area (faces that cancel, such as a folded strip). The cap is the
selected faces translated, retaining face IDs, corner IDs, corner attributes
including UV, face attributes and the fixed triangulation; interior points
move, boundary points are duplicated as `['extrude', key, 'point', pointId]`
and the original stays with the unselected faces. Walls are one quad per
region boundary edge, `['extrude', key, 'side', edgeId]`, including open
sheet edges and hole loops. Self-intersection of recessed or crossing walls
is not detected; only invalid topology is reported by assembly.

**Curvature** is an estimate on the polygon mesh
(`geometry/curvature.ts`): a Rusinkiewicz-style per-triangle tensor,
accumulated at corners with angle weights inside the corner's smooth sector,
where a sector ends at an edge whose dihedral exceeds `creaseDegrees`
(default 60) and `smoothing` (default 1) averages only within a sector.
`confidence` is `|kMax − kMin| / (|kMax| + |kMin| + eps)`, so umbilics and
flat regions report near zero and a caller must fall back deterministically.
Directions are unoriented lines: signs are aligned to corner 0 before the
barycentric average, which is then projected onto the triangle plane and
re-orthogonalised.

### Stage drafts

A host may watch a render without changing it. `compileSketchAsync(def,
inputs, { onStage })` and `commitCamera3(..., { onStage })` call the listener
from `classifyForRun3` with `StageEvent3 { stage: 'source' | 'classified',
scene, paper, segments, total }`: projected source lines right after feature
capture (hidden portions included), then the 3D-visible intervals after
classification. Segments are paper millimetres, `[x0, y0, x1, y1, …]`,
uniformly subsampled above 200 000 so a transfer stays bounded. Modeling
progress rides the separate `onProgress` channel as `ModelingProgress3
{ operation, done, total?, detail? }` from `t.hatch`, `t.mapSurface` and
`t.intersections`.

**Nothing is recorded from these events.** The result, the plan and the
exports are identical whether a listener is attached or not, which
`test/three-stage-events.test.ts` asserts by comparing a listened compile
with a silent one. Drafts are disposable and keyed by render id; only the
final reply updates retained or exportable state. Per-feature classified
chunks, an author checkpoint before the sketch returns a view, incremental
wasm finish and partial plans are all deliberately not implemented — see
`docs/notes.md`.

### Studio integration

The 3D package exports must be recognized by three separate loaders, and a
change to one is a change to all three: the Studio runner and the headless
`requireFor` adapter (`tools/inputs.ts`) both resolve `occlude/3d` and
`occlude/3d/advanced`; `liveExampleToJs` rewrites root and 3D namespace
imports for docs fences (`docsExamples.ts`); and Monaco registers both entry
declarations as extra libs and loads nested source modules by relative path
(`packages/occlude-studio/src/editor.ts`). Test the actual compiled examples
and the editor diagnostics, not only direct TypeScript imports in unit
tests.

One ergonomic decision worth not rediscovering: a bare callback is
deliberately *not* a `steps` shorthand. TypeScript cannot discriminate a
one-parameter point field from a `(current, next)` rule — both overload
orders and the union form were tried, and either the rule or the field loses
its parameter types.

### Blender as a reference, never a source

`packages/occlude/test/fixtures/three-reference/` holds Blender 5.2.1 Line
Art and Freestyle captures with the pinned build, the capture scripts and
the comparator method; `test/three-reference.test.ts` runs them in the `ts`
gate. **No source engine was transplanted** — Blender's documentation and
its output supply behaviour references only, and the two deliberate
crossing-box discrepancies the test pins by exact length are recorded beside
the fixtures.

### The certified raster filter

Before the exact classifier decides a feature against its candidate
triangles, a raster over the sheet answers what it can prove. Every triangle
is drawn into a cover buffer at 2048 pixels along the long side: a pixel
records the smallest far-depth of any triangle whose projection covers the
whole pixel (all four corners strictly inside, shrunk by a tenth of a pixel).
A feature whose nearest point lies farther than that cover at every pixel it
crosses is behind a covering surface under every eye ray, so it is hidden;
its own triangles never prove it, since equal depth is not "farther by a
margin". Candidate triangles come from a coarse cell grid walked along the
feature's projection rather than from bounds overlap, a tighter superset for
diagonal lines. Anything the raster cannot see, a feature beyond the sheet or
geometry at the eye, falls to the exact path unchanged. The filter never
decides inside its own margin, so the intervals are byte-identical to the
exact classifier's: the test `three-raster-filter.test.ts` and the seven
benchmark workloads (zero mismatched intervals) are the oracle. Measured on
the woven vessel: 2.26 M candidate pairs to 0.63 M, 58% of features proven
hidden, visibility 9.6 s to 2.3 s; the other workloads 1.2x to 3.5x.
`classifySceneCpuJob3(snapshot, { raster: false })` runs the exact path alone.

## Fields

A Field is an augmented callable: a plain `(x, y) => value` carrying its
transform and domain bound inside the closure, plus metadata the verbs
propagate (the unbounded twin to rasterise, the bounds to ship as
regions). `rotate`/`translate`/`scale` are explicit verbs (nothing is
ambient); vector fields rotate their arrows and never scale magnitudes.
`within(f, shape)` bounds the domain — absent outside — through the same
lowerer the shape inks with. Sketch-time consumers (isolines, scatter,
fills) call fields directly and exactly. Engine-consumed modifier params
become **field uses**: one raster per field (built over the union of its
uses' pulled-back footprints) plus, per use, a paper→field affine and
domain refs — `align: 'shape'` compiles A = G ∘ C into that affine, so a
thousand halftone dots share one grid, and `within()` bounds are exact
clip regions the engine tests before it samples.

## Materials

`material.ts` holds vertices as typed columns (`x`, `y`, declared
attributes) plus an edge list with its own columns. Every operation
returns a new material; `steps()` freezes the current state, collects the
batch of edits described against `next` (moves, attribute writes, splits,
removals, connections, extensions), validates conflicts and ownership,
and publishes one new state, optionally recording history. Forces are
prepared per state (spatial index built once in `force.nearby`) and
evaluated per point. `relation.ts` is selections, extraction,
`components` and `meanBy`; `query.ts` prepares a grid
over a state's edges for `nearest` and `firstHit` with a wide-box fallback
so long queries stay exact; `faces.ts` planarizes with Shewchuk's
`orient2d` for every orientation decision and reads bounded faces, face
selections and union boundaries. Attribute transfer (interpolate or
nearest for points, copy or distribute for edges) is declared per column
and honoured by split, resample, planarize and append.

## Contracts

What the code guarantees today, stated as rules and linked to where each
one lives. Everything under a **Future** label is a proposal, not an API;
nothing in a sketch may rely on it.

### Materials: ownership and identity

*Where:* `material.ts` (`Material`, its constructor, `attribute`,
`withEdges`, `resample`, `steps`), `views.ts` (`viewProto`, `viewKind`,
`ownedBy`), `relation.ts` (`PointSelection`, `EdgeSelection`), pinned by
`test/material-contracts.test.ts` and `test/material.test.ts`.

- **Columns.** A state is `x`, `y` (`Float64Array`, `n` long), point
  attribute columns by name (each `n` long), an edge list (`Uint32Array`,
  `[a0, b0, a1, b1, …]`, stored order, each pair a distinct row and never
  `a === b`), and edge attribute columns (each `edgeCount` long). `x`,
  `y`, `index` are reserved point names; `a`, `b`, `length`, `index` are
  reserved edge names. The constructor checks lengths and edge ranges.
- **Ownership on construction.** The constructor *adopts* the arrays it
  is given; every library operation that derives a state (`attribute`,
  `edgeAttribute`, `withEdges`, `resample`, `append`, `withinMaterial`,
  `steps`, `extract`, `planarize`) copies its columns first, so no two
  materials the library made share an array. The object, its column
  records, policies and history are `Object.freeze`d; typed-array
  *contents* are not freezable, so `m.x[i] = …` from a sketch writes into
  that one state.
- **What a direct write reaches** (current behaviour, pinned): views
  (`vertex`, `edge`), `pts`, `curves()` and every derivation made after
  the write read the columns live. Adjacency (`connected`, `degree`) is
  built lazily from the edge list only and cannot go stale on a
  coordinate write. A prepared `query.edges(m)` copied the endpoints
  and keeps them. A prepared `neighbours(m)` (and every force built on
  it) keeps its buckets but reads distances live, so a row written away
  drops out of its old cell's answers while a row written near is never
  found. `faces()` is computed once per state and returned from the cache
  thereafter. Nothing invalidates on a write. Sketches should treat
  states as immutable; the library does.
- **Identity.** State identity is the `Material` object. Row indices are
  positions within one state, never identities across states: every
  structural edit renumbers. A vertex or edge *view* is a plain object
  whose prototype carries the owner and kind as non-enumerable symbols
  (`views.ts`); `ownedBy(view, m)` is the only identity test, and a spread
  or JSON copy is unowned. Selections (`m.points.filter`) bind to the
  exact source state and combine only with selections of the same state.
- **Lineage.** `iteration` counts `steps()` transitions; `attribute`,
  `withEdges`, `resample` and `withinMaterial` keep it, `append`,
  `extract` and `planarize` start a new one at 0. `history` is written by
  one `steps({ every })` call and never touched again.

**Future** (not implemented): a backend that uploads a state must key its
copy on an explicit upload snapshot or a backend-owned versioned value,
not on `Material` object identity, because a sketch can write the arrays
after upload. A cached derived structure that a backend produces needs
the same treatment.

### Passes and edits

*Where:* `Material.steps` (the loop, snapshots), `steps.ts` (`Next`,
`stepOnce`, `StepKit`), pinned by `test/step-passes.test.ts`,
`test/transfer.test.ts` and the `steps` block of `test/material.test.ts`.

- **Frozen input, described output.** A pass `(prev, next, k)` reads
  `prev` — frozen — and describes edits on `next`. No edit changes what a
  later callback in the same pass reads. `stepOnce` starts from a copy of
  every column, records the batch, then commits it as one new state.
- **Several passes per iteration** run in order; each receives the
  previous pass's committed output as its `prev`. All passes of an
  iteration share `k`. A selection, view or handle belongs to the pass it
  was taken in: the next pass must select again from its own input
  (`steps: selection is of another state`). A pass that throws publishes
  nothing; the input state is untouched.
- **Iteration and history.** Iteration `this.iteration + k + 1` is the
  number of the state a completed iteration produces; `steps()` continues
  the count of its input. With `{ every }`, `history` holds the input
  state (labelled with its iteration), every `every`-th completed
  iteration, and the final one, each once, oldest first; passes within an
  iteration are never captured.
- **Order of resolution** inside one batch (`stepOnce`): moves and
  attribute writes first (moves add up; the last write of a field wins),
  on the copy; then the *moved* state is built and split transfer
  callbacks read it; conflicts are checked (a removed vertex that was
  also moved or set, a split edge that is disconnected or loses an
  endpoint, an edge set and disconnected); splits are resolved per
  original edge — sorted by parameter, equal parameters merged, one
  child-edge definition per edge, point columns inherited from the moved
  endpoints by the column's declared policy then overridden explicitly;
  rows are compacted — survivors in order, each edge's split vertices
  right after the edge's start row, added points last; edges are emitted
  — survivors (split into chains, edge columns copied or distributed by
  the child's share), then new connections in request order, an existing
  pair left as it is; finally the new state. A `split` at 0 or 1 creates
  nothing and returns the existing endpoint. `extrude` is `addPoint` +
  `connect` per child, in selection order.
- **Handles** are opaque, batch-bound, and refused by any other batch
  (`that handle belongs to another edit batch`).

The repository also carries an *experimental* ordered/live editing
prototype (`bench/ordered-steps/`, `test/ordered-steps.test.ts`). It is a
study, not the production contract; nothing above applies to it and
nothing in it applies here.

### Geometry queries

*Where:* `query.ts` (`edges`, `EPS`), pinned by the `query.edges` blocks
of `test/material.test.ts`.

- **Preparation and lifetime.** `query.edges(m)` copies the edge
  endpoints of `m` and builds a uniform grid over their boxes; the
  returned object is valid for that state and keeps that geometry for as
  long as it is held (see the ownership rule above). Vertex adjacency for
  `excludeIncident` is built on first use.
- **Coordinates and tolerance.** The material's own coordinates; straight
  segments between sampled vertices; no snapping. `EPS = 1e-9` relative
  to the larger of 1 and the extents in play decides on-the-line,
  parallel and collinear. This engine is separate from the analytic
  line/arc/cubic visibility kernel in the core and shares nothing with it.
- **Answers.** `nearest` is the least `(distance, edge index)` pair with
  `distance ≤ within` (inclusive); `firstHit` the least `(along, edge
  index) pair; both are order-independent, so pruning changes nothing —
  a lexicographic minimum does not depend on the order candidates are
  judged in, and the differential harness behind that claim (19 708
  comparisons, 0 mismatches) is recorded in [Working notes](#/notes).
  Endpoint contact counts as a hit of kind `touch`; a collinear overlap
  reports the start of the overlapping interval as `overlap`; anything
  interior is `crossing`. A zero-length move is a contact query at
  `from`. `excludeIncident` skips every edge incident to that vertex of
  the *queried* state and refuses a vertex of another state.
- **Source identity.** A hit carries `edge`, a live view of the queried
  material (its row index and endpoints as the material holds them now),
  plus the position and parameters as computed on the prepared copy.

**Future** (not implemented): a batch seam would take arrays of query
positions (and, for `firstHit`, targets) and return parallel arrays of
source edge indices, parameters and distances with `-1` for a miss —
the same lexicographic answers, so a batch and a loop must agree exactly.

### Fields and units

*Where:* `field.ts` (the augmented callable, `rotate`/`translate`/`scale`,
`within`, `fieldMeta`), `units.ts` (`L`, `resolveLen`), `fieldGrid.ts`
(`planGrid`, `evaluateGrid`, `buildFieldGrids`), `isolines.ts` +
`marching.ts`, pinned by `test/field.test.ts`, `test/field-grid.test.ts`,
`test/isolines.test.ts` and `test/marching.test.ts`.

- **A field is a callable.** `(x, y) => value` in user units, carrying
  its transform and domain bound inside the closure plus metadata the
  verbs propagate (`fieldMeta`: the unbounded twin and the bounds).
  Scalar fields return a number, length-valued fields an `L` (resolved
  per sample against the frame), vector fields a `[vx, vy]`. There is no
  other representation; every consumer calls the function.
- **Transforms** are explicit verbs; nothing is ambient. A vector field
  rotates its arrows with the frame and never scales magnitudes.
- **Absence** is a non-finite sample. Every consumer decides for itself:
  isolines treat any cell touching absence as emitting nothing (a contour
  ends open there); engine grids fail open to 0 at that sample, because
  the exact edge of a `within()` bound is shipped separately as a clip
  region the engine tests before sampling; sketch-time consumers
  (`scatter`, fills) see the raw non-finite value. These differ on
  purpose; there is no global rule.
- **Engine grids: plan, then evaluate.** One grid per (unbounded field,
  kind), shared by every use. `planGrid` fixes the lattice from the uses'
  pulled-back footprints — pitch from the paper step scaled by the
  tightest use, a sample budget that coarsens rather than grows, one cell
  of margin, and for paper-aligned grids the window of the full grid the
  shapes read (kept on the full grid's own lattice, ≥ 4 cells, padded so
  the engine's Catmull-Rom stencil never leaves it). `evaluateGrid` calls
  the field once per lattice point and writes `[w, h, x0, y0, dx, dy,
  ...samples]`; a vector field's two grids come from one evaluation. The
  per-use paper→field transform and domain refs ride `fieldUses`
  (stride 14, `scene.rs`), outside the grid.
- **Isolines: sample, march, chain, finish.** `sampleGrid` samples the
  callable on the drawable's lattice with a pad ring; `marchSegments`
  emits directed crossing segments per level (`≥ level` is inside, the
  saddle follows the cell-centre average, a zero-length segment is never
  emitted, the pad ring is rewritten per level); `chainSegments` joins
  them in emission order; `finishContours` clamps `close` runs to the
  drawable, drops duplicates and merges colinear runs. Production is
  exactly that composition (`test/marching.test.ts` proves it).

**Future** (not implemented): a GPU evaluator for known built-in fields
would be another `evaluateGrid` over the same `GridPlan`, and a GPU
marcher another `marchSegments` over the same `SampledGrid`, returning
the same `SegmentBuffer`. A JavaScript-to-WGSL compiler is out of scope.

### Encoding, rendering and resource lifetime

*Where:* `render.ts` (`encodeScene`, `decodeRender`, exports, the plan),
`sceneBuffers.ts` (the stride-9 primitive codec), `fillJobs.ts`
(`runFillJobs`), `wasmRender.ts` (`renderEncoded`), `scene.rs` (every
stride), pinned by the "pass-1 handle lifetime" block of
`test/fills.test.ts`, `test/all-features.test.ts` and the golden scene.

- **Inputs and outputs.** `encodeScene` reads the compiled recording and
  the resolved paper and returns an `EncodedScene`: the `wasm_prepare`
  argument buffers, the fill-job closures keyed by shape index, and the
  decode metadata. It is not transferable and never crosses a thread.
  `renderEncoded(mod, scene)` returns `RawRender` — the prims and frags
  buffers, stats, optional ghost, wall time. `decodeRender(scene, raw)`
  is the one half a host may run elsewhere. Order in the scene is 2D
  painter order (`zIndex`, draw index breaks ties). 3D depth is a
  different axis and never reuses it: a 3D scene is classified and
  interpreted into strokes before the recording is emitted, so the
  encoder only ever sees 2D ink.
- **The render sequence** is `wasm_prepare` → `runFillJobs` →
  `wasm_finish`, one synchronous call frame. `wasm_finish` consumes the
  prepared handle on Ok and Err alike, so JS frees it by hand only when a
  fill job throws before finish; a finish error propagates with nothing
  freed here; the finish result is freed once after its buffers are
  taken. Fill randomness is a sub-stream keyed `${seedUsed}:fill:${order}`.
- **Layout stability.** The encoded layout (stride-9 prims, stride-12
  shape rows, stride-14 uses, stride-9 fragments, the fills index) and the
  public return types are the contract; a change lands on both sides of
  the wasm boundary in one commit (CLAUDE.md), with the strides at the top
  of `scene.rs`.

### Numerical and reproducibility policy

- **Snapping.** Input coordinates are snapped to the 0.005 mm grid at
  encode time (`snap.rs`, `record.ts`); intersection parameters are never
  snapped. Material coordinates, field samples and isoline points are
  not snapped at all — they become input geometry only when drawn.
- **Tolerances** are named constants where they live: `query.ts` `EPS`
  (1e-9, relative to the extents in play), `isolines.ts`/`marching.ts`
  (1e-6 user units for chaining, 1e-9 for duplicate and colinear tests),
  `withinMaterial` (cut points matched at 1e-6). Cite them; do not copy
  the literals.
- **Ordering** is deterministic everywhere it is observable: edge order,
  emission order, cell order, draw order. Randomness flows only through
  the seeded `Rng` and its keyed sub-streams (design law 3).
- **Precision.** Every coordinate is a binary64 double and the CPU
  operation order is part of the contract wherever a byte oracle pins it.

**Future** (not implemented): a GPU backend computes in binary32 unless
it does otherwise on purpose, so it needs an explicit precision policy.
Geometry it generates becomes ordinary input geometry after readback —
CPU finishing does not restore precision lost upstream — and an export
must use the committed result, never regenerate it on a different
backend.

## Plan and results

`plan(render(def))` runs merge → tour → bridge once in the core and
returns a `DrawingPlan`: chains with native primitives, the settings that
produced them, and a SHA-256 over both. Everything downstream is a range
of that value: `selectChains`, `selectProgress`, `selectTime` and
`fitDuration` pick one, `resolveDraw` is what `t.draw` goes through, and
`planSvg`, `planGcode` and `planToolpath` encode it. Selections never
re-plan or re-solve visibility. The studio's render worker returns the
plan bytes with every render; the Drawing panel reads the resolved range;
Export, Simulate, Plot and Frame take it; Save result writes the selected
chains as a plan of their own with the frozen SVG, pens, paper, profile
and provenance into the result store, and `/?result=<id>` reopens those
bytes without executing the source. `estimatePlanMs` is the one time
model for the panel, `plotstats`, the simulation and the driver.

## Robustness invariants worth knowing

- **Snap inputs, never results.** Input coordinates land on a 0.005 mm grid,
  so shared edges compare with `==`. Intersection t-values stay exact floats.
- **"On the boundary" classifies as outside.** A stroke lying exactly on an
  occluder edge stays visible; the resulting double-draw is what seam dedupe
  removes.
- **Half-open ray casting needs exact chains.** Curved contours are pre-cut
  into y-monotone pieces and the chain is *welded* (adjacent pieces forced to
  share bit-identical y at seams) because `sin(2π) ≠ sin(0)` in floats.
- **Roots on subdivision boundaries are checked explicitly.** A root exactly
  at a Bernstein split point is invisible to both children (endpoint touch,
  zero sign variations), so the splitter evaluates the split point itself.
- **The nib rule judges runs whole.** Clipping emits every visible piece;
  `judge_runs` groups a contour's or chain's pieces into connected runs
  (pen-down movements) and judges each whole — a sub-nib run is one tap
  candidate, resolved by exact coverage. Upstream tolerances are the input
  snap and curve flattening at export, both numerical policies rather
  than artistic ones.
- **Handles have owners.** `Prepared` is consumed by `finish`; the JS side
  frees it by hand only on the fill-throw path.
- **One fill truth, JS.** Rust knows no pattern: the golden renders a
  committed scene whose fills sidecar the product fill modules produced
  (regenerated by the JS-side sentinel test when a fill's ink changes on
  purpose); benches use synthetic lines and dots that are input, not
  product.

## WASM buffer protocol

Documented at the top of `scene.rs`, both directions. In short: primitives
are stride-9 f64 rows (`[kind, ...params]`); shapes are stride-12 u32 rows
pointing into contour, clip and modifier tables; pass 1 returns fill jobs
(`[shape, contour_start, contour_count]` over contour/prim tables); pass 2
takes supplied ink (`fills_index` stride 5 over `fill_chains` stride 2 over
stride-9 prims, plus dot pairs) and returns the extended primitive table
plus stride-6 fragment rows `[origin, t0, t1, pen, shape, flags]`. Pens
and machine profiles cross the boundary as JSON.

### Execution: no ambient state

*Where:* `execution.ts` (`Execution`, `ExecutionInputs`, `pen`, `paper`,
`penModel`, `paperModel`), `api.ts` (`compileSketch`, `bindToolkit`,
`inspectHook`), `render.ts` (`encodeScene(exec)`, `render(def | exec)`),
the studio's `runner.ts`/`render-worker.ts`, pinned by
`test/execution-isolation.test.ts`, `test/pens-paper.test.ts` and the
studio's `runner.test.ts`.

- **One object per run.** `new Execution(inputs)` → `compileSketch(def,
  exec)` (or `compileSketch(def, inputs)`) → `encodeScene(exec)` →
  `renderEncoded` → `plan`/`exportSvg(exec)`. There is no current sketch,
  paper hint, pen library, seed hint, inspect flag or registry in any
  module: every function that reads a run takes it as an argument, and
  the toolkit a sketch receives is bound to its run (`bindToolkit`).
  Two runs never share a byte; interleaving them phase by phase gives
  exactly what each gives alone, and a run that throws — in the sketch
  body, a fill job, or `wasm_finish` — or is abandoned half way leaves
  nothing for the next run to observe (the isolation test).
- **Inputs are values the host resolved.** Paper (`{ w, h, color? }` mm),
  the captured pen library, the seed for an open-seeded sketch, the
  host's default margin, the asset and fill tables the source references
  (`assetTable`, `fillTable`), and whether inspection is on. URL and
  session seeds, library fetches and asset decoding are the host's job
  (the worker rolls one session seed per worker; tools take `--seed`);
  `DEFAULT_INPUTS` is A4, the package's pens, seed 0 — a fixed default,
  never a session's. `inputs` is frozen and copied: editing a library
  after a run changes nothing in it.
- **The sketch's declarations win.** `paper:` overrides the host's sheet;
  `pens:` are sketch-local instances (`pen()`, or a library model's
  factory from `@user/pens`), resolved first; an undeclared name resolves
  from the captured library; `margin` is a percent or a physical length;
  `pen:` or the first declared pen is the default. `stroke:`, `fillPen:`,
  `pen:` and `fill()` syntax is unchanged.
- **Pure factories stay pure.** `circle`, `fill`, `polygon`, `paper`,
  `pen`, `mm`/`inch`, `rotate`/`scale` of a field return values and touch
  no run. A shape given as an area (`polygon(circle(…))`) is an `area`
  geometry lowered when the drawing is recorded, so it needs no run in
  hand. What reads the run lives on the toolkit: `t.within`,
  `t.translate` (unit lengths), `t.noiseField`, `t.image`, `t.asset`,
  `t.synth`, `t.rnd` …
- **Inputs are snapshots.** `inputs` is frozen, and the asset and fill
  tables are copied on construction (text by value, pixels as fresh
  arrays, fill params by value): a host that edits or reuses its tables
  after creating a run changes nothing in it (the isolation test covers
  assets and fills as well as paper, pens and seed).
- **The result carries the run's pens and paper.** `RenderResult.pens`
  are the captured instances and `RenderResult.paper` the resolved sheet
  with its colour when one was declared; the studio's timing, tolerance,
  plotting, export and preview read those, never the live library — a
  library edit enters through the next run. Exports default their
  background to the result's paper colour.
- **What the run reports** — seed as used with its overrides, the draw
  log, probes, inspections — is read from the object (`getOverrideReport`,
  `getDrawLog`, `getProbeStats`, `getInspectionIndex`,
  `inspectionPayload`); the worker keeps the last run for inspection and
  refuses a stale execution id as before.

## Studio persistence

Sketches, fills, pens, papers, machine profiles, assets, and the plot log
live on the studio server (plain files under `sketches/`, `fills/`, `assets/`;
`pens.json` and `papers.json` are the libraries `@user/pens` and
`@user/papers` are built from, per run),
shared by every browser that reaches it. `localStorage` holds the working
sketch (and a fill draft), the UI layout, and offline caches of pens and
profiles; the sketch saves on every (debounced) run, including runs that
fail. The seed rides the URL fragment (`#seed=…`, encoded, so a long seed
with its draw overrides survives the trip), which is what makes "copy url"
shareable; the studio hands it to the render worker as the run's seed —
the library reads no URL of its own.

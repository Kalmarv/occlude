# Working notes

What is measured, what is still open, and what was deliberately parked.
Everything that is *built* is documented on the topic pages and in
[Architecture](#/architecture); **the code is the truth for anything that
shipped.** This page holds the rest: the direction, the specs that were ruled
but not built, the refusals worth not re-litigating, and the numbers worth not
re-measuring.

Numbers below were taken on one shared machine (AMD Ryzen 5 3600, 8 vCPUs,
Node 24.x, benchmarks under `nice -n 10`, serially). They are regression
checks, not cross-machine guarantees: a row that has drifted upward is the
signal, not the absolute value.

## Direction

The project is a personal instrument for making actual drawings, not a
product. The rule that decides expansions:

> Every operation should leave understandable material that the artist can
> continue working on. Every chosen drawing should retain a clear path to the
> intended ink on paper.

Before expanding the system, name the drawing or the recurring interaction the
change enables, and prefer the smallest implementation that proves that
benefit. Experiments and local helpers stay local until reuse earns an
abstraction.

### The sequence

A recommended order, not a dependency chain. Steps 1, 2 and 4 have landed.

| # | Work | Evidence of completion | State |
|---|---|---|---|
| 1 | Reproduce and repair failures that undermine output trust | focused failing cases become reliable; historical notes are classified resolved, reproduced or unverified | done |
| 2 | Small vocabulary improvements; settle texture/opacity behaviour | saved sketches migrate; outline, transparent texture, opaque texture and mask are all directly expressible | renames done; the non-hiding texture is still open (below) |
| 3 | Expose and preserve the ordered drawing | consumers agree on plan identity; a selected partial output is reproducible, and resume does not depend on a rebuilt order | largely done — `DrawingPlan` is a value, results are saved with their plan bytes |
| 4 | A minimal attribute-based growth study | direct loops and reusable operations mix without losing data; intermediate states are inspectable | done — the material vocabulary with attribute columns, frozen `steps` passes and `{ every }` history |
| 5 | A second, different drawing on the same material model | shared abstractions prove useful beyond the first example | open |
| 6 | Extend only where those drawings reveal friction | curve views, transfer rules, topology tools, caching or provenance have demonstrated uses | open |

### Texture and opacity are independent

A shape may draw texture without hiding earlier ink, hide without texture, do
both, or do neither. All four cases should be directly expressible. Three of
them are: an outline hides nothing, a mask hides with no texture, and a filled
opaque shape does both. **The missing quarter is the non-hiding texture** — a
`{ fill, opaque: false }` that draws its pattern and lets what is underneath
survive. The default stays as it is when this lands, and `CLAUDE.md` law 1 is
worded around the 2×2 rather than around "fill implies occlude".

This is not veil or partial occlusion, which is rejected outright: an overlay
never *erodes* the ink beneath it. Decimate the content instead.

### What not to make a prerequisite

- A general node evaluator or a node-editor interface.
- Moving every heavy operation to Rust.
- A new host application, a native daemon, or a replacement language.
- A complete mesh framework, planarization system, or universal
  attribute-transfer engine.
- Arbitrary callable occlusion without a motivating sketch.
- A project-wide naming and type migration before the first new drawing.
- Splitting repositories merely because the project has several
  responsibilities.

These remain possible responses to evidence. The failure mode being avoided is
local questions becoming entangled with too many other decisions.

### Questions still open

Resolve these with small drawings and explicit contracts; their existence is
not a reason to design the whole framework in advance.

1. The smallest useful set of attribute domains for the next two drawings.
2. Which attribute types and missing-value behaviours are supported.
3. How element views and raw arrays are scoped so a preserved result cannot be
   mutated by accident.
4. Which topology operations require stable IDs, and how provenance survives
   splits and merges.
5. Which transfer rules are common enough to deserve defaults.
6. How exact primitives and sampled geometry meet without two incompatible
   curve models.
7. Which drawing actually needs intermediate visibility as the input to
   another operation.
8. What history retention gives useful exploration at an affordable cost.

On visibility specifically: if callable occlusion is ever earned by a drawing,
keep geometric visibility and physical finishing separate. Preserve analytic
fragments; never route solved intersections through input snapping again;
apply the nib judgement once, at a defined finishing boundary, not repeatedly
to already-judged ink; keep sketch and paper coordinates explicit; preserve
enough source information to understand the resulting pieces. A resolved
geometry type helps only if every consumer respects those contracts.

## Ruled but not built

Each of these was designed and agreed. None is started. Each needs re-reading
against the shipped code before anyone builds it.

**Growth: vertices, curves, meshes.** Fully ruled (Blender vocabulary, a
`step` verb, a polygon-winding option), reviewed, and then *not built by
choice*. Part 4 of that spec — "stopping as composition", the tour truncator —
has since shipped in a different shape as `t.draw({ minutes, budget })`, so
the spec needs re-ruling rather than building as written.

**Per-pen draw-direction bias.** Agreed, not implemented — verified absent:
there is no `directionBias` anywhere under `packages/` or `crates/`. The point
is that a pen laid down in a consistent direction reads differently on paper;
the design avoided raw degrees in favour of naming a direction.

**Fillet.** Half of the fillet-and-plot-optimization design. The plot-
optimization half shipped (see the Auto numbers below); the fillet half did
not, and there are zero `fillet` hits in the source.

**Gallery batch two.** `docs/gallery.md` exists and carries the first batch of
credited, licence-checked classics. A second batch was scoped and never
started. The rails for it stand: no new API in a gallery session, no engine
changes, no edits to existing entries; anything a piece needs and cannot get
is *reported* as a candidate, never added on the spot.

**From the plotter/creative-coding survey** (2026-09-03, both awesome lists
read end to end, every entry judged against the design laws). What survived
and shipped: streamlines as the vector-field twin of isolines
(Jobard–Lefer — ideas and the paper only), and `grad`/`curl` field
constructors. What survived and is still open:

- `.tour()` on a point selection. The Rust core already has a budgeted,
  deterministic grid NN + 2-opt `tour()`; exposing it makes TSP art
  `t.scatter(img.lum, { spacing }).settle(40).tour()` with no branded name,
  exactly as `scatter().settle()` already *is* LBG stippling. `mst()` over the
  Delaunay edge list is about thirty lines. Call the wasm tour, not a second
  implementation.
- L-systems and a turtle, as plain-data generators.
- Real single-line typography (`label` currently renders capitals only).
- `seam` on closed shapes. Every circle starts its contour at the same
  parameter, so a grid of circles plots a grid of pen-dwell blobs at three
  o'clock — physically real, and the eye finds the pattern instantly. A
  `{ seam: 0.37 }` or `{ seam: 'random' }` shape option (sticky per the seed
  law) rotates the start. Lowered in the recording; no engine change.
- Paint and dip workflows, and a pen starter set — both machine/workflow work
  rather than API.

## Rejected and parked

`CLAUDE.md` names these; this is what they were.

**Obsoleted by the worker-owned runtime and the two-pass pipeline.** Each was
a real design from an earlier revision of the fills/fields work, and each is
obsolete rather than pending — recorded so nobody reinvents one: the mailbox
(SharedArrayBuffer + Atomics field sampling from Rust), COOP/COEP cross-origin
isolation to enable it, a mid-pipeline wasm→JS fill callback, the
`FillProvider` two-leg seam, presence-mask NaN rasters, and bleed margins
around field grids. The fills that need field values now get them in JS,
before the second wasm call, and the engine reads planned rasters plus exact
clip regions instead.

**Parked with a stated trigger.** Drawable fields (a stack of value-carrying
shapes) — lambdas compose better, and the unique value is a machine
legibility nothing needs; the trigger would be a felt need for studio handles
on pieces of a field. Batch field evaluation and distance-transform
acceleration — until a shared reader exists. Exact isoline closure along
arbitrary curved bounds — a real geometry feature (contour/boundary
intersection with topology), where today's behaviour truncates open.

**Occluder culling in 3D** (parked by the owner, 2026-09-15). Candidate pairs
are the cost of exact classification — 2.26 M on the woven vessel after the
depth cutoff. Two exact reductions were identified, neither built:

- *Back faces of closed objects.* For a watertight manifold a back-facing
  triangle never decides visibility, because anything behind it is also behind
  the front face of the same solid. That roughly halves the occluder set on
  spheres, tori, boxes and capped sweeps. The condition is decidable per object
  from topology; open sheets keep both sides.
- *Outside the widened sheet.* Occluder triangles and features entirely outside
  the sheet plus one sheet diagonal — the same overscan rule the hatch ruler
  uses — can neither hide nor leave ink. Scene-dependent, and large for scenes
  that surround the camera.

Object-level occlusion culling (an object wholly behind another) was judged
rare and hard to make exact; not recommended. Measure the back-face share on
the seven workloads before building either; the CPU-vs-GPU ink digest is the
oracle.

## Open API friction

Noted while writing the workshop, and still unaddressed. Each is a real
moment where the API made the reader do marshalling by hand.

1. **Keeping a material inside a shape takes a detour.** Chords long enough to
   reach a frame from any interior point cross outside it and enclose slivers
   there; the workshop filters faces by `bounds` numbers. `t.material(clip(rect,
   line))`, or cutting connections at a boundary, would make "the chord through
   this point, inside this frame" one call.
2. **Bounding a construction to a region takes three spellings.** A field uses
   `within(field, shape)`; a scatter over half a sheet needs
   `t.scatter(within(() => 1, rect(…)))`; `relax` and `voronoi` take
   `{ bounds: { x, y, w, h } }`; faces are filtered by numbers. One notion of
   "this region", accepted everywhere, would remove a line of translation from
   every comparison.
3. **A weighted-centre response is slow by nature.** Moving a site toward its
   cell's density-weighted centroid moves it a fraction of a unit per round for
   any gentle field — a light had to be raised to the fourth power with a floor
   of 0.005 before twelve rounds showed anything. Not a defect, but it deserves
   a sentence next to `weightedCentroid`, and it is why `relax` uses many
   rounds.
4. **Two `faces()` collections from two constructions of the same sites are
   strangers.** Each `t.voronoi(sites)` call is a new material with its own
   cached faces, so measuring across them throws. Correct, and the message says
   so, but tidiness leads straight into it.
5. **A sketch cannot read its own plan's cost.** There is no in-sketch readout
   of chain count, ink or estimate, so a page that wants to *show* what a
   thousand lifts costs has only `Date.now()`. This is also why the docs ink
   oracle names `Date.now()` examples unstable instead of hashing them.
6. **`label` renders only capitals.** Fine for counts, odd for words.
7. **Resampling inside `steps` is an outer loop.** Keeping even spacing through
   a multi-step warp needs `m = m.steps(1, rule).resample({ spacing })`, because
   `resample` renumbers rows and is not a `next` edit. Idea to explore: a
   `next.resample(opts)` that *rebases* the step — the resampled copy becomes
   the base before the batch's other edits, so a large warp's move is sampled at
   even spacing; predicate edits are unaffected and handle-based edits after it
   throw. Alternative: an identity-preserving `next.mergeEdges(pred)` symmetric
   with `splitEdges`. Neither built; needs exploring.
8. **Two pens 0.05 mm apart are one pen on the page.** A hierarchy of weights
   needs nibs about twice apart — worth a note on the Plotting page.

Addressed since: split-at-an-endpoint overrides, `append(a, b, { fill })`,
`extend(spec, { inherit: true })`, `dot`/`cross`/`fromAngle`/`angleOf`,
multi-column `attributes({…})`/`edgeAttributes({…})`, and `--pens docs` on
`plotstats` and `render`.

## Other open items

- **Resume rehearsal** (plot → Stop → reload → Resume) has never been tried
  end to end on the machine.
- **Golden fixture gap for field rasters.**
- **Estimator re-fit** against the plot log under the lift-map model is one
  plot deep (a wall/model ratio of 0.997). More real plots will tell.
- **The heavy-pen lift grid** was plotted but its counts were never read back.
  The prediction is the same map within a rung; a felt tip may read one rung
  deeper because it marks at a lighter touch.
- **`pnpm bench` cannot complete on a fresh clone**: `bench/all.mts` runs
  `planbench` against sketches in the studio's gitignored store, and the same
  applies to the `plotstats church.ts` oracle that the working agreements name
  as the definition of an ink-affecting change.
- **`qa-corpus/` is tracked but unreachable** from any script: the string
  appears in no manifest, tool or doc.
- **The GPU surface-evaluation test always skips under Node** — the whole
  `describe('GPU surface evaluation')` is `it.skipIf(!navigator.gpu)`, so the
  GPU/CPU tone-quantum agreement is asserted by nobody in CI.

## Measured: the 2D optimization loop

Baseline `750214f`, warm, medians of at least three runs. Every entry passed
the full gate set before it was kept, plus `renderhash --check` over six
reference sketches and the church oracle.

**Edge queries prune instead of scanning** (`query.ts`). Both answers are a
lexicographic minimum — `(distance, edge index)` for `nearest`, `(along, edge
index)` for `firstHit` — and a lexicographic minimum does not depend on the
order candidates are judged in. So the per-query sort was unnecessary, and any
candidate set containing every edge that could win yields the identical answer.
`firstHit` now walks the corridor of cells the segment crosses; `nearest`
expands rings until the nearest unvisited cell is farther than the best
distance found. The differential harness against a snapshot of the old
implementation compared every field of every result over **19 708 comparisons
with 0 mismatches** — this is the proof [Architecture](#/architecture) cites
for order-independence.

| workload (35 k edges) | before | after |
|---|---:|---:|
| prepare `query.edges` | 17.2 ms | 10.5 ms |
| 1 000 `firstHit`, 2 mm moves | 20 ms | 8 ms |
| 1 000 `firstHit`, whole-drawing moves | 1 244 ms | 38 ms |
| 1 000 `nearest` within 3 | 58 ms | 6 ms |
| 1 000 `nearest` within 50 | 1 805 ms | 57 ms |

Thirteen further entries followed the same shape — find the allocation or the
string key in the inner loop, not the arithmetic. The planarity check stopped
building template-string keys (60 % of `faces()` was `checkPlanar`, and the
coincident-vertex map alone was 50 ms per call for ~105 000 strings); view
brands moved to a shared prototype; adjacency became lazy; marching squares
stopped building four closures per crossing cell; image channels became a
number rather than a string inside the sampling loop; the stipple fill judges
its nearest cells first; and on the Rust side the clip loop stopped allocating
a span vector per occluder, the clip walk pops a heap instead of sorting what
it never reads, the query stops gathering occluders behind the shape, and the
BVH walks a fixed frame instead of allocating one per query.

The through-line: **judge fewer candidates, allocate less per candidate, and
leave the exact arithmetic alone.** No tolerance was ever moved to make
something faster.

## Measured: plot-path optimization

The recursive fixture, seed 185591647, 304.8 × 304.8 mm, hop pen 0.4 mm,
against the committed iDraw timing profile. These are the shared estimator's
predictions, not physical plot measurements.

| path | ETA min | internal lifts | ink m | travel m |
|---|---:|---:|---:|---:|
| original normal plan | 309.75 | 23 373 | 102.931 | 14.626 |
| permissive fitting alone (0.1 mm) | 310.48 | 23 373 | 102.804 | 14.626 |
| joins up to 0.2 mm | 276.61 | 20 153 | 103.222 | 13.282 |
| joins up to 1 mm | 225.22 | 15 011 | 106.072 | 11.081 |
| 0.2 mm, both ends extended | 268.60 | 19 375 | 103.301 | 13.391 |
| 1 mm, both ends extended | 215.61 | 14 073 | 106.461 | 10.642 |

Two things worth keeping: **fewer segments did not make this sketch faster** —
the winning alternative omits fitting in both cases — and **about 74.5 % of the
original ETA was pen-cycle time**, which is why lift elimination dominates
everything else.

Auto (Plot → Optimize path → Auto optimize) searches proposals and accepts only
faster candidates that pass per-pen vector ink allowances: 309.75 → **226.60
min**, 23 373 → **15 077** internal lifts, 8 296 new joins, 83.16 estimated
minutes saved (26.8 %). Its acceptance is vector geometry only — no SSIM, no
raster mask, no image-similarity score — with a missing-ink upper bound below
0.000001 mm² and an added-ink interval of roughly 0.00209–0.00362 mm² against
an original union ink area near 23 121 mm². Eight proposals took 78.2 s in that
run; the first reference footprint calculation dominates and subsequent
candidates reuse its local unions.

## Measured: fills, contours and thicken

- **Analytic distance contours** are the default for `fill('contour')`. A
  production-served 0.01 mm sketch completed its full worker request in
  **17.565 s** with no fallback and no visibility split. The preceding offset
  engine stays available behind a non-default Cargo feature for comparison
  builds.
- **The SDF query/cache pass** improved render medians **5–9 %** on the three
  recursive fixtures with byte-identical encoded plans and exported path SVGs.
  Its release blockers were never cleared: fine dense widths still exceed the
  render deadline, and constant/radial plot ETA is still worse than the
  production engine.
- **Contour versus solid** on A4 with a 0.45 mm pen, fill-only: a disc goes
  from 415 runs / 20.96 min (solid) to 1 run / 18.50 min (contour); an annulus
  602 / 18.47 → 2 / 14.71; many-holes 1 267 / 29.01 → 224 / 27.35. The
  construction tolerance is `min(0.01 mm, width/20, spacing/10)` throughout.
- **`thicken`** runs on `clipper-lib` 6.4.2 (JavaScript Clipper 6.4, not
  Clipper2), synchronous, with no wasm initialization. The archived algebraic
  implementation is kept as a comparison reference only and is not imported by
  production code. The performance pass (grouping crossings by primitive and
  shape, sorting once, binary search per piece) gave 1.15× on separated discs,
  1.36× on a variable-width chain, and 4.21× on long crossing lines.
- **Bridging cost**, from one shaded A4 piece: no bridging ≈ 34 000 lifts and
  ~11 h; `bridge: mm(0.5)` ≈ 4.4 h; `mm(0.7)` ≈ 2.9 h; `mm(1)` ≈ 2.3 h.

## Measured: the 3D visibility pass

Branch point `bfbdf93`. Four optimizations kept, all byte-identical output, no
signature touched. Woven vessel, CPU reference, warm:

| # | change | visibility ms |
|---|---|---:|
| — | branch point | 17 513 |
| 1 | unroll the fixed-width BigInt vector ops | 16 579 |
| 2 | certified f64 sign filter for the halfspace tests | 13 659 |
| 3 | strip only the common power of two in the shadow build | 10 220 |
| 4 | build each exact view and vertex once, not per triangle | 9 826 |

−43.9 % on visibility, −27.1 % on total compile (25 040 → 18 246 ms).

The instrumentation that motivated each is the useful part. The vessel makes
~13.5 M `dot` calls over what were `Array.prototype.reduce`/`map` closures on
fixed 4-vectors. Of 2 255 812 candidate pairs and 7 580 746 constraint
evaluations, 1 578 447 end in a rejection and only ~2.1 M ever take an interval
root — so **~72 % of the exact BigInt work was computed and discarded**, which
is what the sign filter recovers. With the filter in, `gcd` became the top
frame, and attributing it by call chain put 3 403 ms of 3 494 ms inside the
once-per-occluder shadow build; a histogram of `reduce` over the vessel gives
555 270 calls, 145.6 bits in and 98.2 out, with the common factor a **pure
power of two in 69.3 %** of them. Euclid was benchmarked against Stein's binary
gcd first (966 ms vs 1467 ms on representative operands), so the win had to be
*fewer* gcds rather than a different one.

Before that pass, the surface-drawing session had already made two exact
reductions: candidate generation prunes by camera depth (woven vessel 3.77 M →
2.26 M pairs, 29 s → 20 s on the CPU reference, all 3D docs examples
byte-identical), and the GPU shader's certificate was widened so refinement fell
from ~100 % of candidates to 30–80 %.

### Why the CPU is the only classifier

Measured on the served Studio, warm, wall ms from source edit to render reply,
same box and same real adapter:

| workload | GPU classify | CPU classify | delta |
|---|---:|---:|---:|
| mapped-plane | 3182 | 2942 | −8 % |
| primitive-crosshatch | 14855 | 13896 | −6 % |
| custom-curvature | 4767 | 4402 | −8 % |
| intersection-assembly | 4478 | 3386 | −24 % |
| repeated-prototypes | 954 | 834 | −13 % |
| hatch-density | 28443 | 25899 | −9 % |
| **woven-vessel** | **43662** | **18168** | **−58 %** |

Visibility phase alone, the same order: −49 %, −30 %, −35 %, −60 %, −44 %,
−36 %, −74 %.

The GPU classifies each pair in f32 and hands every pair its certificate cannot
settle back to the exact CPU refinement — 1 458 163 of 2 255 812 pairs (65 %) on
the vessel. So it pays the candidate streaming, the packing, 276 dispatches and
the readback, **and then still pays roughly two thirds of the exact bill**. It
also loses on `intersection-assembly`, which refines only 19 %, so the per-pair
overhead is dominant on its own and this is not merely a refinement-fraction
story.

Switching moved ink on three of the seven workloads (`custom-curvature`,
`intersection-assembly`, `repeated-prototypes`). Stroke counts were identical
in every case; what moved was interval endpoints, by less than the parameter
tolerance, because the GPU path accepts f32 endpoints that survive
`refinementTargets3` without exact re-evaluation and the CPU path does not. The
two classifiers were never the same answer, and the direction of travel is
toward exactness.

### Still open from that decision

- **Does `classifySceneGpu3` survive?** It is in the tree, unexercised on the
  Studio path, and able to disagree with the reference — which is a liability.
  Choosing between the two at runtime would be a mode flag whose options are
  only valid in some modes, which the ethos rejects: if the CPU classifier is
  the right answer, it should be the only answer. Delete, or keep and justify.
- **Is tolerance-based acceptance of f32 endpoints still the right design?**
  `refinementTargets3`, the watertight-abutment closing and
  `intervalTolerance3` all exist to repair f32 seams. If the exact path is
  faster than the approximate one, that machinery is paying for a speed-up that
  no longer exists.
- **Is `atScale`/`planeScale` an acceptable split?** It is a second spelling of
  `plane` in an internal kernel, distinguished by whether the result is
  canonical or merely projectively equal. "One conversion per meaning" is an
  API-surface law; is it also a kernel law?
- **Does the certified f64 filter sit right with "no float nudging"?** It
  introduces no tolerance — it is a proof obligation and abstains whenever it
  cannot discharge it — but it does put floating point in front of an exact
  predicate.

### The GPU numbers that remain valid

The older per-workload GPU tables (`grid-4` … `city-30`, retained-viewport FPS,
GPU visibility wall medians) are measurements of `classifySceneGpu3`. The
numbers are sound; the framing that calls them "the Studio path" is not, since
the Studio no longer classifies on the GPU.

## The next 3D performance pass

The hatch tracer, not visibility, is now the largest single cost on the Studio
path: `hatch-density` is 25.9 s of which the **tracer is ~15.9 s** and
visibility only 4.6 s.

### Rules for that pass

1. **Non-breaking only.** No change to an exported signature, option name,
   default, or asserted error text. If a change needs an API change, write it
   up rather than make it.
2. **Same ink.** `docs:hashes --check` must report every example identical
   after each kept change; a pure optimization never re-saves the fixture. Run
   `plotstats church.ts --seed 42` before and after anything touching stroke
   assembly.
3. **Measure before and after, on both paths, or it does not count.** Kernel
   timings alone are not evidence; keep a change only when the end-to-end
   number improves and the gates stay green.
4. **One optimization per commit**, with the before/after numbers in the
   message. Revert rather than stack a workaround, and record the failure so it
   is not retried.
5. **The machine is shared.** Serially, under `nice -n 10`, one browser at a
   time, and kill orphaned processes by PID — `pkill` patterns are too broad on
   this box.
6. **Do not reintroduce capacity caps.** Count and byte budgets default to
   unlimited; only explicit options may cap.
7. **Do not nudge numbers.** Tolerances, epsilons and thresholds are not
   performance knobs. Exactness is the product.

Already rejected for this area, do not spend time on them: tiled or multi-core
finish inside the wasm core (a core redesign — planning is global), raster-based
coverage, default caps, float nudging.

### Where the time goes

From `node --cpu-prof` over the vessel at the branch point (28.2 s total, self
time): 3480 ms anonymous in `three/geometry/exact.ts`, 2514 ms
`hiddenWorldInterval3`, 2091 ms garbage collector, 1567 ms `ratioNumber`,
3624 ms `gcd` across five call-tree nodes, 1104 ms `ProjectedIndex3.query`,
941 ms `candidatePairs3`, 909 ms `hiddenInterval3`. Entries 1–4 above attacked
exactly those frames; re-profile before assuming the shape is unchanged.

The remaining candidates, in the order the previous session ranked them:

- **Visibility.** Stream candidates in typed arrays rather than per-pair JS
  objects. A better broad phase than the depth cutoff — a BVH or screen-space
  grid over occluder triangles per feature, built once per view. Avoid
  re-sorting per feature in the interval merge, since hidden ranges are already
  produced in order per batch. Splitting classification across workers by
  feature range (check `render-worker.ts` and the stage-draft channel first).
- **The surface tracer** (`three/surface/trace.ts`, `three/api/hatch.ts`, the
  occupancy test and the `SurfaceLocation3` contexts in
  `three/geometry/location.ts`): CPU-bound, dominated by per-step location
  objects and the occupancy neighbourhood test. A flat occupancy grid keyed by
  triangle with typed arrays, fewer allocations per step, and better reuse of
  the per-triangle context cache.
- **Mapping and intersections** (`three/api/mapping.ts`, `three/curves/*`,
  `network.ts` with exact BigInt nodes): the exact arithmetic is the contract.
  Optimize the allocation and indexing around it, never the arithmetic.
- **Modeling on the GPU** and the **Studio round trip** (structured-clone sizes,
  transferable buffers): lower priority.

### The oracles

The benchmark workloads and their runners live in `packages/occlude/bench/three/`.
There is **no byte oracle for the GPU path** from inside the Studio: with WebGPU
disabled the render worker reports "WebGPU adapter unavailable" rather than
falling back, so there is no CPU-classified Studio render to diff against.
Reconstructing the Studio's inputs in Node is not sound either — the Studio
renders on its own paper, margin and pen, none of which the headless reference
reproduces by default. So the oracle is a before/after capture on the same
Studio with the same stored inputs: the sha256 of the raw `prims` and `frags`
buffers of every workload on the real adapter, which is exactly what the
preview, the export and the paper are made of. That is what "no ink change"
actually claims.

Per-workload baselines, GPU visibility on an NVIDIA RTX 2060 (non-fallback
adapter), end-to-end wall ms from source edit to render reply, with the
visibility columns as candidates · dispatches · refinements · ms:

| workload | wall ms (warm) | modeling | visibility |
|---|---:|---|---|
| mapped-plane | 3535 | mapSurface 1301 ms / 6080 seg | 38 991 · 5 · 31 014 · 1026 |
| primitive-crosshatch | 14 833 | hatch 7893 ms / 36 418 seg | 168 446 · 21 · 78 533 · 4251 |
| custom-curvature | 5127 | hatch 2504 ms / 10 850 seg | 54 215 · 7 · 30 005 · 1141 |
| intersection-assembly | 4045 | 3 × intersections + hatch | 167 271 · 21 · 38 458 · 1800 |
| repeated-prototypes | 1160 | mapSurface 17 ms / 23 seg | 13 924 · 2 · 9387 · 287 |
| hatch-density | 30 132 | hatch 16 170 ms / 80 978 seg | 363 798 · 45 · 140 608 · 8815 |
| woven-vessel | — | 35 302 features, 32 812 triangles | 2.26 M pairs, 20.1 s exact |

The vessel row is the reason the pass happened: at the branch point it never
returned a render reply at all — Studio's 60 s watchdog fired. With the four
optimizations it returned on every measured pass, but the worst cold pass under
a load average of ~8 was 57.5 s against that 60 s watchdog. CPU classification
takes the same render to ~18 s, which is the margin that makes the target safe
rather than merely met. Run-to-run noise on the vessel is roughly ±3 %, and
this box is shared.

## Progressive rendering: what is left

Stage replacement is built (see [Architecture](#/architecture)). Deliberately
not implemented, and not prerequisites for anything:

- An **author checkpoint** before the sketch returns a view — the only way to
  show lines during a long `await` that precedes the returned tree. It needs a
  defined snapshot identity and a camera contract, and the author has to choose
  a meaningful checkpoint. An *automatic* modeling-input preview would have to
  infer camera, projection, paper frame and interpretation from arbitrary user
  JavaScript, which the worker cannot do safely.
- **Per-feature classified chunks.** Possible in principle: a feature's visible
  intervals can be finalized once all its candidate pairs are processed and its
  close interval neighbours refined. A plain per-batch callback is too early —
  later batches for that feature can reveal more hidden intervals and change
  earlier segments. Any such chunk is still provisional for the 2D result, and
  it needs backpressure so `postMessage` and structured-clone costs do not
  dominate the GPU work.
- **Incremental wasm finish and partial plans.** `wasm_prepare` and
  `wasm_finish` expose no incremental callback, fill generation happens between
  them, and planning is global — a partial plan would alter tour and bridge
  decisions when later fragments arrive. A real final-geometry stream needs
  chunked native APIs, stable fragment identity, incremental fill/occlusion
  state and a final reconciliation pass. Treat it as a separate project.

Whatever is added, the rule holds: drafts are disposable, keyed by render id,
never enter `lastPlan`, exports, freeze or the retained result, and a draft
from an obsolete request must not repaint the current editor.

## Provenance

A few facts worth not losing now that their source notes are gone. "The nib is
the only tolerance" and the 0.005 mm snap grid were first written in the
earliest planning notes and are now in [Architecture](#/architecture). The
sub-step timing bug recorded in the same notes is fixed, in
`packages/occlude-studio/src/ebb.ts`. The sketch-library restores across three
history rewrites are `git bundle` files kept outside this repository, with the
restore procedure beside them.

## Visibility: the certified raster filter (2026-09-15, built)

Measured before building: on the woven vessel 85% of features are wholly
hidden and 54% of the 2.26 M candidate pairs never overlap in projection.
Built as a cover-depth raster plus a cell walk (docs/architecture.md, "The
certified raster filter"), on by default, `{ raster: false }` for the exact
path alone. Oracle: zero mismatched intervals on all seven benchmark
workloads and the 36 docs examples. Visibility phase, CPU reference:

| workload | exact ms | with filter | speedup | pairs before | after |
| --- | ---: | ---: | ---: | ---: | ---: |
| woven-vessel | 9577 | 2332 | 4.1x | 2,255,812 | 633,422 |
| hatch-density | 3716 | 1062 | 3.5x | 363,798 | 347,686 |
| primitive-crosshatch | 1739 | 573 | 3.0x | 176,255 | 166,407 |
| custom-curvature | 540 | 246 | 2.2x | 54,215 | 74,116 |
| intersection-assembly | 571 | 285 | 2.0x | 233,407 | 105,325 |
| mapped-plane | 283 | 154 | 1.8x | 38,991 | 54,611 |
| repeated-prototypes | 108 | 91 | 1.2x | 13,924 | 15,487 |

Next steps in the same direction, all ink-preserving: a two-deep visibility
buffer (nearest two triangle ids per pixel) for per-pixel hidden runs and a
visible proof that skips a feature's own triangles; cluster ids per cell so a
cluster behind a cover is dropped once; workers by feature range. The
raster could also skip tracing hatch lines on covered triangles, but that
changes which lines are seeded and where dashes fall: a decision, not a
filter. The ink-preserving version, parked 2026-09-15: keep tracing hidden
lines (seeding and dash phase stay exact) but skip building their exact
network nodes and segments, which is most of the remaining hatch cost. Nib-size LOD likewise changes ink and would be an explicit mode.

## 3D compile: structural sharing and per-pair filters (2026-09-15, built)

A user sketch (five 128x32 tori, sixty boxes, a sphere, a 65-object list
intersection, four hatch recipes at 1-1.5 mm; 88,628 features) measured
headless before and after, on the shared home server:

| stage | before | after |
| --- | ---: | ---: |
| modeling (primitives, rotate, faceAttribute) | ~5 s | 2.6 s |
| list intersections | 3.5 s | 1.8 s |
| feature snapshot | 6.6 s | 5.6 s |
| visibility classification | 10.1 s | 5.2 s |
| strokes + 2D | ~7 s | ~4.5 s |
| whole sketch | 48.3 s | 20.5 s |

What changed, all ink-identical (256/256 docs examples): attribute edits
share points, edges, triangles and the topology revision (`editAttributes3`)
instead of re-assembling and re-freezing the whole surface; mesh rows build
lazily per domain with face geometry cached by array identity; surfaces the
API builds itself are frozen in place (`ownSurface3`) rather than cloned
again at capture; the cell walk's candidates pass the enveloped
bounding-box test the index path always had (4.0 M pairs to 1.1 M on this
sketch); reference chains are memoized per scene across the per-pen stroke
calls of the default drawing; hatch features carry the network's exact node
points so the classifier decodes instead of rebuilding them; planes are
canonicalized once; author edge sets, exact vertices, decoded points and
kind sets are cached per binding, node and flag value. The remaining
profile is flat: bigint gcd about 7%, GC about 10%, then a long tail.

## Filed: image-to-line ideas from the DrawingBotV3 study (2026-09-16, not built)

A reverse-engineering study of DrawingBotV3 Premium (ideas and format facts
only, never code; the free core is GPLv3, the premium jar closed) produced
working/drawingbot-digest.md, a ranked digest of what would be worth building
here and how it composes from occlude's vocabulary, with a 65-item copy-risk
register. Filed as future ideas by choice. The headline: DBV3 has no plot-time
model (law 4 is safe) and our merge/tour/bridge already exceeds its shipped
ordering; the one optimisation upgrade is α-nearness candidate sets feeding
chained Lin–Kernighan.

Engines: an edge-tangent-flow field constructor and an edge-distance field;
a writable "ink debt" surface for erase-as-you-draw tracers; streamlines
over any vector field. Station transforms: tone-modulated oscillation
(sawtooth), orbiting scribbles capped by edge distance, dashes oriented by
least transverse variation. Sampling: grid with darkest-point snapping and
dithered acceptance, snap-to-extremum, structure-aware error-diffusion
stippling, widening hysteresis for settle, per-cell orientation and
inscribed circle on `faces().measure`. Lines between points: tour with a
pluggable cost (continuous-line drawings), superpixel-partitioned tours,
MST with the neighbour-endpoint cubic smoothing, quadtree mosaic.
Composition: tiled recipes by weighted quota, colour-region masks, layered
tonal passes, edge–contour–shading. Tone and colour: measured tone response
inverted into a `shaper`, a CIEDE94 colour-distance field, the per-pen
colour-match loop, CMYK and extended-gamut splits, clean-black pre-filter,
a per-ink coverage multiplier on pens, luminance-weighted pen distribution
after drawing. Export and machine: post-export bounds report against the
bed, place and auto-rotate within the bed, per-pen start/end templates,
reading `$130`–`$132` into a profile, and an animation export of the
drawing being drawn.

## Shaders, implicit geometry and rewrite rules (2026-09-18, built on `explore`)

Three features in one night, with the decisions that shaped them. Each of
these was a choice with a live alternative; the alternative is written down
so nobody re-argues it from scratch.

### What a shader shades

A stroke shader runs on the PLAN, not on the fragment table. The fragment
table looked like the free seam — `wasm_plan` is its only consumer — but a
fragment is a sub-range of one primitive, and a stroked circle is already
twenty-odd primitives. The thing an artist calls a stroke does not exist
there; the plan's merge makes it. `Frag.run` carries no general identity
either: `run_id` was 0 on every fragment of an ordinary outline. So `s` in
millimetres, dash phase and `ctx.length` all need the chain.

The cost of that choice is that a shader cannot see what only the fragment
knows: `ctx.kind` (is this a hatch?) and `ctx.depth` (how far back is this
3D line?). Both need a per-chain source label in the plan protocol, which is
a both-sides commit. Until then `ctx.pen` is the way a program tells one
kind of stroke from another, and `docs/examples/shoal.mdx` uses it that way.

`passes` is retrace — the identical path, drawn again. The routing default
forbids duplicate edges for Eulerizing a tour, not for an artist asking.
An offset would put ink outside what occlusion cleared.

**The preview draws the plan because of this feature.** The finished paper
precedes planning, so it cannot carry a shader: a shaded sketch previewed
solid and plotted shaded, which law 5 forbids. Measured before changing it —
a hatched sheet is 3193.6mm of ink either way, 385 fragments against 153
chains, 0.07mm apart, and that difference is the sub-nib bridges the machine
draws anyway. The plan keeps lines, arcs and cubics exactly as the render
made them, so nothing is flattened on the way to the screen.

### Words the field algebra does NOT have

`field` is the distance-field algebra. It is `field` and not `distance`
because `distance(a, b)` is already the distance between two points, and
`sdf` is not a word this project speaks.

Three words the first sketch of the feature asked for are absent, each
because the answer already existed:

- **No `contour()`.** The boundary of a field is `t.isolines(f, 0)`.
- **No `offset()`.** `distanceTo`'s own docstring already ruled that inset
  and offset rings ARE isolines at a level. A field is a function, so a
  shape grown by four is `(x, y) => f(x, y) + 4`, written where it is
  needed; the "inset band of constant width" is `subtract(body, inner)`
  with `inner` inline, and needs no API at all.
- **No `field.rect`.** It is `field.box`, and centred. `rect(x, y, w, h)`
  anchors by the sketch's own rect mode, and a pure field function cannot
  read the sketch, so one name with two anchors would be a trap.

The algebra takes plain numbers and not `L`. A length in the sketch's units
needs the resolved paper, and these are module imports — the frame rule, not
an oversight.

**Union is a MAXIMUM**, because this codebase signs a distance field
positive inside. Written here because it is the one thing every reader
disbelieves.

**The blend formula was wrong once, and the way it was wrong is worth
keeping.** The obvious polynomial smooth maximum adds its bump wherever the
two fields are within `k` of EACH OTHER — and on the locus equidistant from
both, that is true out to infinity. Measured: a constant +2.25 bias at y=50
and at y=100000 for k=9, so the whole shape grew by `k/4` and never stopped,
while the page claimed "exact away from it". It is a rounded union now,
measured at 0.00000000 past the joint. Note that the rounded form is not
idempotent either: `blend(a, a, 8)` contours at radius 14.34 against a disc
of 12. A fillet adds material, and the docs say so rather than claiming
otherwise.

### Why there is no `rules()` verb

A rule is a pattern and a replacement, and `steps` already had both halves:
a `StepRule` receives the frozen state and an edit batch, and an edit over a
selection already applies to every match at once. So `rule.point(p).move(f)`
BUILDS a `StepRule`. A new verb would have been a second spelling.

The one distinction worth a word is batching, and existing syntax carries
it: a shorthand is an object and a rule is a function, so an ARRAY is
unambiguous. `steps(n, [a, b])` is one batch; `steps(n, a, b)` stays two
passes.

**"Order inside the array changes nothing" is FALSE**, and the docs said it
for a day. Matching is order-free. Editing is not: two `set` rules give 2
then 1 when swapped, two extrudes swap their row order, and only `move`
commutes.

Randomness is not a rule option. The first sketch wanted
`split({ chance: 0.3 })`; a seeded stream lives on the toolkit and these
factories are pure, so a chance goes in the pattern, where it runs once per
row.

A rule that only moves or writes runs on a MESH too — `Rewrite` is generic
and assignable to both worlds. The topology actions keep the flat world's
type, because a mesh edit batch has no per-step topology; a type error is
better than a run-time one.

`rule.face()` writes a mesh's face columns and refuses a material's. 2D
faces are DERIVED — `new Faces(m)` recomputes the planar embedding every
time, and `Faces` has no attribute columns — so there is nowhere to write.
Reading is already at parity (`Face` has `adjacent`, `edges`, `points`,
`boundaryEdges`, `area`, `centroid`, `contours`). Writing needs face columns
on `Material`, whose constructor is already nine positional parameters, and
lazy validation on read — recomputing the embedding every step would put a
full face computation inside a 240-step loop.

### Using the oracle across checkouts

`pnpm --filter occlude plotstats <sketch> --seed 42` reads the STUDIO's pen
and paper libraries from `packages/occlude-studio/sketches/*.json`, which is
gitignored user data. A checkout that has one and a checkout that does not
are measuring different pens, so the numbers are not comparable.

This looked like a regression for ten minutes. A worktree at the branch
point reported 399 chains and 6664mm against the branch's 360 and 6395 on
an unchanged fixture — all of it the pen library, because the working
checkout had a 1.25mm 'azure' pen saved and the worktree fell back to the
defaults. Different nibs change bridging and merging; different feeds moved
the estimate from 5.3 minutes to 12.2.

**Pass `--pens docs` on both sides.** With it pinned, this branch's three
features are byte-identical to `a996915` on `all-features.ts`: 399 chains,
6664 draw mm, 1630 travel mm, 5.3 est min, 0 bridge, 383 euler, 0.4
coincident mm, before and after. That is the real claim — an existing
sketch's toolpath is untouched — and it is measured rather than argued from
the shape of the diff.

### Open, and waiting on a ruling

- `p.adjacent` is a FOURTH spelling of "what is joined to this vertex",
  beside `m.connected`, `m.connectedPoints` and `m.degree`. The removals
  `working/relations-design.md` approves would fix it.
- 2D face attributes, above.
- `ctx.kind` / `ctx.depth`, above.

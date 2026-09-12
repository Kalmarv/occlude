# SDF contour optimization — 12 September 2026

Follow-up: the [query/cache performance pass](contour-sdf-query-optimization.md)
preserves these plans and measures a further 5–9% improvement against a fresh
baseline. Its selected fine-width probes still show release blockers.

The experimental SDF fill now renders the three recursive sketches 20–42% faster
than the first prototype, uses fewer planned primitives/runs, and puts about 47%
less nib ink outside the variable-radius material. A 21.9456 mm square passes
every width from 0.01 through 1.00 mm in native and WASM builds.

**This still does not qualify as a production replacement.** On the dense
recursive sketch, 0.01–0.24 mm widths exceed Studio's 20-second render deadline.
The constant and radial sketches still have much higher plot ETA than the
production contour engine. The aggregate contour-accuracy contract is also not
yet certified. Production keeps the existing engine; this work remains behind
the private `contour-sdf` Cargo feature.

## Measured changes

These compare the [first SDF prototype](contour-sdf-report.md) at `56422ad` with
this implementation. Same three fixtures, seed 42, 304.8 mm square paper, 5%
margin, final quality, and [pinned pens](fixtures/contour-sdf/pens.json). The variable
fixture uses the configured 0.45 mm `micron-01`; constant/radial use 0.4 mm `hop`.
Modifiers and both outlines are retained in this table.

One warmup and three measured samples, run serially. Tail means the largest of
those three samples, not an inferred percentile. Linux x86-64 VM, eight exposed
vCPUs, AMD Ryzen 5 3600 model; Node v24.21.0 and Rust 1.98.0. Timings vary on this
VM; physical plot ETA is the existing deterministic shared estimator, not a
machine trial. Its settings and pen feeds/delays are unchanged from the first report.

| Sketch | First SDF render median | Updated median / tail | Whole-sketch runs | Whole-sketch plot ETA |
| --- | ---: | ---: | ---: | ---: |
| Variable | 12.26 s | 9.76 / 11.22 s | 54,611 → 40,675 | 1239.2 → 935.8 min |
| Constant | 13.67 s | 8.77 / 8.85 s | 38,840 → 34,577 | 868.4 → 783.1 min |
| Radial | 16.14 s | 9.39 / 9.61 s | 36,993 → 32,194 | 831.6 → 734.3 min |

| Updated sketch | Planned primitives | Ink length | Pen-up travel | Planning median / tail |
| --- | ---: | ---: | ---: | ---: |
| Variable | 119,949 | 169.49 m | 30.13 m | 122.9 / 152.6 ms |
| Constant | 68,686 | 120.78 m | 29.55 m | 102.2 / 102.6 ms |
| Radial | 63,070 | 127.93 m | 27.92 m | 76.0 / 113.1 ms |

The production engine's archived ETAs are 1308.8, 400.8, and 464.4 minutes for
variable, constant, and radial respectively. Updated SDF improves the variable
example but still loses badly on the other two. Reducing SDF render time alone
does not make it the faster physical plotting option.

With decimation **and all outlines removed**, variable-radius fill alone now
estimates 380.4 minutes: better than production's 413.5 minutes, but worse than
the first SDF prototype's 346.5 minutes. Longer overlapping completion strokes
trade fewer fragments in the decimated examples for more ink in this intact
example. This supplemental case uses one warmup and one measured sample.

Internal lifts are `runs - 1`; initial lowering/final raising are not internal
lifts. Every sketch uses a single configured pen.

The comparison images show the archived production plan on the left and updated
SDF on the right. Circles around holes remain; the texture under decimation is
visibly different. These are ink-changing experimental improvements, not a claim
that the new SDF plans are identical to the first prototype.

- [Variable radius](contour-sdf-optimization-results/recursive-variable.png)
- [Constant radius](contour-sdf-optimization-results/recursive-constant.png)
- [Radial radius](contour-sdf-optimization-results/recursive-radial.png)

## What changed

- **Index splitting:** the distance BVH now partitions segment centers. Splitting
  by full primitive extent made long parallel contours repeatedly partition tied
  coordinates, degenerating toward full scans. A regression queries 10,000
  parallel lines and requires fewer than 128 visited nodes. This does not claim
  logarithmic worst-case behavior for arbitrary overlapping geometry.
- **Sign queries:** normalized nonintersecting boundary segments have a constant
  crossing order between consecutive vertex y-coordinates. The cache stores
  segment identities for these intervals, evaluating intersections at the actual
  query y. Projected vertices no longer rebuild/sort a ray for every distinct y.
  Tests compare direct parity, vertex rows, and adjacent representable floats.
- **Adaptive sampling:** large or disproportionately expensive uniform grids use
  a quadtree. Each leaf's triangulation includes the finer neighbor's edge
  vertices, preserving shared crossing identities without coordinate welding.
  A Lipschitz cull protects unseen islands; non-linear boundary cells refine for
  thin details. Straight boundary segments can remain coarse.
- **Streaming loops:** completed graph components are refined, simplified, and
  emitted immediately; raw vertices/edges are recycled. A regression emits 1,000
  loops with only four live raw vertex/edge slots. The 4096-level limit no longer
  rejects valid fine spacing independently of output size.
- **Contour representation:** shared vertices are refined against the distance
  query before arc reconstruction. A whole-circle fit checks radial error over
  every chord and angular traversal, rejects repeated laps, and emits two arcs.
- **Coverage:** a bounded query can certify a union of neighboring line/arc
  bands spanning a cell, instead of requiring one primitive to cover it all.
  Independent sample tests check these certificates and deliberately unfilled gaps.
- **Completion placement:** short marks move toward available interior clearance.
  A ray to an opposing boundary proposes a centerline for a sub-nib strip, instead
  of trying only fixed fractions of a nib that can jump over it. Marks can extend
  to eight nib widths when whole-interval visibility and available clearance allow.
  Cleanup joins are simplified/refitted once, within their reserved tolerance;
  rejected replacements retain the original ink.

The adaptive-field direction is informed by
[Frisken, Perry, Rockwood and Jones (SIGGRAPH 2000)](https://www.merl.com/publications/TR2000-15).
The conforming mesh, routing, nib certificates, thresholds, and measurements here
are implementation choices; they are not performance guarantees from that paper.
No dependency, public fill descriptor, WASM buffer layout, modifier ordering,
planner protocol, or production default changed.

## Native profile and memory

The variable fixture's final release-native measurements use
`--no-default-features --features profile,contour-sdf`, one warmup plus three samples.
Native excludes TypeScript preparation and WASM transfer; compare within a runtime.

- Render median/tail: **8.180 / 8.339 s**, versus 9.952 / 9.974 s in the first SDF prototype.
- Coverage median: **4.684 s**, versus 7.760 s.
- Sampling/marching: **2.332 s**. This now includes streaming refinement and regular arc reconstruction; nested profile zones must not be added together.
- Planning median/tail: **101.2 / 112.1 ms**.
- Peak native RSS: **160.4 MiB**, versus 191.9 MiB in the first SDF prototype, measured with `/usr/bin/time -v` across repeated render/plan samples.
- Native and WASM agree on **119,949 planned primitives and 40,675 runs** for this fixture. This is not a claim of bitwise equality across runtimes.

## Full width sweeps and Studio

Every hundredth-mm width from 0.01 to 1.00 was tried in an isolated WASM process,
with the 20-second deadline starting immediately before `render`. Planning then
gets its own 30-second watchdog. Each width is one cold render, without a
discarded warmup; widths were run serially. The driver continues after failures
and checks finite coordinates and decoded plan continuity for successful renders.

| Fixture | Native width sweep | WASM width sweep |
| --- | --- | --- |
| 21.9456 mm square | 100/100 passed | 100/100 passed |
| Dense recursive variable-radius sketch | Targeted profiling only | 76/100 passed; 0.01–0.24 mm timed out |

At 0.01 mm the square took 0.645 s natively and
0.866 s in WASM, producing 1,219 regular contours and 15,230
planned primitives. Its actual Studio worker render took 0.825 s. Across the
square's WASM sweep, render times ranged from 0.036 to
0.866 s.

The dense sketch's first successful cold width was 0.25 mm at 19.34 s; this is
close to the gate on this machine, not a universal supported-width threshold.
All 76 successful plans had maximum adjacent endpoint gaps below 5.6e-11 mm.
All successful sweep cases reported zero fallback and zero visibility splits.
Timed-out cases produced no successful partial-plan result.

Playwright also checked the actual Studio worker with isolated WASM and pen-library
responses: variable 9.916 s, radial 9.385 s, and the 0.01 mm square 0.825 s, all
`ok` with no page errors. Production assets and the shared pen library were not
changed for those checks.

- [Studio fine-width proof](contour-sdf-optimization-results/studio-fine-square.png)
- [Dense width results](contour-sdf-optimization-results/widths-recursive.jsonl)
- [Square WASM results](contour-sdf-optimization-results/widths-square.jsonl)
- [Square native results](contour-sdf-optimization-results/native-square-widths.jsonl)

## Coverage and remaining limits

The independent 6000 × 6000 Playwright diagnostic uses the full original material,
including thin features, with all outlines and decimation removed. One pixel is
0.0508 mm. Distances use an eight-neighbor chamfer transform of thresholded SVG
rasters, not an exact vector Hausdorff distance.

| Diagnostic | Production reference | First SDF | Updated SDF |
| --- | ---: | ---: | ---: |
| Target pixels without ink | 27 | 0 | 7 |
| Maximum distance to raster ink | 0.0508 mm | 0 mm | 0.0508 mm |
| Ink pixels outside the material | 470,073 | 1,728,143 | 911,449 |
| Maximum outside distance | 0.2750 mm | 0.2750 mm | 0.2663 mm |

Updated SDF puts about 47% less ink outside than the first prototype, but still
about 1.94 times production's outside pixel count. The seven missed pixels are
not presented as zero gaps, and this raster cannot establish 0.01 mm accuracy.
Native independent point-to-primitive tests still cover the actual attached
finger, thin sliver, annulus and U; an erosion does not exclude thin artwork.

Let `e = min(0.01 mm, width/20, spacing/10)`. The coverage pass permits `e/2` of
distance tolerance and reserves the other half for cleanup simplification/arc
fitting. Curve conversion, regular sampling and regular arc fitting remain a
separate limitation: the adaptive refinement criterion has a 0.025 mm floor,
and three vertex-projection steps do not certify the entire interpolated field
or its topology. **The original aggregate `e` geometry contract remains unmet.**
Exact whole-interval visibility is still checked before modifiers. Displacement,
dash and decimation retain their existing semantics afterward.

The prototype retains deterministic sample/cell/output budgets (32 million
samples, 4 million adaptive leaves/worklist entries, 64 million raw marching
edges, 4 million simplified contour primitives per component, and 32 million
coverage-cell visits). It never widens the requested spacing to meet them.
Sparse fills skip dense completion and retain the existing spacing-respecting
thin fallback. No fallback replaced the normal comparison cases.

The remaining fine-width problem is now mostly the cost of tracing large output
and verifying coverage over a dense area. Native 0.1 mm probes reached millions
of adaptive samples and tens of millions of coverage cells. Further work should
reduce completion to local residual/front-collision regions rather than continue
refining already-filled bulk. Simply raising the limits would not satisfy the
20-second requirement. Extra cleanup geometry and modifier fragmentation must
also improve before claiming a faster physical plotting option across this corpus.

## Verification and reproduction

- 38 experimental Rust library tests, including six new regression tests for
  index behavior, sign caching, streaming graph reuse, circle traversal and
  band-union coverage; two additional hole/occluder integration tests passed.
- Byte-identical encoded plans across repeated runs of each of the three normal
  sketches; [SHA-256 results](contour-sdf-optimization-results/repeat-plans.json).
- Native/WASM measurements, both full width sweeps described above, finite and
  continuity checks on decoded plans, independent raster diagnostics, and actual
  Studio worker checks using Playwright.
- `pnpm check`: every gate passed; docs ink was unchanged. The experimental build
  does not satisfy the old integration assertions requiring an atomic disc or
  rounded-rectangle run; those production tests are not weakened or relabeled.
- Church oracle unchanged: 15,601 chains, 96,037 mm ink, 16,515 mm travel,
  381.0 estimated minutes. [Check output](contour-sdf-optimization-results/check.txt),
  [oracle output](contour-sdf-optimization-results/church.txt).

Run from the repository root:

```sh
wasm-pack build crates/occlude-core --target web --out-dir /tmp/occlude-sdf-pkg --features wasm,contour-sdf --no-default-features
mkdir -p /tmp/sdf-comparison
node packages/occlude/bench/contour-sdf-compare.cjs /tmp/occlude-sdf-pkg/occlude_core_bg.wasm /tmp/sdf-comparison
node packages/occlude/bench/contour-sdf-widths.cjs /tmp/occlude-sdf-pkg/occlude_core_bg.wasm packages/occlude/bench/fixtures/contour-sdf/recursive-variable.ts /tmp/sdf-comparison/widths-recursive.jsonl
node packages/occlude/bench/contour-sdf-widths.cjs /tmp/occlude-sdf-pkg/occlude_core_bg.wasm packages/occlude/bench/fixtures/contour-sdf/fine-square.ts /tmp/sdf-comparison/widths-square.jsonl
node packages/occlude/bench/contour-sdf-coverage.cjs /tmp/sdf-comparison
node packages/occlude/bench/contour-sdf-visual.cjs /tmp/sdf-comparison
BENCH_PENS=packages/occlude/bench/fixtures/contour-sdf/pens.json BENCH_WIDTH=0.01 node packages/occlude/bench/contour-sdf-studio.cjs /tmp/occlude-sdf-pkg/occlude_core_bg.wasm packages/occlude/bench/fixtures/contour-sdf/fine-square.ts /tmp/sdf-studio-fine
cargo test -p occlude-core --no-default-features --features contour-sdf --lib
pnpm check
```

The width runner accepts an optional final comma-separated list of hundredths,
for example `1,10,25,45,100`, for a smaller probe. The first report includes native
scene-dump/profile commands; `fine-square.ts` works with the same dump command.
Playwright requires Chromium and the Studio check expects the server on port 4173.
[Raw results and build hashes](contour-sdf-optimization-results/) are committed.
Production reference images/timings are archived from the first comparison;
production rendering itself is unchanged by this experimental-only pass.

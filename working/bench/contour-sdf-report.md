# Contour fill / SDF comparison — 12 September 2026

This records the first prototype at `56422ad`. See the
[optimization follow-up](contour-sdf-optimization.md) for the current implementation
and new measurements.

The experimental SDF engine generates nested contours on the user's recursive
variable-radius sketch without falling back to triangular bands. It preserves
the concentric-circle geometry in the constant and radial examples once the
sampled contours are reconstructed as circular arcs. It is **not ready to replace
the default engine**: rendering is slower, two examples have higher plot ETA,
cleanup places more nib ink outside the boundary, and very fine widths exceed
the uniform-grid budget.

The production contour engine remains the default. The user's three sketches
and their current appearances are preserved as fixtures and reference images.

## Compare the actual plans

Each image shows the existing engine on the left and the SDF prototype on the
right. These are Playwright screenshots of SVGs exported from the shared plan,
with the user's modifiers and outlines retained.

- [Variable radius: triangular bands versus contours](contour-sdf-results/recursive-variable.png)
- [Constant radius](contour-sdf-results/recursive-constant.png)
- [Radial radius: concentric circles](contour-sdf-results/recursive-radial.png)

The variable example hits the current engine's 64,000-contour-primitive proposal
limit after one level; triangular cleanup then supplies much of the fill. The
constant and radial examples report **zero fallback**, with 90 and 103 regular
levels respectively. Their circles are ordinary contours expanding around holes,
not a Voronoi generator or a failed offset. Those effects do not inherently
require a bug. The triangle-band texture could become a deliberate separate
recipe later; this change does not add a public texture API or remove its code.

## WASM measurements

12 × 12 inch paper (304.8 mm square), 5% margin, seed 42, final quality. Variable
radius uses `micron-01`, 0.45 mm, 3500 mm/min; the other two use `hop`, 0.4 mm,
3000 mm/min. Pen settle delay is 600 ms. The pinned benchmark pen definitions are
in [pens.json](fixtures/contour-sdf/pens.json); no private Studio files are required.

One warmup plus three measured samples, run serially. Times below are
**median / maximum measured sample**. Render includes TypeScript sketch creation,
WASM generation/validation, transfer, and decoding. Plot ETA uses the existing
`estimatePlanMs`, acceleration 1000 mm/s², travel acceleration 2000 mm/s²,
travel feed 6000 mm/min, junction deviation 0.02 mm, minimum cruise ratio 0.5.
It is an estimator result, not a physical machine trial.

| Sketch | Current render | SDF render | Whole-sketch runs | Whole-sketch plot ETA |
| --- | ---: | ---: | ---: | ---: |
| Variable radius, decimate 0.3 | 6.95 / 6.97 s | 12.26 / 12.32 s | 54,824 → 54,611 | 1308.8 → 1239.2 min (-5.3%) |
| Constant radius, decimate 0.5 | 6.98 / 7.20 s | 13.67 / 13.99 s | 17,079 → 38,840 | 400.8 → 868.4 min (+116.7%) |
| Radial radius, decimate 0.5 | 12.68 / 12.69 s | 16.14 / 16.25 s | 20,051 → 36,993 | 464.4 → 831.6 min (+79.1%) |

An internal lift is `runs - 1`; initial lowering and final raising are not
internal lifts. Outlines are included in the table above. All runs use one pen
per sketch, so pen changes do not confound the comparison.

| Sketch / engine | Planned primitives | Ink length | Pen-up travel | Planning median / tail |
| --- | ---: | ---: | ---: | ---: |
| variable / current | 176,030 | 371.79 m | 23.02 m | 136.2 / 149.5 ms |
| variable / sdf | 171,411 | 146.52 m | 34.97 m | 115.1 / 115.2 ms |
| constant / current | 35,657 | 100.99 m | 16.67 m | 35.4 / 38.8 ms |
| constant / sdf | 78,409 | 108.96 m | 29.67 m | 74.1 / 75.8 ms |
| radial / current | 41,009 | 107.25 m | 17.83 m | 47.7 / 47.9 ms |
| radial / sdf | 73,691 | 115.93 m | 28.45 m | 64.1 / 68.3 ms |

With both decimation **and all outlines removed**, the variable-radius fill
alone takes 413.5 → 346.5 estimated minutes
(-16.2%). It uses 7,780 → 10,348
runs and 494.99 → 173.45 metres of ink. That improvement
comes from shorter drawing distance, despite more lifts. This supplemental
render-time check used one warmup and one measured sample; its geometry/ETA is
deterministic. Raw results include both variants.

## Native measurements and the remaining bottleneck

Linux x86-64 VM, eight exposed vCPUs, AMD Ryzen 5 3600 model. Node v24.21.0;
Rust 1.98.0. Native release builds use `--no-default-features --features profile`
and one warmup plus three samples. Native timings exclude TypeScript preparation
and WASM transfer, so compare engines within each runtime rather than treating
native and WASM totals as equivalent measurements.

For the variable-radius fixture:

| Measurement | Current | SDF |
| --- | ---: | ---: |
| Native render median / tail | 5.138 / 5.141 s | 9.952 / 9.974 s |
| Native planning median / tail | 87.3 / 89.5 ms | 85.7 / 95.3 ms |
| Native process peak RSS, including repeated rendering/planning | 343.6 MiB | 191.9 MiB |
| Visible-area construction median | 7.7 ms | 8.1 ms |
| SDF field sampling and contour extraction | — | 1.034 s |
| SDF arc reconstruction | — | 22.6 ms |
| SDF distance-based coverage completion | — | 7.760 s |

Peak RSS was measured with `/usr/bin/time -v`. SDF uses about 44% less peak
native memory here, but its coverage pass dominates execution. The visible-area
Boolean stage is not the expensive part of this example. Native and WASM agree
on final planned primitive and run counts for the variable fixture; this is not
a claim of bitwise equality across platforms.

## Implementation and precision

The private Cargo feature `contour-sdf` switches the existing native contour
job to [sdf.rs](../../../crates/occlude-core/src/contour_fill/sdf.rs). No public fill
name, descriptor, buffer stride, WASM export, or planner protocol changes were
introduced. Default production builds do not enable the feature. Dependencies
are unchanged. This is native Rust/WASM integration, not a JavaScript custom fill.

The prototype:

1. Reuses the existing final visible-area construction, including winding,
   deformation, clips, drawable bounds, and opaque occluders.
2. Builds an indexed signed distance query over that area's flattened boundary.
   This is the same conceptual composition as `distanceTo` plus `isolines`.
3. Streams two rows of a uniform grid and marches all relevant levels in one
   traversal, using globally shared grid-edge identities for contour continuity.
   It does not scan the entire grid again for each level.
4. Simplifies the sampled lines and reconstructs arcs over bounded local windows.
   Arc fitting checks angular order and radial extrema over whole chords, not
   just endpoint proximity. Arcs have sweeps no greater than a semicircle.
5. Checks coverage using distance to retained ink and adaptive rectangular cells.
   A line capsule containing every cell corner covers the whole cell; actual
   arc-sector/radial bounds also certify cells. Chord approximations reserve
   their error when used as distance certificates. These tests cover thin
   appendages too; an erosion does not decide which features survive.
6. Adds short, overlapping, visible marks where needed. The existing bounded,
   whole-interval-certified cleanup join pass joins nearby marks. Regular
   contour loops remain separate. There is no swept-ink Boolean subtraction or
   triangulated cleanup in this engine.
7. Uses the existing exact pre-modifier visibility validation and ordered-run
   transport, then the existing modifiers and shared planner. It adds no
   post-modifier clip. Deliberate gaps remain gaps.

Let `e = min(0.01 mm, width/20, spacing/10)`. Boundary conversion uses `e/4`,
line simplification `e/2`, and arc reconstruction at most `e` relative to those
lines. These are one-time conversions, not errors repeated at every inset.
**This prototype does not meet the original aggregate `e` contour-accuracy
contract.** Its grid step is `min(width, spacing)/2`; traced-cell interpolation
has a cell-diagonal scale of uncertainty in addition to conversion error. Small
contours can disappear between samples. Coverage completion and exact visibility
checks do not make the sampled contour topology exact.

Sparse spacing does not trigger dense completion; if no regular contour survives,
the existing native hatch fallback uses the requested spacing. Dense cleanup
counts in `residualPatches` count individual proposed marks in this prototype;
the current engine counts polygon patches, so those counters are not directly
comparable measures of geometry size. Use planned primitive counts instead.

## Coverage, limits, and verification

Five dedicated SDF tests cover signed distance/hole sign, actual ink along a
0.2 mm attached finger, a 0.03 mm sliver, annulus, concave U, continuity, whole-chord
arc fitting, sparse behavior, invalid widths, and repeatability. Independent
point-to-primitive checks sample the original region, including its thin parts.
The annulus/U/sliver diagnostics had maximum centerline distances below 0.235 mm
at a 0.25 mm nib radius. These are sampled diagnostics, not a universal proof.

A separate Playwright diagnostic rasterizes the unmodified, outline-free plans
at 6000 × 6000 pixels (0.0508 mm/pixel) against the **full original material**:

| Raster diagnostic | Current | SDF |
| --- | ---: | ---: |
| Target pixels without ink | 27 | 0 |
| Maximum distance to rasterized ink | 0.0508 mm | 0 mm |
| Ink pixels outside the original area | 470,073 | 1,728,143 |
| Maximum outside distance | 0.2750 mm | 0.2750 mm |

The outside distances use an eight-neighbour chamfer transform of thresholded
SVG rasters, not an exact vector Hausdorff distance. Thin features can legitimately
have nib footprints extending outside their area. Nevertheless, SDF puts
substantially more ink outside the boundary in this test. Better clearance-aware
mark placement is required before presenting it as a replacement with equivalent
boundary quality. These diagnostics do not establish 0.01 mm accuracy.

Every decoded plan in the comparisons was checked for finite endpoints and
continuity: maximum gap was below 1e-12 mm. There were zero SDF final visibility
splits on the three sketches. The baseline variable case reports 20 splits.
Playwright also ran the variable and radial examples in Studio's actual worker:
11.83 s and 16.37 s respectively, both `ok`, with no page errors. The experimental
WASM was substituted only in those isolated browser contexts.

Fine-width probes on the variable fixture are **failures**: 0.01 and 0.1 mm
exceed the 32-million-sample uniform-grid budget. At 1 mm the prototype rendered
in 3.26 s after warmup. It also has a 32-million coverage-cell work budget,
4-million raw contour-edge/output budgets, and 4096-level limit. It never silently
widens spacing. The Studio watchdog remains 20 seconds. Adaptive contour sampling
and less expensive coverage completion are needed before another full width sweep
or a production switch; this comparison does not claim the previous 0.01–1.00 mm
acceptance sweep passes with SDF.

Verification completed:

- 32 Rust library tests in the experimental build, including the five SDF tests;
  the existing offset-engine unit tests continue to exercise that engine.
- Two additional experimental-engine pipeline tests: occluder-separated islands
  and annulus hole retention.
- Real WASM render/plan comparisons, native repeated measurements, independent
  raster diagnostics, and actual Studio worker checks using Playwright.
- `pnpm check`: Rust, TypeScript, library types, Studio types, live docs, unchanged
  docs ink oracle, production build, and matching production WASM all passed.
- Church plotstats unchanged: 15,601 chains, 96,037 mm ink, 16,515 mm travel,
  381.0 estimated minutes. [Recorded output](contour-sdf-results/church.txt).

The production fixes in the same work clamp finite negative `thicken` radii to
zero (before edge interpolation) and remove the per-region 12,000-primitive
normalization rejection. Aggregate conversion/precision guards remain. A
13,000-segment region now passes normalization; nonfinite radii still fail.
These fixes do not depend on the experimental fill.

## Reproduce

Run from the repository root. Build the experimental package outside the
production `pkg` directory:

```sh
wasm-pack build crates/occlude-core --target web --out-dir /tmp/occlude-sdf-pkg --features wasm,contour-sdf --no-default-features
node packages/occlude/bench/contour-sdf-compare.cjs /tmp/occlude-sdf-pkg/occlude_core_bg.wasm /tmp/occlude-sdf-comparison
node packages/occlude/bench/contour-sdf-visual.cjs /tmp/occlude-sdf-comparison
node packages/occlude/bench/contour-sdf-coverage.cjs /tmp/occlude-sdf-comparison
node packages/occlude/bench/contour-sdf-studio.cjs /tmp/occlude-sdf-pkg/occlude_core_bg.wasm packages/occlude/bench/fixtures/contour-sdf/recursive-radial.ts /tmp/occlude-sdf-studio
```

The generated `index.html` links the side-by-side pages and SVGs. Playwright's
Chromium must be installed. The Studio check expects the normal server on 4173;
its final argument can select another URL.

For native measurements, dump the same scene with the pinned pen library:

```sh
pnpm --filter occlude dump-scene bench/fixtures/contour-sdf/recursive-variable.ts /tmp/contour-sdf-dump --seed 42 --paper 304.8x304.8 --pens bench/fixtures/contour-sdf/pens.json
cargo build -p occlude-core --release --no-default-features --features profile --example contour_bench
SAMPLES=3 /usr/bin/time -v target/release/examples/contour_bench /tmp/contour-sdf-dump
cargo build -p occlude-core --release --no-default-features --features profile,contour-sdf --example contour_bench
SAMPLES=3 /usr/bin/time -v target/release/examples/contour_bench /tmp/contour-sdf-dump
cargo test -p occlude-core --no-default-features --features contour-sdf --lib
pnpm check
```

[Raw results, hashes, native stage timings, and images](contour-sdf-results/)
are committed with the fixtures. The baseline uses the production WASM from
`ec721ae`; default-engine docs ink remains unchanged by the production fixes.
The first line-only SDF trial was substantially more fragmented under decimation;
the reported implementation includes arc reconstruction and safe cleanup joins.

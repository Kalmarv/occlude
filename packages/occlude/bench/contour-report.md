# Native contour fill — implementation and measurements

11 September 2026. Production WASM and release-native, single threaded. AMD Ryzen 5 3600 6-Core Processor, linux x64, Node v24.21.0. One warmup and five measured samples (saved artwork: one warmup and three samples). Shared host; timings are observations, not latency guarantees.

## Behavior

Use `fill('contour')`, optionally `{ spacing: mm(...) }`. Default spacing is 0.9 × the fill pen width, resolved before Rust dispatch and coarsened for drafts. Existing fills keep their original generators and ink. Native generation constructs the visible region after deformation, then offsets outer boundaries and holes together. Complete loops are linked by short, fully clipped connectors. Local vector hatches complete collapse residuals; short closed excursions can visit those patches without redrawing a regular contour edge. Intentional modifier gaps stay gaps.

Kernel dependencies: [cavalier_contours 0.9.0](https://docs.rs/cavalier_contours/0.9.0/cavalier_contours/shape_algorithms/struct.Shape.html) for line/arc offsets; [i_overlay 8.1.1](https://github.com/iShape-Rust/iOverlay) for winding normalization and Boolean regions. Valid source arcs and disjoint interior circular masks retain arcs. General Boolean intersections and cubics use bounded polygon approximations. No production raster coverage decisions.

Construction tolerance is `min(0.01 mm, width/20, spacing/10)`: curve flattening uses one quarter, quantization is guarded below one sixteenth at accepted coordinate magnitudes, kernel tolerances use small fractions, and inset clearance reserves one quarter. Regular levels are absolute offsets of the normalized source, so approximation does not accumulate with the level count. No area-based hole deletion or simplification pass is used.

Deterministic guards: 4,096 levels, 250,000 output primitives per fill job, source/curve conversion and offset work limits. Oversized or nonprogressing offset components discard provisional ink and use native hatch; thin remnants use hatch plus the established nib judge. Errors that cannot produce complete fallback coverage propagate through `try_finish` / WASM instead of returning partial success.

## Plot comparisons

A4, seed 42, Pigma 05 (0.45 mm). Figures below are fill-only and whole-sketch simultaneously because these fixtures have no outline. Internal lifts = runs − 1, excluding initial lowering/final raising. Bridged solid uses shape `bridge: mm(0.5)`. ETA uses the existing shared estimator: travel 6000 mm/min, draw/travel acceleration 1000/2000 mm/s², junction deviation 0.02, minimum cruise ratio 0.5, and the pen’s feed/settle values.

| Fixture | Solid runs / min | Bridged solid runs / min | Contour runs / min |
|---|---:|---:|---:|
| disc | 415 / 20.96 | 171 / 19.68 | 1 / 18.50 |
| rounded-rectangle | 395 / 25.45 | 43 / 23.62 | 1 / 24.07 |
| annulus | 602 / 18.47 | 481 / 17.97 | 2 / 14.71 |
| many-holes | 1,267 / 29.01 | 1,598 / 31.59 | 224 / 27.35 |
| U | 705 / 20.43 | 2 / 16.80 | 18 / 17.02 |
| dumbbell | 663 / 20.37 | 3 / 16.94 | 23 / 17.76 |
| small | 41 / 0.48 | 17 / 0.35 | 1 / 0.24 |
| repeated | 3,100 / 30.45 | 1,300 / 21.22 | 100 / 13.53 |

Disc and rounded rectangle each retain one run: 100% fewer internal lifts. Connected complex fixtures reduce internal lifts by 91.9% in aggregate. Contour improves ETA over default solid on every fixture. Bridged solid remains faster on the rounded rectangle, U and dumbbell. Extra motion matters; no global optimum is claimed.

Bridged solid adds ink (reported as its ink-length difference from default solid). Sampling every generic bridge at 33 points found no out-of-region samples on these fixtures; that diagnostic is not a whole-interval safety certificate for generic bridging. Native connectors receive exact whole-interval checks.

Full ink length, travel, primitive counts, transfer bytes, fallback counts and median/tail timings are in `contour-results.json`. The comparison script produces an HTML toolpath/ink viewer and SVGs under the ignored `contour-comparison/` directory.

### The saved contours-3 sketch

Only its solid fills were replaced; stipple, outlines, deformation, paper and pen stayed the same. Whole-sketch runs: 12,132 → 4,607. ETA: 279.65 → 133.75 minutes (52.2% less time).

Production-WASM render median: 940 → 2648 ms; planning/hash median: 39 → 78 ms. This is a substantial compute regression in exchange for reduced physical plot time; use draft quality for interactive edits. The 931 visible components include 776 thin remnants handled by local hatch/nib cleanup and two nonprogressing offset fallbacks. There are 82 final visibility splits on approximation-sensitive generated ink. These diagnostics are exposed in `result.stats.contour`.

A committed copy of this sketch and its single required pen are in `fixtures/contour/`; `contour-saved.mts` uses that pen snapshot, so it does not depend on a personal studio library. Existing saved artwork is not edited. The existing church oracle was also run unchanged: 15,601 chains, 96,037 mm ink, 16,515 mm travel, 381.0 min both before and after.

## Compute and parity

| Fixture | WASM render median / tail ms | WASM plan median / tail ms |
|---|---:|---:|
| disc | 6.85 / 16.14 | 0.18 / 1.72 |
| rounded-rectangle | 25.08 / 27.88 | 0.37 / 0.57 |
| annulus | 48.84 / 52.90 | 0.09 / 0.39 |
| many-holes | 213.43 / 218.51 | 10.50 / 11.29 |
| U | 18.25 / 20.43 | 0.41 / 0.77 |
| dumbbell | 31.52 / 33.11 | 0.70 / 1.32 |
| small | 0.50 / 0.51 | 0.02 / 0.04 |
| repeated | 40.00 / 42.63 | 2.29 / 2.84 |

WASM render measurements include sketch recording, TS encoding, both native passes and returned buffers. Planning is measured separately. Release-native stage timings are in `contour-native-results.jsonl`: residual geometry dominates the many-hole fixture; routing is a small indexed pass. Connector searches inspect nearby segments, certify at most 32 candidates per predecessor, and never build an all-pairs distance matrix. Total offset complexity is not claimed to be linear. Native peak RSS across the four measured scenes was about 10 MiB (`/usr/bin/time -v`); browser peak memory was not measured.

Native/WASM plan buffers are byte-identical on small/large discs and the repeated-disc fixture. The many-hole fixture has build-specific local residual routing (226 native vs 224 WASM runs), with small excursions differing by up to 0.203 mm in sampled centerline position. This is an outstanding cross-build routing difference, not byte parity. Both builds pass the same independent 2,492,529-point interior coverage diagnostic: zero uncovered samples, maximum centerline distance 0.209 mm with a 0.225 mm nib radius. Production output is deterministic within each build.

## Verification and limits

`pnpm check` passes every gate: Rust, library/studio tests and typechecks, all live docs, docs ink, production build and bundled-WASM hash. The new native fill example is the only added docs ink fixture.

Native coverage tests sample at 0.04 mm using independently flattened segment-distance queries, including disc, annulus, rectangle, acute corner, U, dumbbell, sliver and tiny-disc cases. A regression specifically covers lens-shaped residuals where expanding hole fronts collide. Separate tests retain a tiny hole through Boolean normalization and exercise deterministic fallback. Real-WASM tests cover ordered plans, reversal/export continuity, clipped islands, nested clips, fill pen independence, tiny taps, spacing errors, dash/decimation gaps, post-wobble visibility, and mirrored/nonuniformly scaled cubic geometry with pre-smoothing. Playwright checked the live docs example, native read-only card, and comparison viewer.

The round-nib contract covers nib-reachable interiors within the tolerance. Mathematical corner coverage with a strictly contained whole nib is not promised; thin features use established centerline/nib semantics. Wide spacing is texture, not solid coverage. Modifiers can fragment runs. Long runs make whole-chain selections coarser. Pathological intersection-heavy input can still be expensive inside a kernel operation before deterministic limits reject it. Native fills cannot be cloned as executable JS assets.

Protocol: shape floats are stride 3 (`z`, generic bridge tolerance, native spacing), with legacy stride-2 scene dumps still readable; fill kind 3 is native contour. Fragment stride is 9, adding run identity and traversal interval to the legacy six fields. TS and Rust serializers/planners change together. Plan schema remains 1: its primitive order already preserves atomic runs, and later exports do not remerge them. The golden scene’s shape buffer gains zero spacing fields; existing golden ink stays unchanged.

## Reproduction

```sh
cargo test -p occlude-core
pnpm run build:wasm
pnpm --filter occlude exec tsx bench/contour.mts
pnpm --filter occlude exec tsx bench/contour-saved.mts
pnpm --filter occlude plotstats bench/fixtures/contour/disc-contour.ts --pens docs --seed 42
pnpm --filter occlude dump-scene bench/fixtures/contour/many-holes-contour.ts /tmp/contour-holes-dump --paper A4 --pens docs --seed 42
cargo run -p occlude-core --release --no-default-features --features profile --example contour_bench -- /tmp/contour-holes-dump
pnpm --filter occlude exec tsx bench/contour-parity.mts /tmp/contour-holes-dump
DOCS_PAGE=fills pnpm --filter occlude docs:check
pnpm check
```

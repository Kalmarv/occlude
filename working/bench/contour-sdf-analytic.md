# Analytic distance-contour qualification

Implemented and release-verified, 12 September 2026. `fill('contour')` now uses
native analytic distance contours by default. Public spacing, pen, clipping and
modifier semantics remain unchanged. The preceding offset engine remains
available for comparison builds with default features disabled.

All 120 Rust feature tests pass; `pnpm check` passes every gate. The production-
served 0.01 mm sketch completed its full worker request in **17.565 seconds**,
with no fallback, visibility split or browser error. The exact deployed WASM
checksum is `69fff671532cafdceebc6ed080cfdbe5`.
[Production observation](contour-sdf-analytic-results/production-studio.json),
[release gates](contour-sdf-analytic-results/verification.txt),
[live documentation](../../../docs/fills.md#contour),
[Playwright documentation screenshot](contour-sdf-analytic-results/docs.png).

## Timing and memory optimizations

The visibility continuation optimization leaves the checked 0.01, 0.10, 0.45
and 1.00 mm plans byte-identical. It reuses a certificate only when a rectangle
containing both the entire primitive and a known visible point is clear of all
source, clip and occluder boundaries. Debug builds check reused certificates
against full clipping. Open contour records retain the original calculation.

Three fresh-browser checks of the final candidate completed the full worker
request in **17.697, 17.269 and 18.114 seconds**, including sketch execution,
planning, hashing and transfer. This is the interval governed by Studio's
unchanged 20-second watchdog; raw Rust render time alone is insufficient.
[Candidate observations](contour-sdf-analytic-results/release-candidate-studio.json).

Fixed-size contour adjacency and early release of temporary node coordinates
remove millions of small allocations. All 100 width plans remained byte-identical,
with a 14.503-second maximum isolated render in that sweep. The final guarded
candidate retains the checked plans. Oversized level counts are rejected before
integer conversion on 32-bit WASM, and temporary event/residual storage has
explicit work budgets.
[Full compact-storage sweep](contour-sdf-analytic-results/compact-widths.jsonl),
[final plan and memory checks](contour-sdf-analytic-results/guarded-widths.jsonl).

## Construction

The build uses pinned `boostvoronoi` 0.12.1 (BSL-1.0). Boolean
normalization remains separate. Point/segment Voronoi cells give analytic
constant-distance lines and arcs; vector medial branches supply residual marks.
There is no production raster coverage mask. Source curves are approximated
within the documented aggregate paper-space budget in `sdf.rs`; inset levels do
not recursively accumulate error. Original source geometry certifies generated
ink before ordinary finishing modifiers.

If that certificate fails on curved input, normalization is rebuilt from the
original curves at tighter tolerance, up to four attempts. It cannot recover
information by refining an already flattened polygon. Budget/input failures are
not retried. The appended render diagnostic `geometryRefinements` counts retries;
older stats buffers decode that field as zero. Primitive and run strides do not
change.

Loops use one entry/exit portal. Indexed joining considers adjacent levels and
whole-interval-certified short connectors. Branching routing stops after 32,768
parent portals or eight million candidate projections per component. It retains
all remaining loops and residual marks, accepting additional lifts. Sparse
spacing retains its requested spacing through fallback. Modifiers keep their
existing semantics and may deliberately fragment or displace ink.

Exact-collinear forward line pieces and adjacent pieces of the same circle may
be coalesced. Arc sweeps remain at most a half-circle. A direct test checks that
this does not remove reversals or add a lap.

## Current evidence

All 100 widths from 0.01 through 1.00 mm passed before the byte-preserving
allocation optimizations, with no fallback or visibility split. The slowest render was 17.008 seconds at
0.01 mm; the largest decoded chain gap was 1.43e-13 mm.
[Full results](contour-sdf-analytic-results/widths.jsonl).

The real-WASM cubic ribbon is 0.005 mm thick, one existing input-grid step.
It renders one 100.24 mm run rather than disappearing. A 0.0002 mm authored
ribbon collapses at the existing scene-input snap before reaching either fill
engine; that smaller thickness remains a native test for post-snap geometry.
[WASM ribbon result](contour-sdf-analytic-results/cubic-strip.jsonl).

Measured on an AMD Ryzen 5 3600, Linux x86-64, Node 24.21.0. The finest-width
fixture is `fixtures/contour-sdf/recursive-variable.ts`, seed 42, 304.8 mm square,
0.01 mm nib. The final WASM candidate completed a real Playwright
Studio render in **13.160 seconds of raw rendering and 17.565 seconds for the full worker request**, with 2,054,647 fragments, 2,918,827 generated
fill primitives, zero fallbacks, zero validation splits, and no browser errors.
This is one browser observation, not a tail-latency guarantee.
[Recorded result](contour-sdf-analytic-results/production-studio.json) and
[Playwright screenshot](contour-sdf-analytic-results/production-studio.png).

The final isolated fine-width sample took 14.126 seconds to render; this
benchmark includes TypeScript sketch execution and decoding, and measures
planning separately. Studio's raw render statistic and full worker interval
have different scopes. These observations are not tail-latency guarantees on
other machines or under arbitrary competing load.

The thin cubic regression tests 0.03 and 0.0002 mm ribbons at normal and 10×
horizontal scale. It checks coverage along the actual ribbon, exact visibility
of each emitted primitive, and that the difficult case exercised refinement.
The attached-finger test likewise targets the actual feature, not only an erosion.

The final candidate's independent native vector diagnostic checked 141,738
points of the original fine-width region: maximum centerline distance
0.00474942 mm, below the 0.005 mm nib radius, with zero misses. At 0.45 mm,
148,827 probes gave a maximum distance of 0.22035039 mm, below the 0.225 mm
nib radius, also with zero misses. Both runs had zero fallbacks or visibility
splits. Sampling is diagnostic evidence, not a universal proof.
[Fine-width coverage](contour-sdf-analytic-results/vector-01.jsonl),
[ordinary-width coverage](contour-sdf-analytic-results/vector-45.jsonl).

## Final standard WASM comparison

A4, pinned Pigma 05, seed 42; one warmup and three measured samples. Values
below are fill-only runs / estimated plot minutes. Full ink lengths, pen-up
travel, geometry sizes, medians and tails are in the
[raw results](contour-sdf-analytic-results/standard.json).

| Fixture | Solid | Bridged solid | Contour |
| --- | ---: | ---: | ---: |
| disc | 415 / 20.96 | 171 / 19.68 | 2 / 18.52 |
| rounded-rectangle | 395 / 25.45 | 43 / 23.62 | 3 / 23.52 |
| annulus | 602 / 18.47 | 481 / 17.97 | 2 / 14.81 |
| many-holes | 1267 / 29.01 | 1598 / 31.59 | 474 / 26.36 |
| U | 705 / 20.43 | 2 / 16.80 | 31 / 16.56 |
| dumbbell | 663 / 20.37 | 3 / 16.94 | 33 / 17.08 |
| small | 41 / 0.48 | 17 / 0.35 | 1 / 0.25 |
| repeated | 3100 / 30.45 | 1300 / 21.22 | 100 / 13.15 |

Contour improves ETA against unbridged solid on every fixture. Internal lifts
across annulus, many-holes, U and dumbbell fall by 83.4% in aggregate. The
many-hole case improves less individually (62.6%); bridged solid remains
slightly faster on dumbbell. The rounded rectangle needs three runs including
cleanup, exceeding the original two-run target; later user guidance permits
independent insets, but this exception is still recorded. No fallback or
visibility split occurred in these contour cases. Generic-bridge outside-ink
counts use samples, not a whole-interval containment certificate.

## Release-native measurements

Serial release-native build, one warmup and three samples. Generation median /
tail and planning median / tail, in milliseconds:

| Fixture | Generation | Planning | Primitives / runs |
| --- | ---: | ---: | ---: |
| small | 0.068 / 0.071 | 0.005 / 0.006 | 62 / 1 |
| disc | 0.500 / 0.619 | 0.030 / 0.038 | 621 / 2 |
| many holes | 369.908 / 372.231 | 39.195 / 43.201 | 138404 / 474 |
| repeated | 3.924 / 4.759 | 0.783 / 0.785 | 4700 / 100 |

[Raw native stages](contour-sdf-analytic-results/native.jsonl). These timings
include profiling instrumentation and exclude TypeScript/WASM transfer. They
are separate from physical plot ETA. Counts match the corresponding WASM cases. The four-fixture process peaked at
99,296 KiB RSS, measured with `/usr/bin/time -v` around the already-built native
executable; compilation is excluded. [Memory observation](contour-sdf-analytic-results/native-memory.txt).
The fine-width WASM process reached 2,870,804,480 bytes of linear-memory capacity
after rendering and planning; at 0.45 mm this was 111,869,952 bytes. Linear memory
does not shrink and excludes JavaScript/DOM memory; it is not total process RSS.
[WASM memory observations](contour-sdf-analytic-results/guarded-widths.jsonl).

Reproduce native inputs with `pnpm --filter occlude dump-scene
bench/fixtures/contour/<name>-contour.ts /tmp/<name> --paper A4 --pens docs
--seed 42`, using names `small`, `disc`, `many-holes`, and `repeated`, then run:

```sh
SAMPLES=3 cargo run --release --no-default-features --features contour-sdf,profile \
  --example contour_bench -- /tmp/small /tmp/disc /tmp/many-holes /tmp/repeated
```

## Reproduce

From the repository root, build a separate comparison package with matching
JavaScript glue (the package has WASM entropy imports):

```sh
wasm-pack build crates/occlude-core \
  --target web --out-dir /tmp/occlude-sdf-analytic-pkg \
  --features wasm,contour-sdf --no-default-features
cargo test -p occlude-core --no-default-features --features contour-sdf
BENCH_BINDINGS=/tmp/occlude-sdf-analytic-pkg/occlude_core.js \
  pnpm --filter occlude exec tsx bench/contour-sdf-limits.mts
BENCH_BINDINGS=/tmp/occlude-sdf-analytic-pkg/occlude_core.js \
  node packages/occlude/bench/contour-sdf-widths.cjs \
  /tmp/occlude-sdf-analytic-pkg/occlude_core_bg.wasm \
  packages/occlude/bench/fixtures/contour-sdf/recursive-variable.ts \
  /tmp/contour-widths.jsonl
BENCH_WASM=/tmp/occlude-sdf-analytic-pkg/occlude_core_bg.wasm \
  BENCH_BINDINGS=/tmp/occlude-sdf-analytic-pkg/occlude_core.js \
  BENCH_OUT=/tmp/contour-standard SAMPLES=3 \
  pnpm --filter occlude exec tsx bench/contour.mts
```

The width harness enforces 20 seconds for render and separately allows 30
seconds for planning. Real Studio verification is additionally required. The
standard benchmark compares default solid, bridged solid, and native contour
using the existing shared plot-time estimator.

## Research basis and limits

[Boost Voronoi's pinned documentation](https://docs.rs/boostvoronoi/0.12.1/boostvoronoi/)
defines its point/segment input restrictions. Quantization is followed by exact
integer topology checks rather than assuming normalized floating-point contours
remain valid after conversion.

[Mansor, Hinduja and Owodunni (2006)](https://www.sciencedirect.com/science/article/abs/pii/S0010448505001661)
and [Park and Choi (2001)](https://www.sciencedirect.com/science/article/pii/S0010448500001093)
motivate using Voronoi/medial geometry for local uncut regions and pocket paths.
Only the accessible abstract/introduction of the former was reviewed. Our
specific residual hull tests, routing budgets, and performance measurements are
implementation choices, not performance guarantees quoted from these papers.

Final release verification passed repository `pnpm check` and the
deployed Studio check. The Church oracle remains unchanged at 15,601 chains,
96,037 mm ink, 16,515 mm pen-up travel, and 381.0 estimated minutes. No claim of universal
geometry correctness or globally optimal plot time is made.

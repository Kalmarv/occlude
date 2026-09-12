# Contour cleanup: retained ink and finite coverage cells

Fixture: [`thicken-contour-residual.ts`](fixtures/thicken-contour-residual.ts), seed 42,
304.8 × 304.8 mm (12 inches), final quality. Every pen width `n / 100` mm,
`n = 1..100`, uses default contour spacing `0.9 * width`. The sketch includes
its original decimation and independent outline.

## Implementation

Valid contours survive offset failure. Cleanup starts with the whole visible
component minus conservative round-nib sweeps of the retained, visibility-valid
ink. This includes first-inset losses and attached fingers. An optional center
stroke/ring proposal gets one additional subtraction; there is no recursive
subtract-and-retriangulate cleanup loop.

Earcut 0.4.11 proposes a residual triangulation. Adaptive orientation predicates
from robust 1.2.0 check it on the original coordinates: all triangle boundaries
must cancel to precisely the source outer boundary and holes. Positive triangle
orientation and that boundary identity exclude compensating overlaps/gaps;
area agreement alone is not accepted. If translation rounded distinct vertices
together, one proposal in the original frame gets the same validation.

Each triangle is assigned to a single covering capsule, or divided into bands.
The lower/wider cross-section of each longest-edge band covers its orthogonal
projection. A bounded contraction keeps the segment inside the triangle, and
the actual emitted segment must cover every band vertex and pass whole-interval
visibility. Extended strokes can overlap adjacent ink when they pass those same
checks. This uses work proportional to triangle altitude / nib width, without
recursive subdivision into nib-sized triangles. Nearby cleanup joins use mutable
spatial buckets, bounded candidate enumeration and no rescanning of growing runs.

Cavalier Contours 0.9.0 still supplies line/arc offsets. A nonfinite/nonmonotonic
inset triggers absolute polygon offset recovery with i_overlay 8.1.1. Dense
contour proposals stop at 64,000 primitives per component to reserve footprint
union memory and completion work; emitted contours stay, and coverage continues.
The overall output allowance rises from 250,000 to four million primitives.
Sparse fills retain their requested hatch spacing and skip dense completion.

The existing millimetre error budget remains `min(0.01, width/20, spacing/10)`.
Flattened contour sweeps reserve error inside the nib, and the first contour has
a small coverage margin to avoid an unnecessary outer cleanup lap. Polygon
Booleans remain a rounded i64 construction, not an exact-real topology solver.
Unresolved partition, visibility, precision or work failures remain explicit
errors; partial coverage is not represented as success.

No WASM protocol or public API change. No change to post-modifier semantics.
Decimation and displacement can still deliberately remove or move certified ink.
Only the `fills#5` documentation ink golden changes: its contour inset and cleanup
geometry are intentionally different. Other documentation examples retain their ink.

## Measurements

Hardware/runtime: Linux x86_64 under KVM, AMD Ryzen 5 3600, eight exposed CPUs;
Node 24.21.0. Native release uses `--no-default-features` (serial, like WASM).
The WASM sweep freezes both its bundled TypeScript and the production WASM file
before starting, so rebuilding the package cannot mix binaries within a sweep.
Each width runs in a new process, with a 20-second process limit covering render,
and for WASM also planning and decoded-chain checks. Native and WASM sweeps run
concurrently in separate serial processes. These are cold single samples at each
width, not warm statistical percentiles for a repeated identical input.

The production baseline `b0fa1689725ad6693a0bb29d49a4c91e9c2a72b1` failed 87 of
100 native widths. Baseline raw results are in `contour-width-results/native-before.jsonl`.
Final results: **100/100 native and 100/100 WASM widths passed**, with zero
render errors or 20-second timeouts. The slowest native render was
7.75 s; the slowest WASM render was
14.14 s, and the largest WASM plan time was
0.81 s. Every decoded plan passed continuity checks;
the maximum endpoint gap was 1e-11 mm.

Raw results are in `contour-width-results/native-after.jsonl` and
`contour-width-results/wasm-after.jsonl`, with a machine-readable `summary.json`.
All widths have matching native/WASM contour, residual-component and fallback
counts. Final fragment counts differ by at most 15 between builds; this is not
a cross-build bitwise-equivalence claim. Repeated same-build geometry/plan
identity is checked in the WASM integration tests.

The frozen production WASM SHA-256 was
`98ebbcb372bb2e8128d7be13f12459e31faee6239b4cfe076c1800b09c7a34d2`.
At 0.01 mm a separate native `/usr/bin/time -v` replay measured peak RSS of
540,264 KiB (528 MiB). Browser/WASM peak memory was not measured. That width
produces roughly 572,000 final fragments, so it remains a large browser job.

Repeated 0.45 mm measurements: serial release native, one warmup plus five
samples, render median/tail **4,879 / 4,945 ms** and planning **18 / 25 ms**.
Chromium Studio's existing worker, one initial render plus three warm renders,
reported **6,048 / 6,197 ms** median/tail render time. All three warm browser
renders had 42,997 fragments and 43,016 planned primitives. Raw warm results
are also committed alongside the sweeps.

Studio was exercised through Playwright/Chromium with its actual render worker,
the fixture loaded in Monaco, 12-inch custom paper, and pen widths 0.01, 0.40 and
0.45 mm. All three rendered with `ok` status and no page errors. Worker render
times were 10,079.8, 4,510.4 and 9,577.7 ms respectively. Fresh-page elapsed times
also include editor/module loading and painting and are not worker render times.

The large speed improvement at very narrow widths comes from controlling the
swept union, not from claiming that narrow-nib coverage is free. An experimental
200,000-contour-primitive allowance spent about 18 seconds in the sweep at 0.01
and 0.02 mm in native code. At 64,000, that stage took about 3 seconds and full
native runs about 7.4 / 6.4 seconds. These diagnostic runs are not repeated medians.

Plotstats, with the same shared estimator and default plan settings:

| Scene | Version | Chains | Draw mm | Travel mm | ETA min |
|---|---|---:|---:|---:|---:|
| Recursive fixture, default pens | production baseline | 8,680 | 69,421 | 9,442 | 229.4 |
| Recursive fixture, default pens | this change | 8,925 | 70,021 | 9,188 | 234.7 |
| church.ts | baseline and this change | 15,601 | 96,037 | 16,515 | 381.0 |

The additional coverage costs about 2.3% plot ETA on the recursive fixture. This
is a rendering reliability/coverage improvement, not a claim of faster physical
plotting for that sketch. Thin widths can produce substantial band cleanup and
many runs, especially after decimation; contour texture may change when proposal
work reaches its allowance.

## Reproduce

From the repository root:

```sh
pnpm run build:wasm
pnpm --filter occlude dump-scene bench/fixtures/thicken-contour-residual.ts /tmp/contour-width-scene --seed 42 --paper 304.8x304.8
cargo build -p occlude-core --release --no-default-features --example contour_widths
python3 packages/occlude/bench/contour-widths-native.py target/release/examples/contour_widths /tmp/contour-width-scene
pnpm --filter occlude exec node bench/contour-widths.cjs 1 100
pnpm --filter occlude plotstats bench/fixtures/thicken-contour-residual.ts --seed 42 --paper 304.8x304.8
pnpm --filter occlude plotstats ../occlude-studio/sketches/church.ts --seed 42
pnpm check
```

For native stage timings, build the example with `--features profile`, then run
`target/release/examples/contour_widths /tmp/contour-width-scene 1` (hundredths of
one millimetre). Stage timers are nested and must not all be added together.

For browser verification, start Studio and run
`node packages/occlude/bench/contour-studio.cjs http://127.0.0.1:4175 /tmp/contour-browser`.
This requires Playwright's Chromium and `playwright-core`. The script uses an
isolated browser context and overrides pen responses locally; it does not modify
the shared pen library. It records screenshots, status, render times and errors.

## Verification and remaining limits

`pnpm check` passed all eight gates: Rust tests, TypeScript tests, library and
Studio types, live docs, the docs ink oracle, production build, and WASM byte
parity. The focused corpus includes 22 native contour tests and 15 real-WASM
integration cases. Coverage is measured directly along finger edges/tips and
curved residual strips, as well as across convex bands. Counterexamples test
compensating mesh overlap/gaps, lost holes, coordinate-translation collapse,
different vertices assigned to different capsules, and arc inner-hole mistakes.
Modifier breaks, displacement semantics, whole-interval visibility and decoded
run continuity remain covered.

The passing 100-width fixture is not a universal runtime guarantee. More complex
artwork can still hit deterministic work/precision limits or Studio's 20-second
watchdog. Dense completion can become band-like when offsets stop; overlapping
marks trade some ink and lifts for reliable coverage. No global optimality,
complete medial-axis solver or exact-real Boolean fallback is claimed.

For warm browser samples, use `WIDTHS=0.45 SAMPLES=3` with the Studio harness.
The existing `contour_bench` native example provides one warmup and five samples
on a supplied scene dump; the recorded warm dump uses a 0.45 mm fill pen and
0.405 mm contour spacing. The all-width native harness overrides these values
explicitly, so its results do not depend on the saved pen width in the dump.

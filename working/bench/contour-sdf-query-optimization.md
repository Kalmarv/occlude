# SDF query performance — 12 September 2026

The [analytic-distance qualification report](contour-sdf-analytic.md) tracks the
replacement experimental extractor and its remaining release gates. Measurements
below describe the earlier sampled implementation.

This pass speeds up the experimental SDF engine while preserving its ink. Against
fresh measurements of `25ed85a`, render medians improve **5–9%** on the three
recursive fixtures. Encoded plans and exported path SVGs match byte for byte,
including the additional variable-radius fixture without outlines or decimation.

**The release blockers remain.** Fine dense widths still exceed 20 seconds;
constant/radial plot ETA is still worse than production; the aggregate contour
accuracy contract is still uncertified. Production retains its existing engine.

## Measurements

Both experimental WASM binaries were measured serially in this session, with one
warmup and three measured renders per normal fixture. Tail is the largest of
three samples, not a percentile. Same pinned pens, seed 42, 304.8 mm square paper,
5% margin, and machine settings as the [previous report](contour-sdf-optimization.md).
Linux x86-64 VM, eight exposed vCPUs, AMD Ryzen 5 3600 model, Node v24.21.0.

| Fixture | Before median / tail | After median / tail | Median reduction | Unchanged whole-sketch runs | Unchanged plot ETA |
| --- | ---: | ---: | ---: | ---: | ---: |
| Variable | 7.925 / 8.011 s | 7.504 / 7.743 s | 5.3% | 40,675 | 935.8 min |
| Constant | 7.089 / 7.111 s | 6.483 / 6.630 s | 8.5% | 34,577 | 783.1 min |
| Radial | 7.630 / 7.843 s | 7.113 / 7.253 s | 6.8% | 32,194 | 734.3 min |

Fresh baselines matter: comparison with the older archived timings would suggest
23–26% improvement. The freshly rerun previous binary was also faster on this VM,
so that larger number is not attributed to this code change. This is a compute
improvement; physical plot ETA and ink geometry are unchanged.

The final native 0.1 mm diagnostic still takes **47.061 seconds**, with 848,053 fill
primitives, 26,263 contours, and 128,611 cleanup patches. Peak RSS is 513,684 KiB
(501.6 MiB). These are a single native probe, not repeated median/tail figures.
The pre-change exploratory probe took 52.808 seconds. Profiling still puts a large
part of the cost in coverage. Nested profile zones must not be summed as disjoint
stages. Hardware `perf` sampling was unavailable (`perf_event_paranoid=4`); the
host configuration was left intact and the existing Rust profile zones were used.

A fresh cold WASM probe with the external 20-second render watchdog gave:

| Width | Result |
| --- | --- |
| 0.10, 0.20, 0.22 mm | Timed out |
| 0.24 mm | 17.527 s |
| 0.25 mm | 18.349 s |
| 0.45 mm | 7.957 s |

This selected probe is not a replacement for the previous 100-width sweep, nor a
claim that all other widths now pass. Timed-out cases have no success result.

## Retained changes

- Reuse the existing integer-key `FxHashMap` for internal sample, graph, sign-row,
  and cleanup lookup tables. Their iteration order does not determine the ink.
- Seed neighboring distance queries with an actual boundary segment from the
  previous query. Its distance supplies an upper bound for BVH pruning. The full
  search still computes the nearest distance; no guessed radius excludes geometry.
- Cache only the sampled distance. Coordinates and identity are reconstructed
  from the integer grid key. Each cached value is 8 bytes instead of 32 bytes.
- Use stack buffers for the already bounded coverage candidate and interval
  searches, removing repeated temporary allocations without changing their limits
  or order.

The new regression checks bit-identical nearest distances on 4,000 queries and
verifies that coherent hints reduce BVH visits. There are no public API,
protocol, spacing, geometry-budget, modifier, or production-WASM changes.

## Experiments and research

Several more elaborate experiments failed to improve the actual corpus and were
removed: merged parallel-band certificates, directional binary coverage cells,
near-flat boundary coarsening, and per-cell source-feature candidate sets. The
near-flat variant still generated the same 5,075,930 samples and 5,626,298 raw
edges on the 0.1 mm fixture. Adding vector residual proposals before full SDF
verification took 15.941 s at 0.45 mm versus the simpler pass's 5.434 s native
probe, and increased output. These exploratory single-probe measurements are
recorded in [rejected-experiments.json](contour-sdf-query-results/rejected-experiments.json).

The [ADF paper by Frisken et al.](https://www.ronaldperry.org/sig2000_ADFs_Paper.pdf)
and [Keeter's 2D contouring explanation](https://www.mattkeeter.com/projects/contours/)
support adapting field sampling to local complexity and preserving shared topology
across differently sized cells. They do not establish our coverage or accuracy
contract. The experiment that coarsened nearly flat boundary chains did not reduce
sampling on this fixture, so it was removed.

[Sullivan et al.'s composite ADF machining paper](https://merl.com/publications/docs/TR2012-025.pdf)
localizes analytic/procedural fields in a spatial hierarchy and computes the
remaining workpiece implicitly. This is useful guidance for limiting expensive
geometric operations, but it does not supply a plotter cleanup planner. No code
from these publications was copied. The next work must reduce cleanup work and
extra ink, while retaining independent validation against the original material.

## Verification and reproduction

- `pnpm check`: all eight gates passed; production WASM MD5 remains
  `9971e98cb6e9eb1a5e6b5d14d6267acb`.
- 39 Rust library tests passed with `contour-sdf` enabled, including actual
  thin-finger/sliver coverage and the new exact-distance regression. This does not
  claim that the experimental engine passes the old one-atomic-run integration
  assertions; those tests were not weakened.
- Repeated plans are deterministic. Before/after encoded plans and SVGs are
  byte-identical on all four comparison fixtures; see
  [identity.json](contour-sdf-query-results/identity.json). Consequently their
  previously measured coverage and texture are unchanged.
- Playwright verified the final experimental WASM in the actual Studio worker:
  7,443.6 ms, 119,887 fragments, 156,063 fill primitives, one WASM interception,
  pinned pens intercepted, and no page errors. See the
  [worker result](contour-sdf-query-results/studio.json) and
  [screenshot](contour-sdf-query-results/studio.png).
- Church is unchanged: 15,601 chains, 96,037 mm ink, 16,515 mm travel, 381.0 min.

Run from the repository root:

```sh
wasm-pack build crates/occlude-core --target web --out-dir /tmp/occlude-sdf-pkg --features wasm,contour-sdf --no-default-features
SKIP_CURRENT=1 node packages/occlude/bench/contour-sdf-compare.cjs /tmp/occlude-sdf-pkg/occlude_core_bg.wasm /tmp/sdf-query-comparison
node packages/occlude/bench/contour-sdf-widths.cjs /tmp/occlude-sdf-pkg/occlude_core_bg.wasm packages/occlude/bench/fixtures/contour-sdf/recursive-variable.ts /tmp/sdf-query-comparison/widths.jsonl 10,20,22,24,25,45
BENCH_PENS=packages/occlude/bench/fixtures/contour-sdf/pens.json node packages/occlude/bench/contour-sdf-studio.cjs /tmp/occlude-sdf-pkg/occlude_core_bg.wasm packages/occlude/bench/fixtures/contour-sdf/recursive-variable.ts /tmp/sdf-query-studio
cargo test -p occlude-core --no-default-features --features contour-sdf --lib
pnpm check
```

The [first report](contour-sdf-report.md) has native scene-dump/replay commands.
[Raw current and fresh baseline measurements](contour-sdf-query-results/) include
build hashes, finite/continuity checks, and gate outputs. This pass does not
qualify SDF for promotion to the default fill engine.

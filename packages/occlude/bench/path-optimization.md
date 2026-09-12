# Optional plot-path optimization

Measured 12 September 2026 on AMD Ryzen 5 3600, Node 24.21.0, production WASM. The committed recursive fixture reproduces seed 185591647 on 304.8 × 304.8 mm paper with the hop pen. The machine profile, including its measured lift map and delays, is pinned in `path-optimization-profile.json`. These are estimated physical durations from Occlude's existing estimator, not measured machine runs.

| Path | ETA min | Internal lifts | Ink m | Pen-up travel m | Primitives |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original normal plan | 309.75 | 23,373 | 102.931 | 14.626 | 326,106 |
| Permissive fitting alone (0.1 mm) | 310.48 | 23,373 | 102.804 | 14.626 | 182,122 |
| Additional ordering and closed-loop seam placement | 309.18 | 23,373 | 102.931 | 13.706 | 326,316 |
| Panel best, joins up to 0.2 mm | 276.61 | 20,153 | 103.222 | 13.282 | 329,453 |
| Panel best, joins up to 1 mm | 225.22 | 15,011 | 106.072 | 11.081 | 334,503 |

The 1 mm setting saves **84.53 minutes (27.3%)** and 8,362 internal lifts, at the cost of 3.141 m of added connector ink. At 0.2 mm, it saves **33.15 minutes (10.7%)** and 3,220 lifts. The winning alternative in both cases omits fitting: fewer segments did not make this sketch faster. About 74.5% of the original ETA was pen-cycle time.

The panel includes the unchanged original in its comparison. Requested settings, tighter fitting, and joining/ordering without fitting are evaluated from the same original using the shared machine estimator. A slower candidate cannot be applied. These are bounded local alternatives, not a globally optimal tour.

## Follow-up: extend both ends

The first table records release `85cdffd`. A subsequent measured improvement extends both ends of each eligible run, with the same connector distance and full visibility checks. It does not redraw paths to reach another endpoint.

| Panel setting | ETA min | Internal lifts | Joins | Ink m | Travel m | Search s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.2 mm, both ends | 268.60 | 19,375 | 3,998 | 103.301 | 13.391 | 4.53 |
| 1 mm, both ends | 215.61 | 14,073 | 9,300 | 106.461 | 10.642 | 22.19 |

At 1 mm this saves **94.15 minutes (30.4%)** against the original and another 9.62 minutes against tail-only joining. It adds 3.530 m of connector ink. The extra endpoint search raises the 1 mm computation cost; computation remains explicitly requested and cancellable. The 0.2 mm result saves 41.15 minutes (13.3%). Measurements are in `results/path-optimization-two-ended.json`.

## Further experiments and next candidates

A benchmark-only per-chain fitting experiment (`path-optimization-explore.mts`) chooses among original and three fitted alternatives using the existing estimator's drawing time for each intact chain. Applied after the first release's 1 mm joins, it saves another **30.29 seconds**, changes 4,398 chains, and reduces commands from 379,081 to 317,472 in 1.24 seconds of extra computation. Without joins it saves 21.50 seconds. It is not enabled in the panel: the gain on this fixture is modest compared with eliminating lifts. Measurements are in `results/path-optimization-per-chain.json`, from `85cdffd`.

```sh
pnpm --filter occlude exec tsx bench/path-optimization-explore.mts recursive
```

The next substantial candidates are:

- Choose a join point along a closed loop rather than only at its current seam. This needs an indexed nearest-segment search, exact splitting, a shared entry/exit point, and the same visibility certificate. A loop must still be drawn once.
- Compare a small number of join priorities. Nearest-first choices can strand other endpoints; a bounded matching or alternate traversal order may reduce lifts further without increasing the allowed gap.
- Rank candidate connections by heading as well as distance, then measure complete alternatives with the shared estimator. A shorter connection can still create a slower sharp turn.

These are proposed experiments, not measured improvements. The existing vpype/AxiDraw features establish merge/sort/reverse and closed-loop seams as useful tools, but do not supply Occlude's visibility or ordered-run contracts. Broad simplification and more 2-opt alone are lower priorities for this sketch because pen cycles dominate.

## Geometry and safety

Fits replace connected short line spans with bounded-deviation lines or circular arcs. They retain original curves, taps, sharp corners and breaks. Joins add ink only within one unambiguous shape and pen; the whole connector passes the existing primitive visibility kernel, including clipped occluders. Contour runs may join when their fill already permits connectors. `connectors: false`, finishing modifiers and ambiguous provenance remain protected. Closed-loop seam relocation changes the cyclic starting point without removing or duplicating ink. All accepted geometry stays in the shared plan used by preview, simulation, export, saved results and plotting.

The numerical deviation guarantee is relative to original line spans; normal machine flattening tolerance applies additionally. The fitting tolerance is not a promise that a wider setting will improve ETA. More permissive joins allow more added ink. No change is made to ordinary rendering or fill generation.

## Computation

Single regression run: raw WASM fitting 0.09–0.25 s, additional routing 0.18 s, joining 0.2 mm with fitting/order 1.27 s, joining 1 mm alone 4.98 s. Complete panel searches including three alternatives and machine-path estimates took 4.57 s at 0.2 mm and 14.26 s at 1 mm. These are single samples with other verification work running; they are not latency promises. The dedicated worker is cancellable. Numeric source geometry is retained for optional visibility checks, increasing retained memory; no extra fill generation happens on normal renders.

A separate release-native 120-wave benchmark (35,880 → 2,280 primitives, fitting plus routing) used two warmups and ten measured runs: median 13.92 ms, p90 14.08 ms. This smaller fixture is not directly comparable to the large WASM scene.

## Reproduce

From the repository root:

```sh
pnpm run build:wasm
pnpm --filter occlude exec tsx bench/path-optimization.mts recursive
pnpm --filter occlude exec tsx bench/path-optimization.mts wave
cargo run --release -p occlude-core --example optimize_paths
pnpm --filter occlude exec vitest run test/optimization.test.ts
pnpm --filter occlude-studio test
pnpm --filter occlude plotstats ../occlude-studio/sketches/church.ts --seed 42
pnpm check
```

The `.ts` fixtures can also be pasted directly into Studio; select Custom paper at 12 × 12 inches. Raw measurements: `results/path-optimization-recursive.json`. The church oracle remained 15,601 chains, 96,037 mm ink, 16,515 mm travel and 381.0 estimated minutes. All existing docs ink hashes remained identical; only the new plotting example received a new baseline entry.

Native and real-WASM tests cover fitting deviation, corners, discontinuities, contour-run permissions, complete connector clipping, nested clips and clipped occluders, closed-loop seam continuity, deterministic serialization and export. Studio tests cover choosing the fastest alternative and preserving original bytes, applying/restoring selections and rejecting stale results. Playwright covers comparison without adoption, apply/restore, cancellation, rerender invalidation and export.

## Prior art consulted

- [vpype commands](https://vpype.readthedocs.io/en/latest/reference.html): merge before sorting; reversible paths and 2-opt; closed-loop starting points.
- [AxiDraw API](https://axidraw.com/doc/py_api/): optimization on a plotting copy, endpoint joining, reversible ordering, preview timing.
- [saxi](https://github.com/alexrudd2/saxi): path reordering/reversal to reduce pen-up motion. Ideas only; no source copied.

Occlude already had greedy ordering and 2-opt. The useful additions here are eligible contour joins with full visibility checks, continued search across the existing tour, closed-loop seam placement, and choosing by actual shared ETA instead of primitive count.

## Automatic fidelity-constrained search

See [the detailed Auto design](path-auto-design.md) for the metric, numerical contract, localized vector work, search schedule and implementation gates.

Auto is now implemented. See [the measured Auto results](path-auto-results.md) for the current behavior, performance and limits. It compares the union of actual round-nib stroke footprints separately for each pen, with missing-area, added-area and local-distance allowances. The existing shared estimator selects the fastest passing candidate; inconclusive candidates cannot replace the original.

The design uses vector geometry only. SSIM, PSNR and raster similarity scores are excluded. A footprint model does not predict pen pressure, accumulated darkness from repeated strokes or ink/paper interaction; review the changed paths and ink-length readout before applying.

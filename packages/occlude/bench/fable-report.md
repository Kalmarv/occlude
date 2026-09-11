# Bounded TypeScript thickening

Production `thicken()` now uses `clipper-lib` 6.4.2 (Javascript Clipper 6.4,
not Clipper2). It stays synchronous and needs no WASM initialization. The
algebraic implementation from 32d1ae6 is retained under `exact-reference/core`
as a development comparison; it is not imported by production code.

Endpoint discs are sampled before union. A robust-orientation convex hull
constructs each variable-radius edge's swept polygon. Clipper owns the integer
union and winding. Duplicate geometric contributions are generated once while
all original sources remain available for callback attribution.

The source-unit tolerance defaults to 0.05. Curve sagitta is at most tolerance/4
(and at most radius/64); the power-of-two grid is at most
min(tolerance/64, smallest positive radius/1024). This is a bounded approximation
contract, not exact-input topology. Sub-resolution gaps can close and overlaps
can separate; small holes can change. No area-only deletion heuristic is added.
Coordinates exceeding 2^50 grid units and more than one million constructed
sample points fail explicitly. Optional provenance has bounded work and uses
the approximation budget to associate the original envelope generators.

## Measurements

Node 24.21.0, Linux x86_64, AMD Ryzen 5 3600 under KVM (8 vCPUs).
One warmup, three measured samples per implementation. Medians:

| Fixture | Algebraic | Clipper | Speedup |
| --- | ---: | ---: | ---: |
| Capsule | 5.66 ms | 0.51 ms | 11.2× |
| Recursive A, 100 mm | 218.26 ms | 11.11 ms | 19.6× |
| Recursive A, 304.8 mm | 206.59 ms | 9.28 ms | 22.3× |
| Recursive B, depth 3, 304.8 mm | 8276.66 ms | 257.92 ms | 32.1× |

`fable-results.json` contains tail samples, primitive counts, and cumulative
process peak RSS. The mixed process's RSS cannot isolate either implementation.
A separate Clipper-only process peaked at 322,252 KiB; this is process RSS, not
per-operation allocation. Outputs are deliberately not byte-identical: A/304.8
has 30 loops instead of 34, and B has 1056 instead of 1054. The coverage corpus
checks the approximation against independent envelope-membership witnesses.

Reproduce from `packages/occlude`:

```sh
pnpm exec tsx bench/exact-reference/benchmark.mts --baseline bench/exact-reference/core/thicken.ts
pnpm exec vitest run test/thicken.test.ts test/thicken-exact.test.ts test/algebraic.test.ts test/contour.test.ts
pnpm plotstats bench/fixtures/thicken-contour-residual.ts --seed 42 --paper 304.8x304.8
node bench/fable-studio.cjs
```

## Separate contour correction

The reported contour failure was traced to a residual polygon of 207.4 mm²
which included an original hole. The source visible component was correct;
the offset-derived residual was not a subset of it. Residual batches are now
intersected with the original visible component before cleanup. Visibility
certification and cleanup budgets remain in place. No warnings suppress errors,
and the Studio's 20-second abort remains unchanged.

The local 0.38 mm pen reproduction completes in the native serial release
pipeline in 1455.9 ms (single diagnostic run). Real-WASM integration also passes. Playwright on the production dist build
rendered this sketch in 4.43 seconds from page load, with a 2.02-second WASM
render and no page errors. The three earlier A/B browser fixtures also pass
(1.94–2.40 seconds from page load).
The complete sketch's plotstats are 8680 chains, 69421 mm drawing, 9442 mm travel,
and 229.4 estimated minutes with the local pen library. This is a rendering
correctness result, not a before/after physical plot-time speedup claim.
The church oracle remains 15601 chains / 96037 mm ink / 381.0 minutes.

The three materials documentation ink fixtures are deliberately regenerated
for polygonal thickening. All other documentation ink remains identical.

Verification: `pnpm check` passed all gates (Rust, TS, library and Studio types,
docs rendering, docs ink, build, bundled WASM parity). A final targeted run
also passed all 63 thickening tests after adding coordinate-collapse validation.

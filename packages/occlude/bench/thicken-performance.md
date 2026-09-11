# Thickness performance pass — 11 September 2026

Baseline: `adbe654`. The geometry predicates and intersection construction are
unchanged in this pass. The docs examples deliberately change their ink.

## Profile and changes

Node CPU profiles of the bundled JavaScript put the largest sampled cost in
`thicken`'s per-piece classification: filtering every primitive crossing for each
nearby shape, then sorting the resulting array repeatedly. That line accounted
for 3,871 position ticks in the baseline profile. Pair discovery (`sweepPairs`)
was comparatively small, about 239 ms of self time in that profiling run.

Crossings are now grouped by primitive and shape and sorted once. Each piece
uses binary search with the same strict `p < midpoint` rule and stable tie order.
The other change skips boundary candidate generation when there is no `point`
callback. Attributed output still takes the original candidate path.

The comparable post-change profile no longer has the repeated filter/sort cost;
`thicken` self time fell from about 7.0 seconds to 2.6 seconds in these profiling
runs. These totals include harness work and are diagnostic, not speedup claims.

## Timings

Node 24.21.0, this workspace, both implementations in one esbuild ESM bundle
sharing the same Material implementation. Two warmups per implementation,
15 timed runs, alternating baseline/current order, medians below. Fixture
construction, fingerprinting and profiling are outside these timed calls.

| Fixture | Baseline | Optimized | Speedup |
|---|---:|---:|---:|
| 2,000 separated discs | 23.04 ms | 20.03 ms | 1.15× |
| 600 overlapping discs | 32.83 ms | 22.95 ms | 1.43× |
| 700-point nearest network | 99.75 ms | 74.41 ms | 1.34× |
| 1,500-point variable-width chain | 243.26 ms | 179.14 ms | 1.36× |
| 100 long crossing lines | 292.36 ms | 69.39 ms | 4.21× |

The two near-tangent fixtures remain around 0.03–0.04 ms; that is too small to
claim a meaningful improvement. An earlier five-run compiled comparison gave
3.78× on long crossings, so treat these as workload-specific measurements, not
a universal fourfold speedup.

The checked-in runner is `packages/occlude/bench/thicken.mts`; instructions are
in that directory's README. For the compiled comparison, a temporary copy of
the runner replaced its dynamic baseline loader with a static import of
`../src/.thicken-baseline.js`, then esbuild bundled both implementations:

```sh
pnpm exec esbuild bench/.thicken-compiled.mts --bundle --platform=node --format=esm --packages=external --outfile=.thicken-compare.mjs
node .thicken-compare.mjs --profile
```

`--profile` selects 15 timed runs. Actual CPU profiling used Node's
`--cpu-prof` flag on separate baseline and optimized bundles.

## Equality and known limitation

All seven workload fingerprints match. The digest covers geometry-only and
attributed coordinate/edge bytes, attribute bytes, and the complete ordered
callback stream (including candidates and negative zero).

An additional 800-case fractional-coordinate corpus has 799 successful outputs
identical to baseline and one identical baseline error. The existing 800-case
rounded-coordinate regression corpus and all 41 thickness tests pass.

Fractional case 211 already throws `boundary walk did not close` in `adbe654`:

```ts
thicken(material([
  [0.18029026687145233, 2.377823661081493],
  [11.650821128860116, 7.7608753414824605],
  [15.749140549451113, 2.8944345703348517],
  [3.4245460759848356, 7.2784881154075265],
  [10.151658169925213, 13.536654221825302],
], {
  edges: [[0, 1], [0, 2], [1, 3]],
  radius: [0.9179886434227228, 3.5909650990739466, 3.7258079521358014,
    1.0258007360622288, 3.5144658725708724],
}), { radius: p => p.radius, tolerance: 0.02 });
```

This was not introduced or fixed by the performance changes in `fbc4113`.
The subsequent correctness fix gives circle pairs a canonical construction
order: repeated hull arcs can otherwise solve the same pair in opposite order,
round a root two ULPs apart, and retain duplicate arcs at the resulting junction.
The four edge-order regressions cover the original case, reordered edges, and
reversed edges. Standalone `--verify` now requires all 800 fractional cases to
succeed. Comparing that correctness change against `adbe654` intentionally
reports changed fingerprints; the performance-only equality results above
remain the measurements of `fbc4113`.

## Docs

The three Thickness examples now use native Voronoi/scatter, sampled circles,
and streamlines. Playwright rendered all three previews without browser errors;
the ribbon example visibly carries tone onto selected blue boundary strokes.
Only the three corresponding materials ink baselines are intentionally updated.

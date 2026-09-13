# Auto optimization: first release measurements

Auto is available at **Plot → Optimize path → Auto optimize**. It searches proposals and accepts only faster candidates that pass per-pen vector ink allowances. Applying remains explicit. Manual optimization remains available.

Measured on 12 September 2026, AMD Ryzen 5 3600, Node 24.21.0, production single-threaded WASM. The recursive fixture is seed 185591647, 304.8 × 304.8 mm paper, hop pen 0.4 mm, and the committed iDraw timing profile. Times below are the existing estimator's predictions, not physical plot measurements.

| Metric | Original | Auto |
| --- | ---: | ---: |
| Plot ETA | 309.75 min | 226.60 min |
| Internal lifts | 23,373 | 15,077 |
| Ink length | 102,931 mm | 105,438 mm |
| Pen-up travel | 14,626 mm | 14,244 mm |
| Primitives | 326,106 | 334,402 |
| Motion commands | 395,770 | 379,178 |

Auto selected joins up to 0.8 mm, with 8,296 new connections and **83.16 estimated minutes saved (26.8%)**. Almost all added centerline travel lies within the existing pen footprint:

- Missing-ink upper bound: below 0.000001 mm².
- Added-ink interval: approximately 0.00209–0.00362 mm².
- Tested local-distance allowance: 0.04 mm (0.1 × nib width), passed in both directions.
- Original union ink-area interval: approximately 23,121.45–23,126.81 mm².
- User allowances: missing 0.1%, added 0.5%, local change 0.1 nib width per pen.

Eight proposals took **78.2 seconds** in this run. The first reference footprint calculation dominates; subsequent candidates reuse its local unions. The 1.6 mm join proposal was skipped when its local ink allowance could not be verified. Routing or fitting candidates that did not beat the incumbent ETA did not incur footprint comparison. Original rendering/planning took about 12 seconds separately and was not repeated by Auto. Peak memory was not measured in this run; footprint caches add memory, and this remains a performance improvement opportunity.

This is a single full-search sample, not a latency promise or a proof of global optimality. Tests added after this measurement tighten handling of numerically near-duplicate segments; the quoted footprint values are rounded above their small floating-point differences.

The final Playwright run on this exact 12-inch fixture completed in 77.15 seconds, selected the same 8,296 joins, applied 15,078 runs, and exported SVG successfully.

A small Studio fixture with ten pairs of collinear fill strokes separated by 0.04 mm, generic bridging disabled, completed an eight-proposal search in about 0.11 s. It went from twenty runs to ten, saved about 4.6 estimated seconds, and passed its 0.04 mm local limit. Playwright exercised Auto, vector bounds, comparison without adoption, Use optimized, SVG export, Restore original and cancellation.

## Reproduce

```sh
pnpm run build:wasm
pnpm --filter occlude exec tsx bench/path-auto.mts recursive 8
cargo test -p occlude-core ink_difference::
pnpm --filter occlude-studio test
pnpm --filter occlude plotstats ../occlude-studio/sketches/church.ts --seed 42
pnpm check
```

Raw measurements and the candidate progression are in `results/path-auto-recursive.json`. The fixture and machine profile are committed alongside this report. The `path-auto.mts` script accepts `wave` as a smaller alternative and a proposal count as its third argument.

## Measurement implementation and limits

The reference and candidate are the same machine polylines used by the shared timing model. Rust constructs round-nib sweep enclosures and compares vector Boolean areas. Widened nib sweeps implement the local-distance containment test. Disjoint work cells partition geometry and accounting; they are not a raster sampling grid. Unchanged neighboring ink participates in comparisons. Numerically matched endpoints still contribute an area/displacement uncertainty bound, including extra near-duplicate segments.

The implementation uses pinned `i_overlay 8.1.1`, a fixed 1e-8 mm integer grid, inner/outer radial allowances for round-cap approximation and rounding, and localized integer operations. Failed or inconclusive checks never authorize a result. Very small pens or extreme coordinate ranges can make a candidate unmeasurable; the original remains available. These safeguards apply to optional optimization and do not stop sketch rendering.

The native tests cover overlap-neutral connections, blank gaps, separate pens, thin isolated losses, unchanged outer boundaries with missing interior ink, work-cell boundaries, widths from 0.01 to 1 mm, zero allowances and near-duplicate extra ink. Studio tests cover the shared ETA decision, vector-gated acceptance, unchanged original bytes and stored Auto identity. Normal fill generation and modifier semantics are unchanged.

Native-arc G-code profiles currently use manual optimization: Auto's polyline certificate must not be presented as a certificate for different G2/G3 geometry. The existing Difference preview shows changed centerlines; filled vector difference overlays and adaptive precision refinement remain future work. A footprint union also does not model darkness from repeated strokes, pressure or ink/paper interaction.

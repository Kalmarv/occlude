# Contour variations and conversion rejection — 12 September 2026

Two new live examples in `docs/fills.md` compare constant, horizontal and radial
thickening with decimated contour ink, and sparse contour-filled noise islands.
Playwright rendered and visually verified both examples. Existing docs ink hashes
are unchanged; only `fills#12` and `fills#13` are added.

The reported Beach House sketch, seed **1493547082**, **304.8 × 304.8 mm**, failed
with `contour: curve conversion exceeds geometry work budget`. The preflight
estimate summed curve length divided by tolerance, ignoring adaptive flattening
and retained arcs. It rejected this sketch before conversion. That estimate is
removed; representability checks and the existing actual output bounds remain.
No tolerance, spacing, worker deadline or pen-library setting changed.

The original supplied sketch completed in production Studio after the fix:
**2.744 seconds raw render, 3.627 seconds full worker request**, 111,379 fill
primitives, no fallbacks, no validation splits, no browser errors. Five geometry
refinements were performed. Browser font/image handling gives a slightly different
shape count from the native scene dump. Native serial replay completed in 1.602
seconds before the subsequent collinear-site fix; neither timing is a cross-machine
performance guarantee. [Browser observation](contour-variations-results/noise-studio.json).

The new noise-islands example exposed an independent collinear-site failure.
Adjacent degree-two segments on the same quantized line were separate Voronoi
sites and left degree-one contour junctions. Exact integer collinearity and forward
direction now allow those redundant segments to merge before diagram construction.
Bends, reversals and shared junctions stay intact. The regression retains the
77-segment component, checks unchanged boundary geometry and closed contours at
three spacings. No approximate shape simplification was introduced.

Reproduce the focused regressions:

```sh
cargo test -p occlude-core curve_conversion_uses_curvature
cargo test -p occlude-core collinear_island_has_closed_distance_contours
cargo test -p occlude-core coalescing_keeps_bends_reversals_and_shared_junctions
DOCS_PAGE=fills pnpm --filter occlude docs:check
```

To rerun the supplied sketch, save it as a local `.ts` file with the referenced
`beach-house-key.jpg` available in Studio's assets, then:

```sh
BENCH_SEED=1493547082 node packages/occlude/bench/contour-sdf-studio.cjs \
  - <sketch.ts> /tmp/contour-noise-check http://127.0.0.1:4173
```

The helper uses 12-inch square paper. With no pen override, it uses Studio's
current pen library, as in this observation. The check exercises the actual
production worker deadline; it does not substitute raw Rust time for that deadline.

All 123 Rust tests and `pnpm check` passed. Church remains at 15,601 chains,
96,037 mm ink, 16,515 mm travel and 381.0 estimated minutes.
[Release gates](contour-variations-results/verification.txt),
[radius panels](contour-variations-results/radius-variations.png),
[noise islands](contour-variations-results/noise-islands.png).

The 0.01 mm recursive stress fixture also passed the production worker in
17.846 seconds, with the same fragment/fill primitive counts as the preceding
release and zero fallbacks or validation splits.
[Fine-width observation](contour-variations-results/fine-width-studio.json).

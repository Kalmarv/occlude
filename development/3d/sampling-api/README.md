# Seeded mesh sampling and surface scatter

`t.sample(mesh, {count})` draws independent points with probability proportional
to represented triangle area times a captured nonnegative face weight.
`t.scatter(mesh, {spacing})` uses that candidate distribution with bounded dart
rejection and a sparse Euclidean world-space neighbor grid. Spacing is fixed;
weights affect candidates, not radius or a promised final density. No geodesic
spacing or maximal-packing guarantee is implied. The existing 2D sampling and
scatter implementations remain unchanged behind their original overloads.

Separate named execution streams derive from the sketch seed and optional key.
Default sampling has a 100,000-point budget; scatter stops at its point or
attempt limit and records the original generation counts/reason. Empty weighted
sample domains are errors for positive counts; empty scatter domains yield no
points. Budget validation precedes output allocation and random/weight calls
where applicable. The grid diagnoses unsupported spacing/extent ranges.

SurfaceSamples extends the common point geometry. Point rows expose a captured
sample record containing the immutable source surface, face row, triangle,
vertices, barycentrics, original position and triangle normal. Metadata stays
attached through fields, edits and extraction. Numeric point columns interpolate;
categorical/nearest columns use the greatest barycentric weight with source-ID
ties. Face columns transfer with point-column precedence. Moving samples keeps
their original interpretation rather than silently reprojecting them.

Instancing and sync/async query batches now infer and retain complete point-row
types, not only flat attribute columns. This lets normal-based placement and
later query results read `.sample` without array-index plumbing or `any`.
Existing point-row callers keep their contracts. `sample` joins the reserved
geometry attribute names so source metadata cannot shadow a user column.

Seven focused sampling tests plus nine existing query and seven instancing tests
pass. The independent area/weight quantile oracle has masses 1:6 and produces
100/600 points across two disjoint triangles. A 6,000-point triangle check covers
barycentric moments, affine attribute interpolation and categorical transfer.
A brute-force all-pairs check verifies scatter spacing across nearby parallel
sheets. Further checks cover immutable source ownership, rich row identity and
types through transforms/extraction/instances and all six query-batch methods,
budgets, empty inputs, cancellation and seeded camera retention.

Source Studio Playwright passes on NVIDIA. The live terrain example produces
59 surface-aligned cone instances from 4,000 attempts, plus 12 independent sphere
placements. It independently checks pairwise spacing, frame alignment, source
identity and typed face metadata; commit/download/reopen preserves the result
without rerunning model sampling. Negative Monaco probes reject numeric sample
columns and boolean source-face metadata assigned to strings. No zero-length SVG
paths occur in the captured source example.

Only three#16 adds a docs ink baseline; all 236 previous entries are unchanged.
All nine Docker gates and seventeen served live examples pass. The served
20-row nearest/ray/segment GPU fixture also preserves source-surface identity,
sample metadata and analytic distances/t; its second and third batches reuse
the uploaded target. The fixture has clean Monaco diagnostics.
Church routing before/after remains
15,601 chains, 96,037 mm draw, 16,515 mm travel and 381.0 minutes.

```sh
DISPLAY=:93 OCCLUDE_API_EXAMPLE=sampling \
OCCLUDE_API_EVIDENCE=../../development/3d/sampling-api/served \
pnpm --filter occlude-studio exec node tools/verify-mesh-api.mjs
```

M5 demo migration, detailed phase timings, remaining paper acceptance and the
underside report, and the full requirement audit remain unfinished.

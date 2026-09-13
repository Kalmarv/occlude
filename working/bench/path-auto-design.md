# Auto path optimization: vector fidelity design

Implementation update: the first Auto version is now implemented in `ink_difference.rs`, `optimization-auto.ts` and Studio's **Auto optimize** button. The sections below retain the design rationale. Current implementation differences: eight default proposals out of at most eleven; inconclusive candidates are skipped rather than automatically refining precision; measurement is restricted to the active machine-polyline geometry (arc-command profiles retain manual optimization); the difference preview shows changed paths, with numeric footprint bounds rather than filled footprint-difference overlays.

The native session uses 8 mm vector work cells, cropped centerline neighborhoods, a fixed 1e-8 mm grid, localized i32 overlays where coordinate range permits and i64 otherwise. It computes lower/upper round-nib sweeps, caches reference unions, accounts for numeric endpoint differences when recognizing shared ink, and rejects incomplete checks. This is a bounded numerical geometry implementation, not a claim of exact physical ink prediction. See [measured Auto results](path-auto-results.md) and the source tests for evidence and limitations.

## Intended behavior

**Find the lowest estimated plot time within the user's ink-change allowance.** Auto searches fitting, joining and routing alternatives without changing the sketch or normal render time. It compares actual pen footprints, using vector geometry only. No SSIM, PSNR, raster mask, pixel sampling or image-similarity score participates in acceptance.

The original selection is always available. Auto never applies a result automatically: the existing Original / Optimized / Difference comparison, Use optimized and Restore original flow remains. A slow or inconclusive candidate does not become a render error and cannot replace the original.

## User controls

Add an **Auto search** action to the existing Optimize path panel and reuse its subpanels, inputs and comparison controls. Keep manual Run optimization available. Avoid adding another panel or public sketch API.

Auto's controls describe acceptable changes, not the algorithm's fitting settings:

| Control | Meaning | Initial value to test |
| --- | --- | --- |
| Local change | Maximum distance from either ink footprint to the other, expressed as a fraction of each pen's width | 0.1 nib width |
| Missing ink | Maximum lost area as a percentage of that pen's original ink area | 0.1% |
| Added ink | Maximum new area as a percentage of that pen's original ink area | 0.5% |
| Search effort | Number of deterministic alternatives/refinements to attempt | 12 alternatives |

These are proposed starting values, not validated perceptual thresholds. Benchmarks must establish whether they permit useful improvements without obvious changes. Display their resolved millimetres and square millimetres per pen. Fractions allow the same setting to scale across pen widths; advanced controls may accept an explicit millimetre distance. Repeated ink remains reported as drawing length even when it adds no footprint area.

The result shows plot-time saving, lifts, added/missing ink in mm² and %, and the tested local-distance limit. Do not display an invented “99.9% identical” score. Provide vector overlays for missing and added ink. Display “within 0.04 mm” when only that bound was tested; do not present it as a measured maximum.

Cancel stops work and leaves the accepted drawing unchanged. A completed candidate can be retained for review if it has already been delivered by the worker; unfinished calculations never authorize acceptance. Changing the source, selection, effective pen widths, machine geometry settings or timing invalidates the candidate.

## What is compared

For each pen `p`, form the ink footprint of the selected machine paths:

```
O[p] = union of round-nib sweeps of original paths
C[p] = union of round-nib sweeps of candidate paths
r[p] = resolved pen width / 2
```

A line produces a capsule, a tap a disk, and an arc/cubic its round-nib swept area. Keep dots as dots in planning and timing; a disk model does not authorize replacing a stroke with a tap. Use physical paper coordinates after transforms and finishing modifiers. Exclude unselected paths: ink that will not be plotted cannot hide a candidate's changes. Retain all applicable original visibility restrictions when creating connections.

Pens are compared separately even if they share a color. Missing red ink cannot be offset by new black ink. Identity includes pen width and paper scale. A footprint union discards multiplicity, so it cannot predict the extra darkness of overdrawing; retain ink length, join geometry and the visual comparison rather than treating that limitation as a zero-cost physical change.

**Machine geometry:** use the same lowering and tolerance as the active plot/export profile. The EBB/polyline path can reuse `wasm_plan_toolpath`; an arc-capable G-code profile must compare its native arcs rather than silently evaluating a different flattened command path. Extract shared command-geometry lowering from existing code if necessary; do not create another flattener or timing model. Numerical approximation for measuring a native curve is distinct from the machine's own geometry conversion. Save the geometry-model identity with the certificate.

## Acceptance tests

All tests must pass for every pen; added and removed ink are never netted against each other.

```
missing[p] = area(O[p] \ C[p])
added[p]   = area(C[p] \ O[p])
missing[p] <= missingFraction * area(O[p])
added[p]   <= addedFraction   * area(O[p])
```

An absent original pen has zero allowance for new ink. Empty selections return the original. The denominator is original ink area, not paper area; an empty margin cannot improve the score. Compute the union area, not pen width times drawing length, which double-counts overlaps.

Area tests alone can erase narrow appendages or small disconnected marks. Require both directed distance tests across the **whole ink area**, including interiors:

```
O[p] is contained in dilate(C[p], localLimit[p])  // limits missing ink
C[p] is contained in dilate(O[p], localLimit[p])  // limits added ink
```

This is a symmetric maximum-distance bound on footprints. Checking just boundary vertices or midpoints is insufficient. In particular, a missing interior island of ink can be far from the surviving ink even if the outer boundaries agree.

There is a useful simplification: dilating a union of round-nib sweeps by `d` is the same as sweeping the same centerlines with radius `r + d`. Therefore the checks can reuse wider capsules/disks/curve sweeps and vector differences. No medial-axis solver or raster distance grid is needed just to decide whether a limit passes. Finding the exact maximum distance is unnecessary for acceptance; optional reporting can bracket it with a bounded number of containment tests.

Visibility and intentional-break rules remain hard constraints independent of these scores. A small global ink difference does not authorize crossing an occluder, changing pens, joining different shapes, overriding `connectors: false`, or reconnecting finishing-modifier breaks. Auto optimizes the existing output; it does not rerun fills or repair gaps a modifier intentionally made.

## Precision and inconclusive candidates

Reusing the old contour cleanup algorithm wholesale would recreate its costly repeated sweep/subtract loop. Reuse geometric primitives and the pinned `i_overlay = 8.1.1` dependency, with a separate measurement module and explicit numerical contract.

Do not treat the current `Primitive::flatten` tolerance as a ready-made native-curve certificate. Its cubic flatness test measures distance to the infinite chord line and also has a recursion-depth stop. A collinear cubic with control points beyond its endpoints can pass that flatness test while extending beyond the finite chord. For machine-polyline comparison, use the actual lowered vertices as the reference model. For native-curve enclosures, use a finite-segment/control-hull bound and report an unresolved bound on a depth stop; audit this separately without changing normal rendering in the Auto feature.

Use one paper-space integer adapter/scale for an Auto session, including the maximum proposed dilation. Do not let each Boolean call independently rescale coordinates. Account for curve conversion, polygonized round caps, input quantization and Boolean intersection/output rounding. Verify the selected version's rounding/range contract before describing an enclosure as certified.

The intended measurement returns **bounds**, not a float plus an arbitrary epsilon:

```
Ominus ⊆ O ⊆ Oplus
Cminus ⊆ C ⊆ Cplus

area(Ominus \ Cplus) <= missing <= area(Oplus \ Cminus)
area(Cminus \ Oplus) <= added   <= area(Cplus \ Ominus)
```

The original-area denominator also needs bounds: accept an area ratio only when its numerator upper bound is within the allowed fraction of `area(Ominus)`; reject when the numerator lower bound exceeds that fraction of `area(Oplus)`. Refine the interval otherwise.

For local distance, an empty `Oplus \ CexpandedMinus` proves the missing-distance limit; a nonempty `Ominus \ CexpandedPlus` proves a violation. Apply the reverse test for added ink. Otherwise the result is inconclusive. These implications depend on genuine enclosures; merely shrinking a radius without accounting for subsequent Boolean rounding is not enough.

Start measurement precision at the smaller of 0.002 mm, `width/100`, and `localLimit/16`, then refine only ambiguous changed regions. These are proposed numerical settings requiring validation. Never silently enlarge the user's allowance. Report uncertainty in mm²/mm alongside any inconclusive result. Permit at most two finer measurement levels in the initial search; if still unresolved, skip that candidate and keep the best certified result. Zero allowances require an exact unchanged-geometry proof or an established containment proof; do not replace zero with an epsilon.

Unchanged paths, reversals and exact subdivision/seam changes can use geometry provenance to prove equal ink and bypass Boolean work. Preserve primitive/span identity through fitting and joining; current before/after preview chains do not provide enough identity for every case. Geometry equality is independent of traversal direction and start seam, while timing is not.

## Avoid whole-sketch sweep unions per candidate

Let `U` be unchanged selected ink, `R` replaced original ink and `A` replacement/new candidate ink. Then:

```
O = U ∪ R
C = U ∪ A
missing = R \ (U ∪ A)
added   = A \ (U ∪ R)
```

This explicitly includes unchanged neighboring strokes. Comparing `R` with `A` alone would incorrectly penalize connectors drawn on already inked regions or count ink as missing when an unchanged stroke still covers it.

Build a per-pen spatial index over primitive sweeps. Candidate change boxes, expanded by the nib, local allowance and numerical margin, locate the affected neighborhood. Unchanged ink outside that neighborhood cannot influence the local result. Use disjoint rectangular ownership cells only to partition vector work and area accounting—never a raster mask or occupancy decision. Split/merge work regions according to geometry load; clip the vector comparison to each cell core and gather all touching primitives from its expanded neighborhood. Count each area once at shared boundaries.

Compute and cache original union area per pen once, with the same disjoint ownership scheme. It is needed for the percentage denominator even when only a small part of the drawing changes. Build original local unions/dilations lazily and cache by source, pen, precision, neighborhood and radius. Candidate unions always start from original geometry plus the current candidate; never repeatedly subtract one candidate from the previous candidate.

Routing-only candidates require zero footprint work when the lowered ink is unchanged. Joining-only candidates have zero missing ink by construction before any subsequent fitting; measure additions against all neighboring original ink. Fitting candidates retain changed-span provenance for localized comparison. A native-to-command geometry conversion that actually changes the footprint invalidates an unchanged-ink shortcut.

## Search schedule

Use the existing estimator `estimatePlanMs` for the objective. Rust proposes and measures geometry; TypeScript chooses by the shared machine estimate. Do not introduce a second Rust clock.

1. Freeze original selection, pens, profile, source scene and identity. Measure original ETA and initialize it as the incumbent.
2. Try routing/seam changes with equal-ink proofs. Measure ETA and keep improvements.
3. Build a deterministic coarse-to-fine set of fitting/joining proposals in fractions of pen width. Include no-fit joining and per-path fitting choices. Respect any manually disabled operation.
4. Check visibility and cheap geometric bounds first. Estimate complete candidate ETA; discard candidates that cannot beat the incumbent before expensive footprint unions.
5. Evaluate vector fidelity only for faster candidates. Reject proven violations, refine inconclusive neighborhoods within the measurement effort, and publish only passing candidates.
6. Refine near promising settings and try a small number of join priorities until search effort is spent. Keep the fastest passing plan, not the widest tolerances or the fewest primitives.

Quality and speed are not monotone in tolerance: the existing recursive fixture already demonstrates that permissive fitting can be slower. Do not use binary search on a presumed monotone overall quality/ETA score. Containment with increasing dilation is monotone and can be bracketed separately.

No candidate is applied mid-search. Deterministic effort and tie-breaks give reproducible results for a fixed build, source and machine profile. Explicit user cancellation can stop at a different point; only already completed certificates may survive it. A failed Boolean, resource exhaustion or unsupported command geometry means that candidate is skipped with a reason. It does not invalidate the rendered sketch, silently relax fidelity or permit partial ink as success.

## Implementation boundaries

| Location | Responsibility |
| --- | --- |
| `crates/occlude-core/src/optimize.rs` | Geometry proposals and stable changed-span provenance |
| New `crates/occlude-core/src/ink_difference.rs` | Per-pen sweep indexes, local unions, area/distance bounds and diagnostics |
| `wasm_api.rs` | An Auto-session handle retaining original indexes and reusable caches; compact measurement/proposal results |
| Existing command/toolpath lowering | Shared machine geometry; preserve arc-capable export semantics |
| `optimization-runner.ts` | Candidate schedule, estimator, incumbent and certificate association |
| `optimization-worker.ts` | Lazy session and progress/candidate messages; cancellation by termination |
| `optimizationPanel.ts` | Existing controls/comparison/adoption with fidelity settings and vector overlays |
| `plan.ts` | Save Auto policy, resolved per-pen limits, source/profile identity and measurement version in accepted plan settings |

Use the existing core WASM in the dedicated worker first. It already owns the relevant geometry and Boolean dependencies; another sidecar is unnecessary for this feature. Normal renders must not initialize an Auto measurement session or build ink unions.

Certificates are tied to exact candidate and source hashes, selected range, effective pens, machine-geometry settings, precision/model version and fidelity policy. Cache entries never survive an identity mismatch. Saved results without source visibility can use supported equal-ink routing/fitting comparisons; new joins still need live visibility context.

## Evidence so far

`cargo run --release -p occlude-core --example auto_ink_probe` exercises the pinned Rust Boolean kernel on small polygonized footprints:

| Fixture | Result |
| --- | --- |
| Connector between overlapping 0.4 mm-wide rows, 0.35 mm apart | 0 mm² added, 0 mm² missing |
| Same width, rows 1 mm apart | 0.24 mm² added, 0 mm² missing |
| Remove a 0.1 mm-wide, 10 mm-long finger attached to a 100 × 100 mm body footprint | About 1.004 mm² / 0.01004% missing: passes a 0.1% area allowance, fails a 0.1 mm local allowance |

The first two comparisons took about 0.05–0.08 ms in one release-native run on Ryzen 5 3600. These tiny fixtures use 128-sided disk approximations and independent floating adapters. They demonstrate the metric and test area-only failure; **they do not implement the enclosure contract above or establish real-sketch speed**. The assertions can be rerun from the committed example.

The existing `path-optimization-explore.mts` experiment establishes that per-path fitting can improve ETA even where fitting every path loses: about 30 seconds saved after the first release's joins on the supplied recursive fixture. The larger current benefit remains joining both ends: 309.75 → 215.61 estimated minutes at a 1 mm allowance. Auto must determine which of those added connectors meet a chosen fidelity policy; that has not yet been measured.

## Delivery sequence and acceptance

1. Implement a measurement-only session before adding the Auto button. Verify fixed-scale arithmetic and conservative bounds on line capsules, disks, arcs and cubics. Resolve machine-geometry lowering explicitly.
2. Validate changed-span localization against full-vector unions on small fixtures. Include overlapping changed/unchanged ink and changes crossing work-cell boundaries. No missing or double-counted area.
3. Measure current candidates on the committed recursive sketch, wave sketch, dense fill, sparse hatch, thin finger, tiny isolated tap, sharp corner, hole-rich region, multiple pens, deliberate modifier gaps and arc-capable export. Record area bounds, local tests, uncertainty, time and peak memory.
4. Add the bounded search and existing UI controls only after the metric is trustworthy and costs are measured. Use Playwright to verify cancel/stale/compare/apply/restore and export/simulation/plot identity.
5. Add live documentation, repeat native and production-WASM benchmarks, run `pnpm check`, confirm unchanged normal-render ink and church oracle, then commit/push/build.

Mandatory adversarial checks include area-small but distance-large losses, enclosed missing patches invisible to outer-boundary-only tests, opposite-pen overlaps, source/candidate translation across quantization boundaries, tangencies, collinear cubic overshoot and flatten-depth exhaustion, tiny holes, empty pens, zero allowances, repeated loops, machine flattening differences and exhausted measurement effort. Uncertainty must never become a false pass.

The remaining engineering questions are fixed-scale Boolean enclosure guarantees, the cost of baseline union area on the largest sketch, and useful default fidelity allowances. These need prototypes and measurements rather than further public API expansion. They do not block the shipped manual optimizer.

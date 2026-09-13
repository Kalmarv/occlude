# Classified stroke construction (M2 in progress)

`constructStrokes3` resolves line-set ownership per interval, then chains source
junctions, splits sharp corners, and applies minimum length to complete chains.
Higher numeric priority wins; set ID breaks ties deterministically. Overdraw is
explicit. Selections retain exact classified snapshot ownership and support
filter/map/groupBy/union using the existing relational grouping kernel.

Strokes retain their source features, original parameters (including reversal),
visibility, named pen, cumulative paper arclength, and break reasons. Junctions
with more than two selected incident runs stop. Unrelated projected crossings
never connect. Hidden intervals and near/far clipping endpoints cannot connect
through endpoint tolerance. Closed-loop starts and traversal are deterministic
under input record permutation. Classification now captures the camera frame
so subsequent construction cannot accidentally use another camera.

`paperStrokes3` emits ordinary Occlude strokes in explicit mm with
`preserveStroke: true`. This generic shape option sets bit 4 in the existing
shape flags (no stride change) and stamps outline fragments with existing
ordered run traversal metadata. The normal merge, tour and bridge paths respect
those runs; separate shapes/contours and removed intervals stay separate.
Legacy flags default to false, preserving existing 2D behavior. Named pen,
ordinary clipping, modifiers and export continue through the existing pipeline.

The mesh lab now uses constructed visible strokes and protected hidden dashes
with default planner settings. Silhouette selection chains the six cube edges
into one loop without another GPU dispatch.

Evidence: `three-strokes.test.ts` checks length filtering after chaining,
source-only junctions, branches/corners, small hidden gaps, interval priority,
explicit overdraw, deterministic loops and snapshot-bound selection. The Rust
`preserved_outline_runs_reject_planner_bridges_and_keep_contours` regression
checks an explicit 1 mm bridge override cannot fill a 0.01 mm intentional gap.
Browser evidence is recorded with direct Playwright in `playwright-strokes`.

Still pending: ordered paper modifiers and phase anchoring across visibility
cuts, broader protected-run/2D-mask fixtures, public async integration, Studio
picking/persistence, and the remaining M3–M5 scope. No M2 completion claim.

Validation: full isolated-image `pnpm check` passed (Rust 16.8s, TS 20.3s,
library types 5.6s, Studio types 4.5s, docs 12.1s, unchanged ink 14.3s, build
35.2s, smoke 2.2s). New WASM MD5 is `c21c4ef21cb4091b6019b1aa440f6bea`.
Direct Playwright passes on the served bundle with NVIDIA Turing hardware.
Church before/after statistics match exactly with seed 42 and its captured pen
library: 15,601 chains, 96,037 mm draw, 16,515 mm travel, 381.0 estimated minutes.

The updated shapes live example also passes docs rendering and the ink oracle:
219/219 stable examples are ink-identical (2 examples have no stable ink).

# thicken: structural event identity — implemented

Branch `wip/thicken-structural-identity`. The two `wip(...) [NOT GREEN]`
commits are followed by the implementation of the diagnosed fixes. All
repository gates pass on the tip.

## What was in the failing state

`e86a511` had construction identity (a hull's tangencies shared with its own
arc) and shared source-disc identity across hulls, but the arrangement still
re-solved a known tangency against another hull's copy of the same supporting
circle, and it let proximity/fixed cutoffs decide events. Minimal reproduction:

```ts
import { material, thicken } from 'occlude';
thicken(material([[0, 0], [10, 0], [20, 0.001]], { edges: [[0, 1], [1, 2]] }), { radius: 1 });
// was: thicken: boundary walk did not close
```

## What the fix does

1. **Supporting-circle identity on tangent segments.** Each tangent segment
   carries its two supporting discs (canonical centre, radius, the constructed
   tangent `Pt`, and the outward normal it was built from). `segArc` looks up
   that disc: if the arc's circle is a supporting circle, the tangent line has
   exactly one contact — the stored point — which is added as an arc split (or
   is already the arc's endpoint) and the quadratic is never consulted.
   Pairs belonging to one convex hull are skipped entirely.
2. **Coincident primitives canonicalised before intersecting.** Exact duplicate
   directed primitives (duplicate/reversed edges, coincident discs) are merged
   — shapes and generators combined, one orientation kept — and each unique
   pair is intersected once. Post-split merging still handles partial overlaps.
3. **Shared-disc tangent join in local normal coordinates.** Two tangents that
   share a supporting disc meet at the half-angle offset
   `s = r·c/(1+d)` (or `r·(1−d)/c`), evaluated from the unit normals, not from
   rounded world coordinates; the join is accepted only inside both finite
   segments, and it records which side the other hull covers in parameter space.
4. **Coverage by crossing side, with an exact fallback.** A segment piece reads
   the other hull's coverage from those parameter-space crossings; otherwise
   membership is `shapeContains` with a floating filter and an exact dyadic
   fallback deciding the interior-minimum sign without division.
5. **No fixed parameter/angle cutoffs.** `EPS_PARAM`/`EPS_ANGLE` are 0; events
   are deduplicated by identity, so a real sub-resolution interval survives.
6. **Signed existence predicates instead of clamps.** Line/circle and
   circle/circle existence is decided by an exact sign (filtered float, exact
   dyadic fallback); a negative discriminant is never promoted to zero. The
   circle/circle height uses the factored `(rs−d)(rs+d)(d−rd)(d+rd)/(4d²)`.
7. **Local-origin loop area**, so a tiny disc far from the origin is not
   discarded as zero-area.

`packages/occlude/src/dyadic.ts` is the exact sign helper (bigint dyadics),
reached only when the filter is inconclusive.

## Evidence

- `pnpm check`: rust, ts, types, studio, docs, ink, build, wasm — all pass.
- `thicken.test.ts`: 38 tests, including the 54-case rotated/translated/reversed
  kink matrix, sub-tolerance gap/tangency/overlap, duplicate+reversed edges with
  a third hull, separated discs at 1e6, tiny discs at 1e6/1e8, and a fixed
  seed-12345 randomized corpus with pre-generated queries.
- Seed-12345 sweep: 0 crashes, 0 sign mismatches at 318,122 sampled points.
- 5,000-vertex dense synthetic tree: resolves (42,392 output vertices).

## Limits (not established here)

- Multiway coincidences from *different* primitive pairs are not given an
  explicit identity/refinement path; only same-disc shared tangents and
  duplicate primitives are canonicalised.
- Error bounds are bounded filters plus an exact *sign* fallback, not certified
  interval bounds on every constructed position; extreme exponents are untested.
- The exact path is bigint-based and intended for the rare inconclusive case;
  performance on pathological corpora is not characterised here.

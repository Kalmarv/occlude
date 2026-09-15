# 3D performance pass — handoff brief

Branch `perf/3d-visibility` in the `occlude-3d` checkout, six commits from
`origin/dev` (`bfbdf93`). Not pushed. Full detail lives in
`development/3d/OPTIMIZATION-LOG.md` (every attempt, before/after numbers)
and `development/3d/OPTIMIZATION-PROPOSALS.md` (the one thing that needs a
decision). This file is the short version plus the open questions.

## The job

Make 3D sketches render faster with no public API change and no ink change.
Concrete target: the woven-vessel sketch exceeded Studio's 60 s render
watchdog and never returned a reply. Get it comfortably under.

## What landed

All four are pure optimizations — byte-identical output, no signature
touched. Warm-pass woven-vessel numbers, CPU reference:

| # | change | visibility ms |
| --- | --- | --- |
| — | branch point | 17513 |
| 1 | unroll the fixed-width BigInt vector ops | 16579 |
| 2 | certified f64 sign filter for the halfspace tests | 13659 |
| 3 | strip only the common power of two in the shadow build | 10220 |
| 4 | build each exact view and vertex once, not per triangle | 9826 |

−43.9% on visibility, −27.1% on total compile (25040 → 18246 ms).

**1. Unroll the BigInt 4-vector ops.** `dot`, `times` and `subtract` in
`three/geometry/exact.ts` ran over `Array.prototype.reduce`/`map` closures
although every operand is a fixed 4-vector; the vessel makes ~13.5 M `dot`
calls.

**2. Certified f64 sign filter.** Instrumentation: 2,255,812 candidate pairs,
7,580,746 constraint evaluations, of which 1,578,447 end in a rejection and
only ~2.1 M ever take an interval root. Both-negative rejects and
both-positive no-ops depend on the *signs* of two exact dot products alone,
so ~72% of the BigInt work was computed and discarded. `filtered4` /
`filteredDotSign` give an f64 image of an exact 4-vector scaled by a positive
power of two, plus a running error bound covering the conversion rounding and
any right shift. It answers ±1 only when the f64 value exceeds its own bound
and 0 — "ask the exact arithmetic" — otherwise, *including at zero*. This is
Shewchuk's filter technique, the same idea as the `robust-predicates` the f64
reference path already depends on. No tolerance enters the result.

**3. Power-of-two-only reduction in the shadow build.** `gcd` then became the
top frame; attributing it by call chain put 3403 ms of 3494 ms inside
`planes()` / `sourcePoint()`. A histogram of `reduce` over the vessel:
555,270 calls, 145.6 bits in, 98.2 out, and the common factor is a **pure
power of two in 69.3%** of them. A homogeneous plane is projective — a
positive rescale moves no sign, no root and no rounded coordinate — so the
gcd there buys compactness, not correctness. `reduceScale` / `atScale` /
`planeScale` strip the power of two with a shift; `at` / `plane` keep the
full gcd for the callers that key or compare a plane (`canonicalPlane3`,
`canonicalPoint`). Euclid was benchmarked against Stein's binary gcd first
(966 ms vs 1467 ms on representative operands), so the win had to be *fewer*
gcds, not a different one.

**4. Cache per-view and per-vertex exact points.** `planes()` is memoised per
occluder, but inside it every triangle rebuilt the exact eye/target/back/near/
far points and the camera-depth linear form — all functions of `volume.view`,
shared across every occluder — and called `point()` on each world vertex,
which belongs to ~6 triangles.

## How "no ink change" was proven

- `vitest run` 1058 passed, `docs:hashes --check` 256/256 ink-identical,
  `plotstats church.ts --seed 42` unchanged, after every commit.
- `pnpm check` — all nine gates green.
- A new oracle in `test/three-exact-geometry.test.ts` asserts the f64 filter
  never names a sign the exact `dot` contradicts, over 4000 trials up to
  600-bit coefficients, half constructed to cancel to exactly zero or to
  within one unit in the last place. Mutation-checked: it fails with the
  bound zeroed *and* with the bound merely shrunk 512x.
- GPU path: `development/3d/optimization/ink-digest.mjs` captures the sha256
  of the Studio's raw `prims`+`frags` for all seven workloads on the real
  NVIDIA adapter. Captured against an image built at the branch point and
  against the optimized image: **all seven digests identical**, vessel
  included. (The branch-point image needed `RENDER_TIMEOUT_MS` raised to
  600 s to be capturable at all — measurement-only, never committed.)

A cross-backend diff inside the Studio is not possible: with WebGPU disabled
the render worker reports "WebGPU adapter unavailable" rather than falling
back to `classifySceneCpu3`.

## The target

Served Studio, warm, wall ms from source edit to render reply:
woven-vessel went from **watchdog, no reply** to **43662 ms**. Every other
workload improved 2–13%.

## The finding that needs a decision

**The GPU visibility classifier is slower than the exact CPU reference on
every workload measured, by 1.4x to 3.8x.**

It classifies each pair in f32 and hands every pair its certificate cannot
settle back to the exact CPU refinement — 1,458,163 of 2,255,812 pairs (65%)
on the vessel. So it pays the streaming, packing, 276 dispatches and readback
*and then still pays two thirds of the exact bill*, which is the bill this
branch just halved. It also loses on `intersection-assembly`, which refines
only 19%, so the per-pair overhead is dominant on its own, not just the
refinement fraction.

Experiment (four lines in `render-worker.ts` delegating `classify` to
`classifySceneCpu3`, GPU modeling/tone/`preview3` untouched; never
committed):

| workload | GPU classify | CPU classify | wall delta | visibility delta |
| --- | --- | --- | --- | --- |
| woven-vessel | 43662 | **18168** | −58% | 35402 → 9366, −74% |
| intersection-assembly | 4478 | 3386 | −24% | −60% |
| repeated-prototypes | 954 | 834 | −13% | −44% |
| hatch-density | 28443 | 25899 | −9% | −36% |
| mapped-plane | 3182 | 2942 | −8% | −49% |
| custom-curvature | 4767 | 4402 | −8% | −35% |
| primitive-crosshatch | 14855 | 13896 | −6% | −30% |

**It moves ink on three of seven workloads** (`custom-curvature`,
`intersection-assembly`, `repeated-prototypes`). Stroke counts are identical
in every case; what moves is interval endpoints, by less than the parameter
tolerance, because the GPU path accepts f32 endpoints that survive
`refinementTargets3` without exact re-evaluation and the CPU path does not.
So the two classifiers were never the same answer.

## Open questions

1. **Does the Studio switch to CPU classification?** It is a deliberate ink
   change needing a `docs-ink.json` re-save, and the movement is *toward*
   exactness (design law 1). The vessel lands at 18.2 s instead of 43.7 s.

2. **If so, does `classifySceneGpu3` survive?** Keeping an unexercised
   backend that can disagree with the reference is a liability; choosing
   between them at runtime is the mode flag the ethos rejects. Delete, or
   keep and justify?

3. **Is tolerance-based acceptance of f32 endpoints still the right design?**
   `refinementTargets3`, the watertight-abutment closing and
   `intervalTolerance3` all exist to repair f32 seams. If the exact path is
   faster than the approximate one, that machinery is paying for a
   speed-up that no longer exists.

4. **Is `atScale` / `planeScale` an acceptable split?** It is a second
   spelling of `plane` in an internal kernel, distinguished by whether the
   result is canonical or merely projectively equal. "One conversion per
   meaning" is an API-surface law; is it also a kernel law?

5. **Does the certified f64 filter sit right with "no float nudging"?** It
   introduces no tolerance — it is a proof obligation, and it abstains
   whenever it cannot discharge it — but it does put floating point in front
   of the exact predicate, so it is worth confirming the principle.

6. **Next target.** With CPU classification, `hatch-density` is 25.9 s of
   which the **hatch tracer is ~15.9 s** and visibility only 4.6 s. The
   tracer (`three/surface/trace.ts`, the occupancy test and
   `SurfaceLocation3` contexts in `three/geometry/location.ts`) is untouched
   and is now the largest single cost on the Studio path.

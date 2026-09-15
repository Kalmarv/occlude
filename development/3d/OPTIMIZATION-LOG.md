# 3D optimization log

Branch `perf/3d-visibility`, from `origin/dev` (`bfbdf93`). Every attempt is
recorded here, kept or reverted. Numbers are from this box (shared; run under
`nice -n 10`, serially). Run-to-run noise on the vessel is roughly ±3%.

## Summary — CPU reference, warm pass

| workload | metric | baseline (bfbdf93) | current | delta |
| --- | --- | --- | --- | --- |
| woven-vessel | compile ms | 25040 | 22112 | −11.7% |
| woven-vessel | visibility ms | 17513 | 13659 | −22.0% |

Baselines: `benchmark-surface/cpu-baseline.json`, `gpu-baseline.json`
(recorded on `bfbdf93` before any change). The woven-vessel rows quoted above
are from `development/3d/optimization/vessel.mts`, which reports the same
scene stats for a single workload; the full-suite numbers are in the JSON.

## Where the time is (measured)

`node --cpu-prof` over the vessel on the baseline
(`optimization/profiles/vessel-cpu.cpuprofile`, 28.2 s total, self time):

| ms | frame |
| --- | --- |
| 3480 | anonymous, `three/geometry/exact.ts` |
| 2514 | `hiddenWorldInterval3`, `three/visibility/worldInterval.ts` |
| 2091 | garbage collector |
| 1567 | `ratioNumber`, `exact.ts` |
| 3624 | `gcd` (five call-tree nodes), `exact.ts` |
| 1104 | `ProjectedIndex3.query`, `three/visibility/index.ts` |
| 941 | `candidatePairs3`, `three/visibility/scene.ts` |
| 909 | `hiddenInterval3`, `three/visibility/interval.ts` |

The vessel takes the exact world path: `hiddenInterval3` delegates to
`hiddenWorldInterval3` for every one of its 2.26 M candidate pairs, six
homogeneous BigInt constraints each.

## 1. Unroll the fixed-width BigInt vector ops    (commit 1 on this branch)

Hypothesis: `dot`, `times`, `subtract` and `reduce` in `exact.ts` are written
over `Array.prototype.reduce`/`map` with closures, but every operand is a
fixed 4-vector. At ~13.5 M `dot` calls for the vessel that is ~54 M closure
invocations plus a fresh array per `times`/`subtract`, which is the 3480 ms of
anonymous `exact.ts` self time and part of the 2091 ms of GC.

Change: `packages/occlude/src/three/geometry/exact.ts` — `dot`, `times` and
`subtract` write their four terms out by index; `reduce` walks the four
coefficients itself and stops as soon as the running divisor reaches 1, since
no further gcd can shrink it. BigInt addition and multiplication are exact, so
every value is bit-identical to what the closure form produced.

Before / after (woven-vessel, CPU reference, two passes in one process):

| pass | compile ms | visibility ms | svg bytes |
| --- | --- | --- | --- |
| cold before | 25040 (warm 25040) | 17513 | 1964750 |
| cold after | 24947 | 16839 | 1964750 |
| warm before | 25040 | 17513 | 1964750 |
| warm after | 24196 | 16579 | 1964750 |

Correctness: `vitest run` 1057 passed / 1 skipped (114 files);
`docs:hashes --check` 256/256 ink-identical; `plotstats church.ts --seed 42`
unchanged (15601 chains, 96037 draw mm, 16515 travel mm, 381.0 min, 15593
euler, 18.1 coincident mm); vessel SVG byte length identical.

Verdict: kept. Small but free and it is a prerequisite for the rest — the
remaining exact-arithmetic work is now visible in the profile rather than
buried under closure overhead.

## 2. A certified f64 filter for the exact halfspace signs    (commit 2 on this branch)

Hypothesis: instrumenting `hiddenWorldInterval3` over the vessel gives
2,255,812 calls and 7,580,746 constraint evaluations, of which 1,578,447 end
in a rejection and only ~2.1 M ever take a root. A rejection (`va<0 && vb<0`)
and a no-op (`va>=0 && vb>=0`, which moves neither bound) both depend on the
*signs* of the two dot products alone, so ~72% of the exact BigInt work is
computed and thrown away.

Change: `three/geometry/exact.ts` gains `bitLength`, `filtered4` and
`filteredDotSign` — an f64 image of an exact 4-vector divided by a positive
power of two (so signs are preserved), plus a running error bound
`2^-49*S + 8*(a.slack*b.max + b.slack*a.max)` that covers both the conversion
rounding and the truncation of a right shift. The filter returns ±1 only when
the f64 value exceeds its own bound, and 0 — "ask the exact arithmetic" —
otherwise, including at zero. `three/visibility/worldInterval.ts` caches one
filter image beside each shadow plane and each source point (the same
WeakMaps that already cache the exact forms) and consults the filter first:
both signs negative rejects, both positive continues, anything else falls
through to the unchanged exact path. This is the `robust-predicates`
technique the f64 reference path already uses, lifted to the homogeneous dot
product; no tolerance is introduced, because the filter never decides a case
it cannot prove.

Before / after (woven-vessel, CPU reference, two passes in one process):

| pass | compile ms | visibility ms | svg bytes |
| --- | --- | --- | --- |
| cold before | 24947 | 16839 | 1964750 |
| cold after | 23272 | 14321 | 1964750 |
| warm before | 24196 | 16579 | 1964750 |
| warm after | 22112 | 13659 | 1964750 |

Correctness: `vitest run` 1057 passed / 1 skipped; `docs:hashes --check`
256/256 ink-identical; `plotstats church.ts --seed 42` unchanged; vessel SVG
byte length identical. A new oracle in `test/three-exact-geometry.test.ts`
asserts the filter never names a sign the exact `dot` contradicts over 4000
trials up to 600-bit coefficients, half of them constructed to cancel to
exactly zero or to within one unit in the last place; the test fails when the
bound is set to zero and still fails when the bound is shrunk by 512x, so it
constrains the constant rather than merely exercising the code.

Verdict: kept.

# 3D optimization log

Branch `perf/3d-visibility`, from `origin/dev` (`bfbdf93`). Every attempt is
recorded here, kept or reverted. Numbers are from this box (shared; run under
`nice -n 10`, serially). Run-to-run noise on the vessel is roughly ±3%.

## Summary — CPU reference, warm pass

| workload | metric | baseline (bfbdf93) | current | delta |
| --- | --- | --- | --- | --- |
| woven-vessel | compile ms | 25040 | 24196 | −3.4% |
| woven-vessel | visibility ms | 17513 | 16579 | −5.3% |

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

## 1. Unroll the fixed-width BigInt vector ops    8af8e22

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

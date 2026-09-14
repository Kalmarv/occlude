# Surface-drawing performance workloads

Six workloads (`workloads.mjs`), each run twice in one process (cold, then warm).
CPU: headless Node reference (`cpu.mts`, run from `packages/occlude` with `npx tsx`).
GPU: served Studio on the NVIDIA adapter (`gpu.mjs`, run from `packages/occlude-studio`
with `DISPLAY=:93 node --input-type=module < ../../development/3d/benchmark-surface/gpu.mjs`),
which records the worker's modeling stats (tone dispatches, transfer bytes) and the
end-to-end wall time from source edit to render reply.

Honest scope: hatch tracing, mapping and intersections are CPU work on both
paths; the GPU path differs only in the batched tone evaluation of built-in
light/image recipes and in 3D visibility. The numbers below are one machine,
one run each, not a statistical claim.

## CPU reference (this checkout, after the tracer fixes)

| workload | pass | compile ms | modeling (operation: ms / segments) |
| --- | --- | --- | --- |
| mapped-plane | cold | 2893 | mapSurface: 1223 / 6080 |
| mapped-plane | warm | 2839 | mapSurface: 1216 / 6080 |
| primitive-crosshatch | cold | 12232 | hatch: 6433 / 36164 |
| primitive-crosshatch | warm | 12030 | hatch: 6516 / 36164 |
| custom-curvature | cold | 4398 | hatch: 2096 / 10850 |
| custom-curvature | warm | 5177 | hatch: 2782 / 10850 |
| intersection-assembly | cold | 2661 | intersections: 139 / 136 intersections: 140 / 87 intersections: 437 / 165 hatch: 506 / 3348 |
| intersection-assembly | warm | 2574 | intersections: 117 / 136 intersections: 125 / 87 intersections: 440 / 165 hatch: 517 / 3348 |
| repeated-prototypes | cold | 585 | mapSurface: 5 / 23 |
| repeated-prototypes | warm | 756 | mapSurface: 8 / 23 |
| hatch-density | cold | 24717 | hatch: 12693 / 80978 |
| hatch-density | warm | 24498 | hatch: 12796 / 80978 |

GPU results are appended by `gpu.mjs` into `gpu.json` and summarised in
`M6-M8-PROGRESS.md` once the served run completes.

## GPU (served Studio, NVIDIA RTX 2060) versus CPU reference

End-to-end: source edit to render reply in Studio (`wallMs`, includes the
sketch, modeling, visibility, WASM finish and planning); CPU compile is the
headless `compileSketchAsync` time (no planning). Visibility columns are the
scene's candidate pairs, GPU dispatches, CPU refinements and stage wall time.

Refinement before this session's fixes was 98–103% of candidates (every
supported-curve pair was refined unconditionally, and any endpoint touching a
neighbouring facet's plane was flagged uncertain). After: rational bases use
the same f32 certificate, endpoint touches that can hide only a sub-tolerance
sliver are certified empty, and watertight seams of adjacent triangles close
without re-evaluation. Refinement now runs 30–80% of candidates and visibility
wall time fell 10–25%; the remaining cost is candidate streaming, packing,
readback and finalize, which is the target of the planned optimization pass.

| workload | pass | studio wall ms | cpu compile ms | modeling (op: ms / segments) | tone backend · dispatches · bytes | visibility (candidates · dispatches · refinements · ms) |
| --- | --- | --- | --- | --- | --- | --- |
| mapped-plane | cold | 3850 | 2893 | mapSurface: 1371 / 6080 | — | 38991 · 5 · 31014 · 1069 |
| mapped-plane | warm | 3535 | 2839 | mapSurface: 1301 / 6080 | — | 38991 · 5 · 31014 · 1026 |
| primitive-crosshatch | cold | 15385 | 12232 | hatch: 7956 / 36418 | cpu · 0 · 0 | 168446 · 21 · 78533 · 4503 |
| primitive-crosshatch | warm | 14833 | 12030 | hatch: 7893 / 36418 | cpu · 0 · 0 | 168446 · 21 · 78533 · 4251 |
| custom-curvature | cold | 5552 | 4398 | hatch: 2796 / 10850 | gpu · 2 · 1667184 | 54215 · 7 · 30005 · 1183 |
| custom-curvature | warm | 5127 | 5177 | hatch: 2504 / 10850 | gpu · 2 · 1667184 | 54215 · 7 · 30005 · 1141 |
| intersection-assembly | cold | 4289 | 2661 | intersections: 142 / 136 intersections: 172 / 87 intersections: 635 / 165 hatch: 666 / 3346 | gpu · 1 · 285552 | 167271 · 21 · 38458 · 1950 |
| intersection-assembly | warm | 4045 | 2574 | intersections: 153 / 136 intersections: 164 / 87 intersections: 609 / 165 hatch: 644 / 3346 | gpu · 1 · 285552 | 167271 · 21 · 38458 · 1800 |
| repeated-prototypes | cold | 995 | 585 | mapSurface: 3 / 23 | — | 13924 · 2 · 9387 · 270 |
| repeated-prototypes | warm | 1160 | 756 | mapSurface: 17 / 23 | — | 13924 · 2 · 9387 · 287 |
| hatch-density | cold | 29936 | 24717 | hatch: 15909 / 80978 | cpu · 0 · 0 | 363798 · 45 · 140608 · 9029 |
| hatch-density | warm | 30132 | 24498 | hatch: 16170 / 80978 | cpu · 0 · 0 | 363798 · 45 · 140608 · 8815 |

`woven-vessel` (seventh workload, the user's sketch): did not complete within
120 s in Studio (60 s watchdog). CPU reference after depth pruning: 35,302
features, 32,812 triangles, 2.26M candidate pairs, 20.1 s exact visibility,
29.3 s total compile (`visibility-profile/woven-vessel.ts`).

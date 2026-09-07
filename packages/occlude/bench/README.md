# Benchmark harnesses (consolidation, 7 September 2026)

Reproducible workloads behind the numbers in docs/reviews/con2-review.md.
Run from `packages/occlude`: `pnpm exec tsx bench/<name>.mts`. Single
process, warm where noted; report medians yourself when comparing.

| script | workload | what it measures |
|---|---|---|
| `prof.mts` | ring of 500 / 2 000 / 5 000 vertices under tension + separation + drift, one `steps(1)`; 400 random chords planarized and faced; a 5 000-point triangulation; 3 600 exact circles through render → `wasm_plan` → decode → hash → toolpath → schedule → SVG | per-phase costs of growth, topology and the plan pipeline, including the wasm crossings the plan pipeline makes (buffer sizes printed) |
| `sepbench.mts` | 5 000-point ring, `force.separation` radius 2 with `excludeConnected` | the library's evaluate path against a bare typed-array kernel (the prototype that motivated the radial kernels) |
| `codex.mts` | `connect.nearest` k=3 at 1 000 / 4 000 points; resample 16 000 points with an edge column; 1 000 `nearest` queries within 50 mm on a 16 000-edge chain | the three Codex-audit timings |
| `qbench.mts` | 35 000-edge planarized chord net: 1 000 `firstHit` of 2 mm moves, 1 000 whole-drawing moves; `nearest` within 3 mm and within 50 mm | edge queries a growth step makes versus queries spanning the drawing (which fall back to the scan) |
| `rsbench.mts` | resample at 4 000 / 8 000 / 16 000 points, `copy` and `distribute` edge columns, medians of 5 | the two edge-transfer paths |

Seeds are fixed inside each script (a linear congruential generator). Not
measured: the cost of moving a material's columns across the wasm
boundary per step — no material operation lives in Rust, so that cost is
an estimate wherever the review mentions it.

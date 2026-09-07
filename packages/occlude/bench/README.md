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
| `fbench.mts` | planarize 400 chords; faces of the 35 k-edge result, of a 5 000-point triangulation, of a 90 × 90 lattice, and of 80 000 disjoint-segment vertices; a face selection's boundaries | the topology operations a sketch pays for when it asks a drawing for its regions |
| `gbench.mts` | the ring-growth recipe at three sizes written as the sketches write it; the per-step machinery isolated at 2 000 and 20 000 vertices (`points`, `edges`, `neighbours` prepare and query, `steps` move-only and split-every-edge, `separation`); a 200 000-vertex ring, 2 000 steps of a small ring, and 100 000 isolated points with no edges | the iterative path — many small calls per step, hundreds of steps |
| `ibench.mts` | isolines over a 201²–2001² grid, 1 to 40 levels, `close` on and off, an absent-sample hole, a constant field and an all-absent field; then streamlines at four spacings, variable spacing, a field that gives out over a disc, and a fine step | field → geometry: the path every contour sketch, every flow sketch and every field `clip` takes |
| `pbench.mts` | scatter (flat and tonal fields, two spacings), `relax(10)`, `settle(10)`, `cells`, `mesh`; then `settle(50)`, a 512 raster, a field that is zero almost everywhere, one point the population control grows into thousands, and 400 coincident points | the points vocabulary — variable-radius Poisson disk and the Lloyd loop |
| `obench.mts` | heavy occlusion as scaling series: 50–400 (`--deep`: 800) opaque discs that all overlap, the same discs as outlines, concentric nested rings, a hatched field under one opaque cover, and 300 coincident discs | whether the cost per shape stays flat as a stack deepens — it does not; see the clip-query lead in the optimisation log |
| `planbench.mts` | the plan a studio render pays for — `wasm_plan` (merge + tour + bridge + encode) and the plan's sha256 — beside the render it follows, on any sketch, with the studio's pen library loaded | **what `renderhash` never shows.** `renderhash` stops at the fragments; the studio worker then plans and hashes before it can show anything, and on a dense sketch that is 10–16 % of the wait |
| `imbench.mts` | the committed `nyx.jpeg` asset: building the four summed-area tables, then 500 000 samples each of `lum` (bilinear and area), `rgb`, `edge`, `dir`, `bands`, and points outside the placed rect | image sampling — what a stipple or a flow field asks millions of times |

## Read the harness before the numbers

`pnpm exec tsx bench/<name>.mts` runs the **TypeScript source through esbuild**,
which stamps every function expression with `__name(fn, "…")` — an
`Object.defineProperty` per function *creation*. In a loop that builds closures
this inflates the measurement by up to 1.5× against what a sketch actually
runs: `tsc` output (`dist/`) and the Vite studio bundle contain no `__name`.
Measured on isolines, 9 levels over an 801² grid: 419 ms under tsx, 282 ms on
`dist` — the same code.

So when a hot path creates functions, confirm the number against the compiled
library before believing it:

    pnpm build
    pnpm exec esbuild --format=esm --outfile=/tmp/b.mjs <a copy of the bench
        with its imports pointed at ../dist>
    node /tmp/b.mjs

Every other harness here measures data movement rather than closure creation,
where the two agree.

## The Rust side

`crates/occlude-core/examples/` holds two native harnesses; run them with
`cargo run --release --example <name> --no-default-features` (serial, which
mirrors the wasm build), adding `--features profile` for the stage timings the
pipeline and the plan record through `profile::zone`:

| example | workload | what it measures |
|---|---|---|
| `export_bench` | 4 500 filled circles → ~55 000 fragments, then plan and G-code | the render pipeline's stages: cull, region build, clip + fills, dedupe |
| `plan_bench` | 60 000 short strokes → ~479 000 fragments, then `plan_chains` + `encode_plan` | the plan's stages: merge, tour, bridge, encode |
| `stack_bench` | N mutually-overlapping opaque discs with line fills (`cargo run … -- 400`) | which stage makes deep occlusion quadratic — the query, not the clip |

**Native timings are not wasm timings.** The allocator differs, and a change
that removes small allocations can measure far better natively than it does in
the build that ships — see the merge-index entry in the optimisation log, where
native said 19 % and wasm said 2.5 %. Confirm anything allocation-shaped
through `planbench.mts` or `renderhash` before believing the native number.

Seeds are fixed inside each script (a linear congruential generator). Not
measured: the cost of moving a material's columns across the wasm
boundary per step — no material operation lives in Rust, so that cost is
an estimate wherever the review mentions it.

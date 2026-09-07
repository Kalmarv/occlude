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

Seeds are fixed inside each script (a linear congruential generator). Not
measured: the cost of moving a material's columns across the wasm
boundary per step — no material operation lives in Rust, so that cost is
an estimate wherever the review mentions it.

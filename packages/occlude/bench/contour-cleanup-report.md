# Contour cleanup: coverage before continuity

Follow-up to `0464218`, using the user's Beach House sketch, seed **291377256**, on **304.8 × 304.8 mm** paper with the saved 0.8 mm One4All/Copic pens. The source and pen snapshot are in `fixtures/contour/beach-house*`. The original image asset is required locally; it is not redistributed.

## What changed

Regular absolute insets and safe adjacent-loop connections remain. Residuals no longer receive fixed-axis hatch patches and out-and-back excursions. They receive candidate centre strokes, a middle loop for a narrow annular remnant, or certified pieces of their boundary. A dot is used only when its disk contains the entire remnant. Each stroke's conservative round-nib sweep is subtracted with vector Booleans; remaining pieces are queued for local completion. This is a bounded local heuristic with a coverage certificate, not an exact medial axis or an optimal tour.

Cleanup marks may lift. A final indexed pass can connect nearby cleanup endpoints directly, with at most 32 exact visibility checks per search and the existing `2 × spacing` limit. It never takes a return trip to attach cleanup to an inset loop. Each visible component is processed separately.

A second correctness fix preserves small native inset loops through the pipeline. Generic nib judging previously collapsed some loops to centroid taps, then discarded covered tap centres. That can lose part of the loop's ink footprint. Regular contour and cleanup paths now retain their generated geometry; hatch fallback keeps ordinary nib judging; explicit cleanup dots remain dots. Existing finishing modifiers still run afterward. No new public settings, dependencies, or wire-format changes.

The geometry tolerance remains `min(0.01 mm, width/20, spacing/10)`. Cleanup uses conservative inscribed caps and bounded simplification, with exact visibility checks after approximation. Local refinement is limited to eight levels, candidate/simplification work to 100,000 operations per local operation, and one footprint to two million polygon vertices. Existing 250,000-output-primitive and offset budgets remain. A failure to certify completion raises a render error. Solid thin components use the same cleanup; sparse contours retain requested-spacing hatch fallback and do not complete intentional spacing gaps. Kernel failures/complexity fallback remain native hatch.

The cleanup approach is informed by the swept-envelope and compensation-path literature, particularly [Seo, Kim & Onosato (2005), §3.5](https://www.cad-journal.net/files/vol_2/CAD_2(1-4)_2005_213-222.pdf) and [Mansor, Hinduja & Owodunni (2006)](https://doi.org/10.1016/j.cad.2005.09.001). This implementation does not claim to implement either complete algorithm.

## Exact artwork, whole-sketch measurements

All ETA values use the existing shared estimator: travel 6000 mm/min, drawing acceleration 1000 mm/s², travel acceleration 2000 mm/s², junction deviation 0.02 mm, minimum cruise ratio 0.5, and the saved pen feeds/delays.

| Version | Runs | Ink (m) | Pen-up travel (m) | ETA (min) |
|---|---:|---:|---:|---:|
| Solid, default | 11,620 | 82.27 | 22.65 | 280.45 |
| Solid, 0.8 mm per-shape bridge on solid layers | 11,410 | 85.36 | 24.14 | 279.83 |
| Previous contour | 5,802 | 91.47 | 19.36 | 169.56 |
| Corrected contour | 6,429 | 87.40 | 20.19 | 172.69 |

Corrected contour is **38.4% faster than default solid** in estimated physical plot time. Compared with the previous, incomplete contour output, it draws 4.07 m less ink but takes 3.13 minutes longer (1.8%), because cleanup may lift independently and missing ink is now retained. Fewer lifts are not treated as a correctness requirement. The bridged-solid baseline adds 6,822 generic bridge primitives; its extra ink is not a certified visible-area coverage baseline.

The corrected render has 533 regular contours, 2,051 completion regions (including thin components), 1,097 connectors instead of 11,059, and **zero exact visibility splits instead of 41**. There are 26 thin components, now completed with short strokes/taps, and no unstable-offset or complexity fallbacks. Planned primitive count falls from 82,518 to 77,801.

Production WASM on AMD Ryzen 5 3600, Linux x64, Node 24.21.0: one warmup and three measured samples. Corrected contour generation median/tail **4775/4785 ms**, planning **87/90 ms**. This is a compute regression from the initial reproduction's approximately 2352 ms generation; explicit coverage certification costs time. Solid and bridged-solid timings, plus complete counts, are in `contour-cleanup-results.json`. Native measurements are recorded separately; do not interpret physical ETA as render runtime.

## Coverage and verification

- Independent point-to-segment checks cover all 6,003 samples on a 0.12 mm curved strip, including both edges and tapered tips; production does not use a raster mask.
- A real-WASM annular-band test checks 7,200 locations on the curved residual in the final decoded plan, including continuity after planning.
- A real-WASM small-disc test checks 360 boundary locations and rejects collapsing its short inset loop into a smaller-footprint dot.
- Existing native disc/annulus/rectangle/acute/U/dumbbell/sliver/tiny coverage tests, hole-front collisions, the actual attached-finger coverage regression, sparse-budget checks, and modifier/clip integration remain exercised.
- The existing native diagnostic now correctly measures distance to zero-length taps instead of ignoring them through division by zero.
- Playwright renders the exact artwork's exported plans at 6000 × 6000 (0.0508 mm/pixel). Previously, solid-only missing ink survived a 3 × 3-pixel white-neighbourhood check in multiple areas, including long curved slits. Corrected output has **none**. This is an independent diagnostic, not a mathematical proof or a production coverage decision. A specific remaining defect was traced from 0.08785 mm distance to generated ink to 0.45321 mm after tap conversion; the corrected final plan retains 0.08785 mm.
- Only `fills#5` changes in the docs ink oracle; its deliberate regeneration includes this coverage/routing change. Other fills remain unchanged.

Repository verification: `pnpm check` passed all eight gates (Rust, TypeScript tests, library and Studio types, live docs, docs ink, build, bundled WASM). The church oracle is unchanged: 15,601 chains, 96,037 mm drawing, 16,515 mm travel, 381.0 minutes ETA.

## Reproduction

```sh
pnpm run build:wasm
DUMP_SCENES=1 pnpm --filter occlude exec tsx bench/contour-cleanup.mts
node packages/occlude/bench/contour-cleanup-visual.cjs
SAMPLES=3 pnpm --filter occlude exec tsx bench/contour.mts
cargo run --release --no-default-features --features profile --example contour_bench -- \
  packages/occlude/bench/contour-comparison/cleanup-contour-dump
pnpm --filter occlude plotstats ../occlude-studio/sketches/church.ts --seed 42
pnpm check
```

The scripts write full-width and thin-path SVGs under ignored `bench/contour-comparison/`. No saved user sketch is modified.

## Limits

This trades the previous forced cleanup excursions for optional short connections and independent marks. Hole-rich geometry can have substantially more lifts than the previous contour implementation; the representative corpus is reported individually in `contour-results.json`. Dense hole-rich fills also pay more for vector coverage certification. Existing offset-failure hatch fallback, round-nib corner limits, and intentional post-modifier fragmentation remain. No global routing or speed optimum is claimed.

Release native (serial, one warmup + five samples) on the same machine:

| Scene | Generation median / tail (ms) | Planning median / tail (ms) | Runs | Primitives |
|---|---:|---:|---:|---:|
| contour-small-dump | 0.26 / 0.27 | 0.00 / 0.01 | 1 | 62 |
| contour-disc-dump | 1.86 / 1.89 | 0.02 / 0.03 | 2 | 621 |
| contour-holes-dump | 359.42 / 369.59 | 7.03 / 7.66 | 977 | 5969 |
| contour-repeated-dump | 20.60 / 21.56 | 1.97 / 2.09 | 200 | 4500 |
| cleanup-contour-dump | 3111.25 / 3172.27 | 48.15 / 55.51 | 6429 | 77801 |

Stage timings are in `contour-cleanup-native-results.jsonl`. The four standard dumps are the small/disc/many-hole/repeated fixtures from the original contour benchmark; the artwork dump is produced by `DUMP_SCENES=1` above. Native and WASM geometry can differ on offset degeneracies; these figures are per-build measurements, not a cross-build bitwise-parity claim.

# Exploration: a region-aware stipple fill

**Branch:** `perf/explore-region-aware-stipple` (never merged, never on master)
**Base:** `43177bd`
**Verdict: the idea does not pay. Do not merge as written.**
This document exists so the measurement is on record and nobody re-treads it.

## What prompted it

Instrumenting `contours-2-multicolor` — eight nested contour bands, each
stipple-filled — showed **eight `generate` calls, each over a bbox of ~68 000
units², essentially the whole 200 × 200 drawable, producing ~18 300 dots,
145 758 in total.** The bands are thin, so the engine discards most of every
call's dots. It looked like a clean 8× of wasted work: the fill proposes over
the region's *bounding box*, and a thin band's bounding box is the whole shape.

## What the branch changes

`generate` refuses a candidate that falls outside the region rather than
proposing it and letting the engine throw it away:

- `region.contains(x, y)` joins the disk test in the candidate loop
- because refusing outside candidates blocks Bridson's propagation across a
  gap, the loop re-seeds when the frontier empties (up to 64 random tries
  inside the region) — that is what covers a region of several disjoint
  islands, which a single bbox-wide seed used to give for free
- the inlined `fits` test becomes a function so the seeder can share it

This changes the ink of every stipple drawing: the candidate sequence, and so
the `rnd()` stream, diverges from the first refused candidate.

## Why it fails

`region.contains` is an **exact point-in-region test over the shape's own
primitive contours** in paper mm — arcs and cubics included. Today the engine
calls it once per *accepted* dot, in Rust, after the fill has finished. A
region-aware fill must call it per *candidate*, which is `K = 24` tries per
frontier point — roughly twenty times more often — and in JavaScript.

`contours-2-multicolor`, the `fills` column, seed 42:

| variant | fills |
|---|---|
| master (`43177bd`) | **476 / 514 ms** |
| branch, `contains` before the disk test | **110 299 ms** |
| branch, disk test before `contains` (cheap test first) | **8 029 ms** |

Ordering the cheap test first helps by 14×, and it is still **17× slower than
master**. The reason it cannot be rescued by ordering: outside the band the
disk grid is empty, so `fits` *passes* for candidates that are outside the
region. Every frontier point near a band edge therefore burns all 24 tries,
each on a full `contains`, before being retired — and each re-seed burns 64
more. The wasted work moves from cheap dot generation to expensive containment.

## What it would take to work

A **cheap conservative mask** of the region, built once per fill job, used only
to skip proposing where the region certainly is not. The engine's exact test
still decides what lands, so the mask may be as coarse and as dilated as it
likes. That is not a tweak to this fill — it is a new capability in the fill
API (`FillCtx` or `FillRegion` would have to hand fills a rasterised
occupancy, which the engine can produce in Rust far more cheaply than JS can
by probing `contains`). Worth considering on its own merits; it is not a
performance patch.

## One non-performance observation worth keeping

The branch produces **55 235 fragments against master's 54 677** on
contours-2-multicolor — about 1 % more ink inside the same bands. That is not
noise: under the current design a dot that lands *outside* the band still
occupies the disk grid, so it excludes inside neighbours that would otherwise
fit. The bands are very slightly under-filled today. It is a small quality
argument for region-awareness, independent of speed — and it would still need
the cheap mask to be affordable.

## Verification of the branch itself

317 TS tests, **316 pass**; the one failure is
`the committed golden fixture is what the product fills produce today` — which
is the point: the ink changes. The disk guarantee still holds (the brute-force
pair test passes), and the fill is still a pure function of its box, params and
stream.

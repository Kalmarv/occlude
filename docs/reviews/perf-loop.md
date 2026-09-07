# Optimisation log

A running record of measured performance work: what was measured, what was
changed, what was rejected, and what is still slow. Baseline for this log is
**750214f** (the consolidation closeout). Every number in it was taken on this
machine — Node v24.13.1, 8 cores, a shared box under a load average of ~3, each
benchmark run with `nice -n 10`, warm, medians of at least three runs. Timings
from earlier reports are not a baseline; they are re-measured here before use.

Harnesses: `packages/occlude/bench/` (see its README). The gates every entry
passes before it is kept: TS tests, `docs:check`, studio build with a wasm md5
match, studio tests, the church oracle (381.0 min, 16 515 travel mm), and
`renderhash --check` over six reference sketches.

---

## Entry 1 — edge queries prune instead of scanning (`src/query.ts`)

**Finding.** `query.edges` built a uniform grid, but neither query used it well.
`firstHit` gathered candidates from the *bounding box* of the move, so a move
across the drawing selected the whole grid — and the box-covers-most-of-the-grid
shortcut then handed back every edge. `nearest` gathered the whole `within` box;
the expanding-ring search its own doc comment described was never implemented.
Both then sorted the candidate list on every call and allocated a result object
on every improvement. Preparation built `cols × rows` JavaScript arrays
(~35 000 of them for the 35 k-edge fixture), and `excludeIncident` rebuilt a
`Set` by scanning all edges on every call.

**Why it was safe to prune.** Both answers are a lexicographic minimum —
`(distance, edge index)` for `nearest`, `(along, edge index)` for `firstHit`.
A lexicographic minimum does not depend on the order candidates are judged in,
so (a) the per-query sort is unnecessary, and (b) any candidate set that
contains every edge that could win yields the identical answer. For `nearest`,
rings expand until the nearest unvisited cell is further than the best distance
found so far — an edge at distance *d* has its closest point in a cell whose
minimum distance to the query point is ≤ *d*, so nothing that could tie or win
is skipped. For `firstHit`, the corridor of cells the segment actually crosses
(padded by the same `pad` the box used, which is 1000× the exact test's
tolerance) contains every edge that can produce a hit.

**Change.** Corridor traversal for `firstHit`; ring search with an exact
stopping bound for `nearest`; the candidate sort removed; scalar winner tracking
with one result object built at the end; the grid stored as one compressed block
(`Int32Array` offsets + items) instead of an array per cell; a vertex→edge
adjacency built once, lazily, on the first `excludeIncident`. The exact
arithmetic of both judges is untouched — same expressions, same `Math.hypot`,
same tolerances. The speed-up is entirely from judging fewer candidates.

**Verification.**

- Differential harness against a snapshot of the previous implementation:
  **19 708 comparisons, 0 mismatches**, comparing every field of every result
  (edge index, position, `t`, `distance`, `along`, `kind`, and `null`).
  Fixtures: 400 planarized chords (35 k edges), a 16 000-point chain, a unit
  square, coincident points with zero-length edges, one 1000-long edge beside
  short ones, a 21 × 21 lattice queried at exact lattice coordinates and cell
  boundaries, an empty material, and a single edge; `within` of 0, 1e-12, 1e-9,
  0.5, 3, 5, 50 and 1e6; zero-length, 2 mm, 20 mm and whole-drawing moves; moves
  running exactly along and past stored edges; both `excludeIncident` forms.
- Three regression tests added to `test/material.test.ts`
  (`query.edges: pruning keeps the full scan's answer`): a long move across a
  lattice meets the analytically first line it crosses; `nearest` over six radii
  agrees with a plain full scan, ties to the earlier edge, including exactly on
  a lattice vertex where four edges are at distance 0; a long edge is found from
  far along its length, where the cell size is the mean edge extent.
- Gates: 306 TS tests, docs 106/106, studio build with wasm md5 match, 81 studio
  tests, church oracle 381.0 min / 16 515 travel mm, and `renderhash --check`
  identical on ring-growth-alt, ring-growth-compact, web-growth, church,
  contours-2 and Ivy.

**Measurement** (`bench/qbench.mts`, seed 5, 400 chords planarized to 35 288
edges; the 16 k chain for the last two rows; medians of three runs):

| workload | before | after |
|---|---|---|
| prepare `query.edges`, 35 k edges | 17.2 ms | 10.5 ms |
| 1 000 `firstHit`, 2 mm moves | 20 ms | 8 ms |
| 1 000 `firstHit`, whole-drawing moves | 1 244 ms | 38 ms |
| 1 000 `nearest` within 3 | 58 ms | 6 ms |
| 1 000 `nearest` within 3, 16 k-edge chain | 32 ms | 5 ms |
| 1 000 `nearest` within 50 | 1 805 ms | 57 ms |

The six reference sketches do not call `query.edges`, so their render times are
unchanged (within the ±7 % run-to-run noise of this box) — as expected; this
entry speeds up sketches that ask the drawing questions, not the render path.

**Harness extension.** `bench/qbench.mts` now reports preparation cost
separately (median of 5) and its two long-query rows are no longer labelled
"fallback", since there is no longer a fallback to a full scan.

---

## Entry 2 — the planarity check stops building strings (`src/faces.ts`)

**Finding.** Profiling `faces()` on 18 244 V / 35 288 E showed **60 % of the
call inside `checkPlanar`**, which re-verifies planarity from scratch every
time. Per call, measured with in-place timers: segment list and duplicate-edge
keys 16 ms, the coincident-vertex map **50 ms**, `boxPairs` + classification
100 ms, and the actual face walk 110 ms. The two Set/Map keys were template
strings — `` `${a},${b}` `` per edge and `` `${x},${y}` `` per endpoint, so
~105 000 strings per call — and the endpoint loop allocated a two-element array
per segment as well. `boxPairs`, shared with `planarize`, sorted a boxed
`number[]` with a comparator that recomputed four `Math.min` calls and four
object property loads per comparison.

**Change.** `boxPairs` lays the four box columns out in `Float64Array`s once and
sorts an `Int32Array` of indices on the precomputed left edge; the pairs, and
the order they are visited in, are unchanged (the comparator was already a total
order, tie-broken by row). The duplicate-edge key becomes the exact integer
`min · n + max`. The coincident-vertex map becomes a hash of the two
coordinates' bit patterns with the coordinates themselves compared on a hit, so
a hash collision is resolved rather than reported: `validate` has already
rejected non-finite coordinates, and 0 and −0 hash together because `===` calls
them one position, exactly as the string key did.

**Verification.**

- Differential harness against a snapshot of the previous `faces.ts`:
  **616 comparisons, 0 mismatches**, comparing the whole planarized material
  (every coordinate, edge and attribute) and every face's index, area,
  perimeter, bounds and contours, plus `boundaries()` and a selection's
  boundaries — 6.7 MB of compared JSON on the 400-chord fixture alone
  (17 047 faces) — and the thrown message on every error path. Fixtures:
  400 chords, a 2 000-point triangulation, nested and corner-touching squares,
  duplicate edges, coincident vertices, coincidence at −0, zero-length edges,
  collinear overlap, a lattice, three concurrent lines, coordinates at 1e−6 and
  1e7, empty and single-edge materials, and 200 random small networks (a third
  of them snapped to a coarse grid so endpoints coincide and cross exactly).
- A hash-collision stress: one material of 130 000 distinct positions, where a
  32-bit position hash is expected to collide about twice. Both implementations
  build the position map without a false coincidence and report the same first
  crossing.
- Two regression tests added to `test/faces.test.ts`: the duplicate-edge and
  coincident-vertex messages, including −0 against 0; and 40 000 distinct
  positions producing no false coincidence.
- Gates: 308 TS tests, docs 106/106, studio build with wasm md5 match, 81 studio
  tests, church oracle 381.0 min / 16 515 travel mm, `renderhash --check`
  identical on all six reference sketches.

**Measurement** (`bench/fbench.mts`, new; seed 5, medians of 5 — 3 for the two
slowest rows):

| workload | before | after |
|---|---|---|
| `faces` of 18 244 V / 35 288 E (17 047 faces) | 247 ms | 161 ms |
| `faces` of a 5 000-point triangulation | 104 ms | 72 ms |
| `faces` of a 90 × 90 lattice (8 281 V, 16 380 E) | 72 ms | 61 ms |
| `faces` of 80 000 disjoint-segment vertices | 78 ms | 79 ms |
| `planarize` 400 chords | 132 ms | 137 ms |

Interleaved A/B on the same fixture, three alternating pairs, median of the
medians: `faces` 278 → 182 ms, triangulation faces 116 → 81 ms.

The two rows that did not move are honest: the disjoint-segment case has almost
no box overlaps and spends its time in the angular sort and the face walk, and
`planarize`'s own cost is dominated by its string-keyed event maps, not by
`boxPairs`. Both are named below as the next targets.

**Harness extension.** `bench/fbench.mts` is new: planarize, faces on a random
chord net, on a triangulation, on a regular lattice, and on 80 000 vertices of
disjoint segments, plus a face selection's boundaries.

---

## Entry 3 — a view's brand moves to a shared prototype (`src/material.ts`, `src/faces.ts`)

**Finding.** A CPU profile of `ring-growth-alt` (195 growth steps, ~2 000
vertices, 4 875 ms of sketch time) put **2 455 ms — 47 % of the whole render —
in `brandView`**. Every `Vertex` and `Edge` view was stamped with its owner and
kind by two `Object.defineProperty` calls, and a growth step makes a view per
vertex, per neighbour, per edge: roughly three million views over the render.
`Object.defineProperty` is the slow runtime path, and it was paid twice each.

**Change.** The brand moves to a prototype the views of one owner and kind
share, created once per material (and once per `Faces`); `vertex()`, `edge()`
and the face views are built with `Object.create(proto)`. `ownedBy` and
`viewKind` read the symbols through the prototype chain unchanged.

**Why the view still behaves as a plain object.** Symbol keys never appear in
`for…in`, `Object.keys`, `JSON.stringify` or a spread, and inherited properties
are not own properties, so `{ ...view }` still produces an *unowned* copy —
exactly what the non-enumerable own symbol gave. The one observable difference
is reflection: `Object.getOwnPropertySymbols(view)` now returns `[]` instead of
the two brand symbols. Nothing in the library, the tests, the docs examples or
the sketches reads it, and ownership is asked through `ownedBy`.

Micro-benchmark of the four candidates, two million views each, median of 5:

| build | time | reads back (20 × 200 k views) |
|---|---|---|
| literal + two `defineProperty` (before) | 751 ms | 45 ms |
| literal + one `defineProperties` | 1 377 ms | 62 ms |
| **`Object.create(branded proto)`** | **32 ms** | 46 ms |
| symbols in the literal (enumerable) | 38 ms | 72 ms |

The last was rejected: enumerable symbols make a spread copy owned, which
would loosen the ownership contract.

**Verification.** 309 TS tests (a new one pins the view contract: key order,
`for…in`, `JSON.stringify`, `toEqual`, an unowned spread copy, a foreign
material rejected, edge and face kinds, and a frozen face view), docs 106/106,
studio build with wasm md5 match, 81 studio tests, church oracle 381.0 min /
16 515 travel mm, `renderhash --check` identical on all six reference sketches,
and no regression in `bench/qbench.mts` or `bench/fbench.mts`.

**Measurement** (`renderhash`, seed 42, interleaved A/B, two alternating
pairs — the sketch column, which is the growth loop itself):

| sketch | before | after |
|---|---|---|
| ring-growth-alt (195 steps) | 4 727 / 4 808 ms | 3 014 / 2 800 ms |
| ring-growth-compact | 1 702 / 1 684 ms | 969 / 1 016 ms |
| web-growth | 535 / 573 ms | 313 / 328 ms |

Roughly **1.6–1.7× on every iterative growth sketch**, output byte-identical.

**Where the time goes now** (re-profiled, 3 089 ms): 1 738 ms in the sketch's
own closures (`pull`, `repel`, `drift` and the per-vertex loop — user-authored
callbacks, which stay flexible by design), 349 ms in `material.ts` closures,
296 ms in `sumBy`, 181 ms GC, 171 ms `stepOnce`, 51 ms `move`, 49 ms the
`Material` constructor. `sumBy` and `stepOnce` are the next library-side
targets.

---

## Entry 4 — adjacency is built when it is asked for (`src/material.ts`)

**Finding.** Every `Material` constructor built `adj`, an array of `n` arrays,
and pushed both ends of every edge into it. A growth loop makes one state per
iteration and most never ask for adjacency — `prev`/`next` walk the chain,
`neighbours` is spatial — so a 195-step run allocated a few hundred thousand
arrays for nothing, and the biggest states paid the most.

**Change.** The constructor keeps its eager validation (an edge naming a vertex
beyond the last row, or joining a vertex to itself, still throws at
construction) and stores an empty box; `adj` becomes a private getter that
fills the box the first time anything asks. A frozen material can hold a
mutable box, so nothing about freezing changes.

**Measurement** (`bench/gbench.mts`, new; medians of 3–5):

| workload | before | after |
|---|---|---|
| 100 000 isolated points, 50 move steps | 3 118 ms | 2 261 ms |
| 200 000-vertex ring, points + one move step | 674 ms | 407 ms |
| 2 000 steps of a 200-vertex ring | 1 304 ms | 1 089 ms |
| 20 000: `steps(1)`, move only | 28 ms | 13 ms |
| 20 000: `steps(1)`, split every edge | 114 ms | 98 ms |
| growth: 2 000-vertex ring, 40 steps | 601 ms | 624 ms (flat) |
| growth: the ring-growth-alt shape | 846 ms | 836 ms (flat) |

The growth rows are flat because those sketches do reach adjacency once per
state; the win is in states that never ask, and in the largest states.

`renderhash`, seed 42, against the entry-1 baseline: ring-growth-alt
4 772 → 2 745 ms, ring-growth-compact 1 562 → 841 ms, web-growth 523 → 217 ms
— the cumulative effect of entries 3 and 4. Hashes identical; 309 TS tests,
docs 106/106, church oracle unchanged, studio built with wasm md5 match.

**Harness extension.** `bench/gbench.mts` is new: the ring-growth recipe at
three sizes written the way the sketches write it, the per-step machinery
isolated at 2 000 and 20 000 vertices (`points`, `edges`, `neighbours` prepare
and query, `steps` move-only and split-every-edge, `separation`), and three
demanding cases — a 200 000-vertex ring, 2 000 steps of a small ring, and
100 000 isolated points with no edges at all.

---

## Entry 5 — marching squares stops building four closures per crossing cell (`src/isolines.ts`)

**Finding (and a correction to the method).** Profiling the contour sketches put
272 ms of self time in `marchLevel` and 82 ms in `__name`. `__name` is
**esbuild's**: `tsx` stamps every function expression with
`Object.defineProperty(fn, 'name', …)` at *creation*. The compiled library
(`tsc` → `dist/`) and the Vite studio bundle contain none of it, so any bench
run through `tsx` overstates a closure-building hot path. Measured on the same
code, 9 levels over an 801² grid: **419 ms under tsx, 282 ms on `dist`.** This
is recorded at the top of `bench/README.md`; every entry from here on confirms
a closure-heavy result against the compiled library.

The real finding underneath: `marchLevel` declared four arrow functions
(`Tx`, `Bx`, `Ly`, `Ry`) *inside the cell loop*, wrapping the already-hoisted
`xTx` / `yLy` helpers so a case could take only the crossings it needed. They
capture `i` and the four corner samples — which forces those variables into a
heap-allocated scope context on **every iteration of the inner loop**, not just
the ones that build a closure.

**Change.** The four wrappers are deleted; each case calls `xTx(i, va, vb)`,
`xTx(i, vd, vc)`, `yLy(j, va, vd)` or `yLy(j, vb, vc)` directly. Same
expressions, same evaluation order, same laziness — an edge with no crossing is
still never divided. The emitted coordinates are bit-identical by construction.

**Why cells with no crossing got faster too.** They did not stop doing work of
their own; they stopped paying for the context the closures required. The
all-absent field, which `continue`s before the switch on every cell, went
30 → 13 ms — the clearest evidence that the cost was the captured scope, not
the closures' own allocation.

**Verification.**

- Differential against `HEAD`'s `isolines.ts`: **4 293 comparisons, 0
  mismatches** — every point of every contour, the `closed` flag and the thrown
  message. 13 fields (wavy, dense, bowl, plane, a constant field exactly *at*
  the level, all-absent, a NaN hole, a half-absent domain, ±Infinity, a saddle
  grid, stair steps, spikes), 8 level sets (including a repeated level and
  ±1e-12), 5 steps (0.5 … 25), 4 bounds (including 1 × 1 and a 200 × 3 sliver),
  `close` on and off, plus 120 random pure fields. *(The first run showed 120
  mismatches — all of them the harness's own bug: the random fields called the
  seeded generator inside the field, so they were not pure. Fixed in the
  harness, not the library.)*
- Two regression tests in `test/isolines.test.ts`: an audit that every contour
  point lies on a sample edge with the level falling at exactly that fraction
  between the edge's two samples — an oracle that knows nothing about which
  case emits which crossing — over eight fields × two steps × `close` on/off
  (2 000+ crossings audited); and a one-cell saddle taking the diagonal the
  centre average asks for. Mutation-checked: swapping a crossing in case 2 and
  in the rarely-hit case 11 both fail the audit.
- Gates: 311 TS tests, docs 106/106, studio build with wasm md5 match, 81
  studio tests, church oracle 381.0 min / 16 515 travel mm, `renderhash --check`
  identical on all six reference sketches *and* on contours-3, contours,
  contour-portrait and testing-fields.

**Measurement** (`bench/ibench.mts`, new; run against `dist`, interleaved A/B,
two alternating pairs, medians of 3–5):

| workload | before | after |
|---|---|---|
| 9 levels, step 0.25 (801² grid), wavy | 299 / 262 ms | **105 / 110 ms** |
| 40 levels, step 0.5 (401² grid) | 314 / 297 ms | **127 / 134 ms** |
| 20 levels, smooth bowl (few long contours) | 35 / 33 ms | **12 / 11 ms** |
| 9 levels, step 1 (201² grid) | 27 / 23 ms | 12 / 19 ms |
| one level, step 0.1 (2001² = 4 M samples) | 421 / 431 ms | 295 / 307 ms |
| one level, dense field, step 0.5 | 57 / 59 ms | 42 / 38 ms |
| 9 levels, a hole of absent samples | 30 / 24 ms | 16 / 14 ms |
| constant field, no crossings at all | 25 / 27 ms | 15 / 18 ms |
| all-absent field | 30 / 32 ms | 13 / 15 ms |

End to end (`renderhash`, seed 42, same hashes before and after):
contour-portrait 1 565 → 592 ms, contours 2 645 → 1 980 ms, contours-3
1 467 → 1 177 ms.

**Harness extension.** `bench/ibench.mts` is new, and `bench/README.md` now
opens with how to read a `tsx` number.

---

## Entry 6 — image channels are a number, not a string, in the sampling loop (`src/imageAsset.ts`)

**Finding.** Profiling the image-fed sketches put 506 ms of self time in
`satOf` and ~660 ms across the samplers. Both went through
`channelValue(px, i, ch)`, whose body is a **switch on a string** —
`'r' | 'g' | 'b' | 'a' | 'lum'`. A bilinear sample reads four pixels, and
`edge`/`dir` take four samples each, so one `edge()` query did sixteen string
comparisons. `satOf` did one per pixel of the whole image, and recomputed
`(y + 1) * (w + 1)` and `y * (w + 1)` inside the pixel loop. The SAT cache was
a string-keyed object read on every area sample.

**Change.** A channel becomes a small integer — 0–3 is the byte's offset in
the RGBA quad, 4 is luminance — resolved once where the sampler is built.
`channelValue` branches on that integer; `bilinear`, `boxAvg` and `sample`
carry it; the SAT cache is an array indexed by it. `satOf` hoists the pixel
data, the two row offsets and the channel decision out of its inner loop and
walks the byte offset forward. Every arithmetic expression is unchanged, and
`(y * w + x) * 4` became `y * w * 4 + x * 4`, exact for any image that fits in
memory.

**Verification.** The benchmark's accumulated sums are **bit-identical**
before and after on every row — 500 000 samples each of `lum`, `rgb`, `edge`,
`dir`, `bands` and the summed-area path (882171.572, 904241.645, 72929.100,
263812.192, 2253935.000). A new test in `test/api.test.ts` gives every pixel a
different value in every channel — the existing image test used grey pixels,
where an r/g/b mix-up cannot show — and checks each channel point-sampled and
area-averaged, plus the luminance weights. 312 TS tests, docs 106/106, studio
build with wasm md5 match, 81 studio tests, church oracle unchanged,
`renderhash --check` identical on all six reference sketches and on
lbg-stipple, lbg-stipple-2, flow-portrait, contour-portrait, beach-house
and Ivy.

**Measurement** (`bench/imbench.mts`, new; the committed `nyx.jpeg` asset,
500 000 samples per row, two A/B pairs, medians of 5):

| workload | before | after |
|---|---|---|
| `edge` (four lum samples) | 196 / 197 ms | **145 / 150 ms** |
| `dir` (four lum samples) | 187 / 191 ms | **149 / 133 ms** |
| `lum`, bilinear | 40 / 30 ms | 24 / 23 ms |
| `lum`, area (summed-area) | 66 / 51 ms | 31 / 43 ms |
| `bands(4)` | 45 / 63 ms | 27 / 26 ms |
| building the four summed-area tables | 62 / 52 ms | 35 / 31 ms |
| `rgb` (three channels) | 67 / 79 ms | 72 / 68 ms (flat — the tuple it returns dominates) |

End to end (`renderhash`, seed 42, same hashes): lbg-stipple-2 551 → 332 ms,
Ivy 326 → 243 ms, lbg-stipple 1 380 → 1 247 ms, contour-portrait 670 → 633 ms.

**Harness extension.** `bench/imbench.mts` is new. It samples the committed
studio asset, never a personal one.

---

## Entry 7 — the stipple fill judges its nearest cells first (`src/fills/stipple.ts`)

**Finding.** With entries 1–6 landed, `generate` in the stipple fill was the
largest library-side self time left: **948 ms across two sketches**
(contours-2-multicolor and contours). Its Bridson loop judges each candidate
against the 5 × 5 block of grid cells around it, minus the four corners, and it
scanned them row by row from the top-left. Most candidates are rejected — that
is what `K = 24` tries are for — and a rejecting neighbour is nearly always in
the 3 × 3 core, so the scan walked past empty outer cells before finding it.

**Change.** The block becomes a module-level `Int8Array` of 21 (dx, dy) offsets
ordered nearest first — the candidate's own cell, the eight around it, then the
twelve of the ring at distance two — and the nested loop with its clamped
ranges and corner test becomes one flat loop over that table. `ok` is a pure
any-overlap predicate that stops at the first hit, so the visiting order cannot
change the answer; the distance test, its ±1e-9 hypot band and the `rnd()` draw
order are untouched.

**Verification.** All 26 studio sketches hash identically. Two new tests call
the fill directly: every pair of dots brute-forced across four box shapes and
densities — a neighbourhood cell left out of the table shows up as a pair
closer than r, mutation-checked by deleting one offset — and purity given the
same box, params and stream. 314 TS tests, docs 106/106, studio build with wasm
md5 match, 81 studio tests, church oracle unchanged.

**Measurement** (`renderhash`, seed 42, the `fills` column, three A/B pairs):

| sketch | before | after |
|---|---|---|
| contours-2-multicolor | 629 / 597 / 632 ms | **500 / 491 / 513 ms** |
| contours | 383 / 363 / 365 ms | **311 / 306 / 299 ms** |
| contours-2-multicolor-3 | 244 / 218 / 237 ms | 169 / 224 / 210 ms |
| Ivy (hatch, not stipple) | 86 / 67 / 89 ms | 84 / 69 / 90 ms — flat, as expected |

About 1.2× on the stipple fill. Measured through `renderhash`, which runs under
`tsx`; the change creates no functions, so the `__name` caveat does not apply.

---

## Entry 8 — the clip loop stops allocating a span vector per occluder (Rust)

**Finding.** With the JS side worked through, the largest remaining number in
the heaviest sketches was the occlusion pass (`pass2` ≈ 850 ms on `contours`).
The crate has a feature-gated stage profiler; run natively on the committed
`export_bench` scene (4 500 filled circles, 54 945 fragments, serial build, so
it mirrors wasm):

| zone | time |
|---|---|
| 5 clip+fills | 397 ms of 472 ms total |
| 5b fills | 331 ms |
| 5s clip-spans-loop | 169 ms |
| 5q clip-query | 99 ms |
| 5a outline-clip | 56 ms |
| 6 dedupe | 44 ms |

`clip_spans` — called **once per occluder per primitive**, the pipeline's
innermost loop — built a fresh `Vec<Span>` on every call and assigned it over
the old one. `clip_one` built another per primitive, and `clip_chain` a third
per primitive of every fill chain.

**Change.** `clip_spans` takes a caller-owned scratch vector and swaps it in at
the end. `clip_one` takes a `ClipBufs` — the occluder query (already reused),
the span partition and that scratch — created once per shape, so it stays
per-task under rayon. `clip_chain` hoists its pair out of the per-primitive
loop. `Span` gains `Copy`. And `clip_one`'s "nothing in front of me" fast path
reads the **last** id instead of scanning the whole query: the index sorts and
dedups, and ascending ids are ascending rank, which the loop below already
relies on.

**Verification.** All 26 studio sketches hash identically; 62 Rust tests pass
under both feature sets, including a new one asserting that a spatial query
comes back strictly ascending and unique across five query boxes on 400
straddling boxes — mutation-checked by commenting out `sort_unstable`, which
fails it. 314 TS tests, docs 106/106, church oracle 381.0 min / 16 515 travel
mm, studio built with wasm md5 match, 81 studio tests.

**Measurement.** Native `export_bench`, serial build, three runs each:
**490 / 490 / 496 → 489 / 465 / 461 ms** (~5 %), fragment count identical.
Through wasm the signal is weaker — the pass is more than clipping and the
allocator differs — five A/B pairs of the `pass2` column:

| sketch | before (medians of 5) | after (medians of 5) |
|---|---|---|
| contours-2-multicolor | 644, 583, 629, 609, 629 → **629** | 584, 576, 618, 556, 656 → **584** |
| flow-user | 443, 513, 427, 453, 503 → **453** | 402, 407, 556, 434, 468 → **434** |
| contours | 818, 846 | 845, 826 — flat |
| church | 186, 235 | 203, 178 — flat |

Kept: the native number is clean and repeatable, the wasm medians agree in
direction, and an allocation-free innermost loop matches the `query_buf`
pattern already there.

---

## Entry 9 — the streamline separation grid becomes two typed arrays (`src/streamlines.ts`)

**Finding.** `gridNear` — the separation test a traced line makes at every
integration step — was **415 ms of self time on flow-user**, the largest
library-side number left. Its grid was `Map<number, number[]>`: a hash lookup
*and* a pointer chase into a separate JS array for every cell probed, and a
test probes (2r+1)² cells, nearly all of them empty. `scatterPoints` already
replaced exactly this shape with an intrusive linked list over two
`Int32Array`s, for exactly this reason; streamlines had not followed.

**Change.** `head[cell]` is the newest point stored in that cell and
`before[i]` the one stored before it, −1 terminating; the coordinates move to
two growable `Float64Array`s. The cell ranges are clamped once instead of
tested per row and column. `gridNear` is a pure any-hit predicate that returns
on the first one, so walking the chains newest-first cannot change the answer;
a point outside the grid is still neither stored nor numbered, so `skipFrom`
and the point indices are the same integers as before.

**Verification.**

- Differential against `HEAD`'s `streamlines.ts`: **440 comparisons over
  25 759 019 points, 0 mismatches** — every coordinate of every traced line
  and the thrown message. Ten vector fields (uniform, swirl, radial, a still
  centre, noisy, a NaN hole, a half-absent domain, ±Infinity, all-zero, and
  one that flips sign across bands), five spacings from 0.6 to 40, four
  bounds (including a 4 × 400 sliver and a 3 × 3 box), with and without an
  explicit step, plus 40 variable-spacing runs carrying `minSpacing`,
  `maxLength` and explicit seeds.
- A new test in `test/streamlines.test.ts`: the grid at its edges and in
  degenerate drawables — one cell wide, one cell tall, a 7 × 7 box, and a
  separation radius larger than the whole grid — plus seeds sitting exactly on
  the drawable's corners. Every point stays inside, and the half-spacing
  separation holds in each.
- Gates: 315 TS tests, all **26 studio sketches hash identically**, docs
  106/106, studio build with wasm md5 match, 81 studio tests, church oracle
  381.0 min / 16 515 travel mm.

**Measurement** (`bench/ibench.mts` run against `dist`, two interleaved A/B
pairs, medians of 3; contour counts identical on every row):

| workload | before | after |
|---|---|---|
| swirl, spacing 3 | 44 / 29 ms | **19 / 19 ms** |
| swirl, spacing 1 | 254 / 221 ms | **152 / 139 ms** |
| noisy, spacing 2 | 70 / 68 ms | **45 / 50 ms** |
| noisy, spacing 0.6 (dense) | 281 / 287 ms | **183 / 187 ms** |
| variable spacing | 133 / 129 ms | **87 / 88 ms** |
| a field that gives out over a disc | 64 / 65 ms | **37 / 35 ms** |
| fine step, spacing 2 | 291 / 265 ms | **223 / 196 ms** |

About 1.5× across the board. End to end (`renderhash`, seed 42, the sketch
column, three A/B pairs): flow-user 3 729 / 3 503 / 3 493 → **3 013 / 2 848 /
2 764 ms**, flow-portrait 754 / 628 / 755 → 664 / 591 / 628 ms, testing-fields
186 / 195 / 160 → 165 / 150 / 164 ms.

*(This is the file where a scalar `rk4` was tried and reverted — see Rejected.
The grid, not the tuples, was the cost.)*

---


## Entry 10 — a `within()` bound resolves once, not once per sample (`src/field.ts`)

**Finding.** `containsPoint` ran the whole bound setup on **every field
sample**: a `WeakMap` lookup for the loop index, a `sketchFrame()` call, a
fresh `Resolver` object and a returned tuple from `userPointMm`, and the
even-odd flag recomputed from the geometry. All of it is fixed for a given
bound. On flow-user that showed as 113 ms of self time in `containsPoint`
beside 98 ms in the ray cast it exists to reach.

**Change.** `containsPoint` becomes `containsTest(shape)`, which resolves the
index, the frame, the length resolution and the winding rule once and returns
a closure that does only the ray cast. `within()` builds it at the **first
sample**, not at `within()` — the frame a bound lowers against is the one in
force when the field is read, exactly as before. `resolveLen(x, inner)` per
coordinate is what `new Resolver(frame).pos(x, y)` resolved to.

**Verification.** All 26 studio sketches hash identically. 316 TS tests,
including a new one: two bounds sampled alternately 200 times each answer for
their own shape (including a translated one, tested on both sides of its
edge), and a third asked the same question a thousand times does not drift.
The existing `within` suite already covers transform opts, nested bounds,
even-odd paths with holes and `rectMode`. Docs 106/106, studio build with wasm
md5 match, 81 studio tests, church oracle 381.0 min / 16 515 travel mm.

**Measurement** (`renderhash`, seed 42, the sketch column, three A/B pairs):

| sketch | before | after |
|---|---|---|
| flow-user | 3 376 / 3 054 / 2 901 ms | **2 645 / 2 736 / 2 567 ms** |
| flow-portrait | 754 / 642 / 738 ms | **569 / 640 / 617 ms** |
| testing-fields | 147 / 183 / 243 ms | 162 / 135 / 166 ms |

---


## Entry 11 — primitives are encoded straight into a typed array (`src/render.ts`)

**Finding.** `encode` is the largest phase after the sketch itself on a dense
drawing. Instrumenting it: flow-user's `encodeScene` is **634 ms** and writes
**6 106 986 numbers** — 678 554 primitives — into a JS `number[]` nine at a
time, then copies the whole thing into a `Float64Array` for the engine. The
copy is only 56 ms of that; the variadic pushes and the array's own growth are
the rest. A micro-benchmark of 680 000 primitives: `number[]` push then
convert **181 ms**, push alone 97 ms, growable `Float64Array` with indexed
writes **61 ms**.

**Change.** A small `PrimSink` — a growable `Float64Array` with a `row()` that
writes exactly `PRIM_STRIDE` numbers and a `view()` returning the written
prefix as a subarray. `encodePrim` writes into it; the scene's prim buffer and
the fill prim buffer are both sinks now, and neither is copied at the end. No
stride, order or value changes: the same nine numbers in the same slots.

**Verification.** All 26 studio sketches hash identically. 317 TS tests,
including a new one that encodes 3 000 vertical lines — far past the sink's
first capacity and several doublings beyond — and checks the buffer's exact
length, that every row is a line, that each row's x is strictly beyond the
last (truncation, a lost prefix and a shifted stride all break it), and that
the contour table agrees about the count. Mutation-checked: dropping one row
during growth fails it. Docs 106/106, studio build with wasm md5 match, 81
studio tests, church oracle 381.0 min / 16 515 travel mm.

**Measurement** (`renderhash`, seed 42, the `encode` column, three A/B pairs):

| sketch | before | after |
|---|---|---|
| flow-user (493 023 frags) | 734 / 622 / 747 ms | **649 / 582 / 626 ms** |
| flow-portrait | 165 / 145 / 194 ms | **133 / 138 / 140 ms** |
| church | 198 / 194 / 214 ms | 182 / 178 / 203 ms |
| Ivy3 | 75 / 66 / 71 ms | 61 / 69 / 55 ms |

---


## Recorded, not acted on: a stipple fill covers the whole bbox, once per region

Instrumenting `contours-2-multicolor` — eight nested contour bands, each
filled: **eight `generate` calls, each over a bbox of ~68 000 units², which is
essentially the whole 200 × 200 drawable, producing ~18 300 dots, 145 758 in
total** — of which each band keeps only the ones the engine finds strictly
inside it. The bands are thin, so most of every call's work is discarded.

This is the contract, not a defect: the fill proposes candidates over the
region's bbox and the engine clips. It cannot be fixed while keeping the ink.
The dots are the Bridson loop's output over (bbox, r, stream), and each job's
stream is `${seed}:fill:${job.order}`, so two regions with the same bbox and
radius still draw different dots and no memo can help. Making `generate`
region-aware would change every stipple drawing's ink.

**A decision for Caleb, not the loop.**

---


## Remaining measured bottlenecks (from `bench/prof.mts`, baseline 750214f)

Recorded here so the next entry starts from evidence, not from a guess:

| workload | cost |
|---|---|
| `planarize` of 400 chords — string-keyed event maps (`byPos`, `seenPair`, `crossOf`, `contactOf`) | 137 ms |
| `faces()` of 80 000 disjoint-segment vertices — the angular sort and the face walk | 79 ms |
| `sumBy` over a growth step's neighbour lists | 296 ms of a 3 089 ms render |
| `stepOnce` — copy, compaction, split bookkeeping, and an `adj` array-of-arrays rebuilt per state | 171 ms of the same |
| isolines: `field` callback sampling — 287 ms of a 4 M-sample grid is the artist's own field function | — |
| growth step, 5 000-vertex ring | 53 ms (separation evaluate 24, `steps` 12) |
| `pn.edges` (35 k views) | 63 ms |
| `wasm_plan` on 3 600 circles | 66 ms |
| `render` 3 600 circles | 68 ms |
| `schedulePlan` (JS) | 20 ms |
| `append` ×400 (quadratic by construction) | 23 ms |

## Whole-set verification against the loop's baseline

`renderhash --check` over **all 26 studio sketches**, seed 42, baseline
`750214f` restored in place and then `beb30ae`: **26 of 26 hash identically.**
The sketch-time ratios on that pass:

| ≥ 1.4× faster | 1.05–1.4× faster | within noise |
|---|---|---|
| web-growth 2.50×, contour-portrait 2.52×, ring-growth-compact 1.90×, ring 1.81×, ring-growth-material 1.81×, ring-growth-alt 1.77×, lbg-stipple-2 1.62×, contours-3 1.47×, clearance-grid 1.46× | testing-fields 1.38×, Ivy2 1.37×, contours 1.25×, contours-2-multicolor-3 1.21×, Ivy 1.17×, contours-2 1.11×, contours-2-multicolor 1.08×, Ivy3 1.08×, convert 1.06× | flow-user, settle-sweep, lbg-stipple, church, beach-house, flow-portrait, messing-around, pen-width-test |

The eight in the last column first appeared as 0.78–0.95× on a single pass.
Re-measured interleaved, twice each, they are noise: beach-house 232/224 →
204/233 ms, church 612/576 → 581/655 ms, flow-portrait 986/831 → 950/1029 ms,
messing-around 346/324 → 309/339 ms, lbg-stipple 1201/1199 → 1169/1134 ms.
All of them are dominated by encode and the wasm passes, which none of these
entries touch, on a box shared with other services.

## Investigated and left alone: the Lloyd assignment (`src/points.ts`)

`iterate` — the loop behind `relax` and `settle` — was the largest remaining
library-side self time in the stipple sketches (477 ms). Phase timers put it
in the raster→site assignment rather than the triangulation: for
`settle(50)` at spacing 1.5, Delaunay construction 66 ms against 183 ms of
assignment; across the new `bench/pbench.mts` rows, Delaunay 7–147 ms against
assignment 33–99 ms.

Stubbing `del.find` out of the loop (a throwaway probe, immediately reverted)
dropped the assignment from ~46–60 ms to **3–5 ms**: `find` is over 90 % of
it, at about 76 ns a call for 655 000 calls. The surrounding arithmetic —
the density load, the two cell-centre multiplies, the three accumulations —
is nearly free, so precomputing a flat live-cell list, which was the obvious
exact rewrite, would buy almost nothing.

Everything that would actually help changes the answer or the dependency:
our own grid nearest-site query decides exact ties differently from d3's
descent, and matching d3's `_step` means reimplementing the core of a
dependency we already have. **Left alone on master; noted as a candidate for
exploratory work.**

## Rejected, with reasons

- **Scalar `rk4` / `dir` in `streamlines.ts`** (return into scratch variables
  instead of a tuple per sample; delete the per-step `al` closure that aligns
  the samples). Under `tsx` it looked like a 5–12 % win on flow-user and
  flow-portrait. On the **compiled** library it is not a win at all and several
  rows are slightly worse — noisy spacing 2: 62/64 → 73/80 ms, the gives-out
  disc 51/59 → 56/63 ms. The apparent gain was entirely esbuild's `__name`.
  Reverted. Instructive: V8 already escape-analyses the small tuples, and
  hoisting the scratch into the enclosing function turns four local reads into
  four *context* reads — the very cost the isolines entry removed.

- **An array fast path in `sum` / `sumBy`** (indexed loop instead of the
  iterator protocol, same terms in the same order). `sumBy` is 296 ms of self
  time in a 3 089 ms growth render, so the iterator looked like the cost. It is
  not: ring-growth-alt 3 014/2 800 → 2 807/2 969 ms and web-growth 313/328 →
  310/296 ms, i.e. inside the noise. V8 already escape-analyses `for…of` over a
  plain array. Reverted — a duplicated loop and a branch for no measured
  benefit. `sumBy`'s cost is the accumulation and the `vx`/`vy` calls
  themselves.
- **Numeric keys and a hoisted `paramOn` in `planarize`** (`faces.ts`).
  `planarize` builds four string-keyed maps — `${x},${y}` per participating
  row, `${a},${b}` per edge, `${i},${j}` per crossing, `${vertex},${edge}` per
  contact — and `classify` declared its `paramOn` helper inside itself. The
  same treatment as entry 2 was written and proved identical (the faces
  differential, strengthened to **707 comparisons, 0 mismatches**, now with 80
  grid-snapped networks carrying two attribute columns so the merged-row
  groups and the attribute reconciliation both run, and a twelve-row
  single-point merge). Measured on `dist`, interleaved, two pairs: planarize
  400 chords 130/138 → 115/143 ms and 1 500 chords 2 311/2 253 → 2 204/2 286 ms
  — flat; 3 000 chords (1.01 M vertices) 12 220/12 182 → 11 740/11 494 ms, a
  repeatable ~4 %. These maps are built once over n and E, not in an inner
  loop, so the strings only start to matter at a million vertices — a
  twelve-second pathological planarization, not drawing or interaction. The
  `byPos` rewrite needs about fifteen lines of bucket handling to stay exactly
  ordered; 4 % there does not pay for it. Reverted. The **large-scale rows are
  kept** in `bench/fbench.mts` (1 500 and 3 000 chords, their own generator so
  the older fixtures keep their values) — the harness had no planarization
  bigger than 400 chords.
- **Caching the seeded `Rng` behind the module-level `noise()`**. Profiling
  contours-2-multicolor-3 put 637 ms of self time in the simplex kernel, and a
  micro-benchmark seemed to show the wrapper adding 17 ns to a 25 ns call
  (`state.noise` 209 ms vs `rng.noise` 127 ms per five million). Building the
  candidate — cache the state's `rng` behind an identity check — measured flat:
  150/189 ms before, 161/160 ms after. The apparent overhead was the
  micro-benchmark's own single, fully-inlined call site, not something the real
  call sites pay. No change made.
- **`Object.defineProperties` for the view brand** (one call instead of two):
  1 377 ms per two million views against 751 ms for two `defineProperty` calls —
  nearly twice as slow. See entry 3.
- **Enumerable brand symbols in the view literal**: fast to build (38 ms) but a
  spread copy would then be *owned*, loosening the ownership contract. See
  entry 3.

## Known flaky gate (pre-existing, not from this work)

`packages/occlude-studio/src/drawing.test.ts` → *"an export asked before
resolution waits for the real range instead of taking everything"* fails
intermittently under load: it races a `setTimeout(r, 0)` tick against a 30 ms
mock toolpath. Measured on this box, full studio suite: **1 failure in 8 runs
on the unchanged tree, 2 in 8 with entry 4 applied** — the same wall-clock race
either way, and no causal path from a material change to a mocked
`Drawing` client. Recorded rather than repaired here; a timing repair is a
test-only change that does not belong in a performance commit.

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

## Remaining measured bottlenecks (from `bench/prof.mts`, baseline 750214f)

Recorded here so the next entry starts from evidence, not from a guess:

| workload | cost |
|---|---|
| `planarize` of 400 chords — string-keyed event maps (`byPos`, `seenPair`, `crossOf`, `contactOf`) | 137 ms |
| `faces()` of 80 000 disjoint-segment vertices — the angular sort and the face walk | 79 ms |
| `sumBy` over a growth step's neighbour lists | 296 ms of a 3 089 ms render |
| `stepOnce` — copy, compaction, split bookkeeping, and an `adj` array-of-arrays rebuilt per state | 171 ms of the same |
| isolines / contours — not yet profiled | — |
| growth step, 5 000-vertex ring | 53 ms (separation evaluate 24, `steps` 12) |
| `pn.edges` (35 k views) | 63 ms |
| `wasm_plan` on 3 600 circles | 66 ms |
| `render` 3 600 circles | 68 ms |
| `schedulePlan` (JS) | 20 ms |
| `append` ×400 (quadratic by construction) | 23 ms |

## Rejected / not attempted, with reasons

- Nothing yet.

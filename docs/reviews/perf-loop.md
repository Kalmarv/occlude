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

## Remaining measured bottlenecks (from `bench/prof.mts`, baseline 750214f)

Recorded here so the next entry starts from evidence, not from a guess:

| workload | cost |
|---|---|
| `faces()` of 18 360 V / 35 520 E | 313 ms |
| `faces()` of a 5 000-point triangulation | 137 ms |
| `planarize` of 400 chords | 138 ms |
| growth step, 5 000-vertex ring | 53 ms (separation evaluate 24, `steps` 12) |
| `pn.edges` (35 k views) | 63 ms |
| `wasm_plan` on 3 600 circles | 66 ms |
| `render` 3 600 circles | 68 ms |
| `schedulePlan` (JS) | 20 ms |
| `append` ×400 (quadratic by construction) | 23 ms |

## Rejected / not attempted, with reasons

- Nothing yet.

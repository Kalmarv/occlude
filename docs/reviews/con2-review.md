# con2 — final consolidation review (7 September 2026)

Baseline 10e6fa4 → commits 81d19e3 (A), 50093c4 (B), fb07496 (C+D), 793e35f (E), plus the closeout. The Stage 0 ledger is beside this file; the benchmark harnesses are packages/occlude/bench/.

## What became simpler

- **One transfer story.** Point columns: declared policy (`interpolate` | `nearest`), a value update keeps it, per-operation overrides win for that call, crossings need a resolver only when candidates disagree. Edge columns now have a declared policy too: `copy` (categorical) or `distribute` (a length share, conserved across split, planarize and resample over several source edges). One implementation (`inheritEdge`) serves split, planarize and resample. The rule lives in one reference table.
- **One way to say "these".** `where` on every collection edit takes a predicate or a selection of the current state (membership by row, decided when selected), including `splitEdges` whose predicate form sees moved edges. A named frontier drives every edit in the tree, web and flagship examples.
- **Edges and points referenced alike.** `EdgeRef` (row or view) for `setEdge`, `disconnect`, `split`; every vertex accessor takes a row or a view of this state and refuses a view of another.
- **Four helpers, no framework.** `strokes(source, opts)`, `force.sum(...fs)`, `banding.over(column, { count })`, `complement()`. Placement is `group({ translate })`. The reference examples lost their local `faint`/`heavy`/`at`/`over`/`bands` helpers, the `attributes: {}` no-ops and the retired `attributes:` spelling.
- **Examples that show the operation.** A flagship "one material, four drawings" (generated once, four interpretations placed by group); attract, drift, relax, prune, relational, extraction, crossings rebuilt to make the claimed contrast visible; a non-growth hatched-cell composition; a plan example that teaches that `t.draw` picks a range of the order, shown by the docs page from the plan itself.

## What changed intentionally

- Stage A repairs (ten items, ledger in con2-ledger.md). Two behaviour changes worth naming: sampling a path keeps each subpath's own closure; `splitEdges` at an endpoint parameter creates nothing instead of throwing.
- `Material.contour` is the `Curve` (with `indices`).
- `t.plan` refuses `engine` with a reason; engine identity moved to the host side of `plan()`.
- Coordinates in the reference: `t.grid`/`t.bounds` are in the drawable's units (200 × 100 on the docs paper) while many examples use literal 0–100 coordinates and rely on the docs crop. The rewritten examples derive positions from `t.bounds()` where they mix the two; the older examples were left as they are. Worth a sweep later, not a contract change.

## Performance and the Rust decision

Measured on this machine, before → after (Node 24, warm):

| workload | before | after |
|---|---|---|
| growth step, 5 000-point ring | 392 ms | 55 ms |
| `separation` evaluate ×5 000 | 364 ms | 24 ms |
| `connect.nearest` k=3, 4 000 pts | 4 074 ms | 21 ms |
| 1 000 `firstHit`, 2 mm moves, 35k edges | ~1 196 ms | 23 ms |
| 1 000 `nearest` within 3 mm, 16k edges | ~2 000 ms | 33 ms |
| resample 16k pts, `copy` edge column | 88 ms | 11 ms |
| resample 16k pts, `distribute` edge column | 335 ms (reviewer) | 11 ms |
| planarize 400 chords / faces (18k V, 35k E) | 133 / 346 ms | unchanged |

Outputs were held identical: the three ring studies, web-growth and the church oracle hash the same before and after, because the kernels keep the neighbour order and the arithmetic of the generic form (down to `Math.sqrt` over `Math.hypot`).

What remains: a 5 000-point step is now ~55 ms, of which `steps` itself (copy, compaction, split bookkeeping) is ~13 ms and the rest is force evaluation through vertex views (`cur.points` + tension + drift closures). Planarize + faces at 18k vertices is ~0.5 s. Queries spanning the whole drawing still scan.

**Rust decision: none now, revisited on evidence.** After the JS improvements the tested workloads — the reference ring studies, web growth at ~2 000 vertices, the 400-chord planarization, the plan pipeline on the church — run within what the studio and the examples need. What a Rust port would save on a growth step, and what moving a material's columns across the wasm boundary each step would cost, were not measured; no material operation lives in Rust to measure against. The only crossing costs measured are the plan pipeline's (decode 2.4 ms, hash 3.5 ms, toolpath 6.8 ms for a 422 KB plan), which are small. So: current performance meets the tested needs; Rust is revisited when a sketch's measured need exceeds it, with `bench/` as the baseline. The tour, the plan pipeline's dominant cost, already lives in Rust.

## Remaining limitations and deferred items

- `nearby` with a user callback stays the slow general path (documented).
- No intrinsic `born`; `age` remains an explicit column by decision.
- Optional bundle not built: variadic `append`, `t.grid({ jitter })`, face-aware `polygon` winding, `FaceSelection.extract`, `Points.material()`, `Points` renames.
- Gallery: deferred by decision — its remit is credited, licence-checked classics, and the flagship belongs in the reference; nothing new there needed a gallery entry.
- Duplication folded where touched (transfer inheritance); point-in-polygon ×4, pair-key schemes and bbox loops were left as the plan advised until their numerical semantics are compared.
- `t.polylines` return type unchanged (consumers unaudited); closure now flows through `lowerToUserContours` for sampling only.
- Coordinate consistency — explicit follow-up: `t.grid` and `t.bounds` are in the drawable's units (200 × 100 for a 2:1 sketch on the docs' Square20 paper) while most reference examples use literal 0–100 coordinates and are shown cropped. Opened in the studio on real paper they draw in a sub-area of the sheet. The examples rewritten in this pass derive positions from `t.bounds()` where they mix the two; the remaining examples need a sweep that either states the sketch's own coordinate contract or scales by the bounds. Not done here.

## Gates

Every stage: TS tests (301), docs live examples (101/101), studio build with wasm md5 match, studio tests (81), church oracle (381.0 min, 16 515 travel mm), reference hashes. No Rust changed after Stage 1 of the drawing brief; cargo tests unchanged. No hardware was driven.

## Closeout (review of 793e35f)

- Edge-query broad phase pads every query box beyond the exact test's tolerance, so a contact just across a cell boundary is judged (regression test: a stationary query at x = 4.9999999999 beside an edge at x = 5).
- Distributed resampling carries its own monotone cursor: 335 → 11 ms at 16 000 points, totals conserved.
- `connect.nearest` with `count: 0` adds nothing; negative or fractional counts are refused.
- The crossings example builds its network from `rect` and `line` shapes sampled and appended, not from hand-typed positions and index pairs.
- Benchmarks and this review are in the repository (`packages/occlude/bench/`, `docs/reviews/`); the Rust paragraph above is qualified to what was measured.

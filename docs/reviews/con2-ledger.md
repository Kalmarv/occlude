# con2 — Stage 0 ledger (baseline 10e6fa4, 7 September 2026)

Reproduced with scratch scripts against the current tree; nothing changed in the repository. Fixture = the smallest input that shows the behaviour; each becomes the regression test for its fix.

| ID | Status | Fixture / evidence | Note |
|---|---|---|---|
| A1 | **Confirmed** | `curve(...).attribute('kind', 1, { transfer: 'nearest' }).attribute('kind', 2)` → `transfers.kind === undefined` | policy dropped on value update |
| A2 | **Confirmed** | `t.sample(path().moveTo(10,10)…close().moveTo(50,10)…lineTo(80,40).build(), { count: 8 })` → chains `closed, closed` | `geomClosed` decides once per shape (shapes.ts:91); the open L is closed |
| A3 | **Confirmed** | rows 0→1, 0→2, `age` 0; `split(edge 0, { parent: () => ({ age: 100 }) })` + `split(edge 1, { at: 0.5 })` → ages `100, 50, 50, 0, 0` | edge 1's cut inherits 50 from row 0 after edge 0's `parent` rewrote it: the moved state is mutated after publication |
| A4 | **Reproduced as ambiguity** | `connect.triangulate([[0,0],[10,0],[0,10],[10,0]])` → n=4, edges `0-2, 2-3, 3-0` | no corruption, no self-edge; the duplicate row 1 silently loses every edge to row 3 (last write wins in the coordinate map). Policy for duplicate positions is undefined — design decision per the plan |
| A5 | **Confirmed** | `withEdges([[0,1]], {})` on a material with edge column `w`, pair exists → no throw; `withEdges([[1,2],[0,2]], { w: 5 })` → `w = 1, 5, 5` | validation only when adding; one record for all new edges (the plan says the latter is fine) |
| A6 | **Confirmed by construction** | `key = gx * 65536 + gy`: cells (0, −1) and (−1, 65535) share a key | needs ≥ 65 536 cells of separation to bite in practice; still a packing without a range guarantee |
| A7 | **Confirmed** | `t.points([...]).settle(1)` → friendly error; `t.points([...]).relax(1).settle(1)` → no error, computes | instance-patched guard lost by `relax()` |
| A8 | **Confirmed** | `t.plan({ engine: 'x' })` → `plan: unknown option 'engine'` while `PlanOptions.engine` exists | |
| A9 | **Confirmed** | api.ts docstring `relax/settle/cells/material`; `Points` has no `material()` | |
| A10 | **Confirmed** | `split(e, { at: 0 })` returns the endpoint; `splitEdges(…, { at: 0 })` throws | design decision per the plan |

Timings (this machine, Node 24, warm, single run each; Codex numbers in brackets):

| Workload | Now | Codex |
|---|---|---|
| `connect.nearest` count 3, 1 000 / 4 000 pts | 205 / 4 074 ms | 327 / 5 915 |
| resample 16 000 pts with an edge column, spacing 0.15 | 88 ms | 281 (61 with a monotonic scan) |
| 1 000 `nearest` queries vs 15 999 edges | 2 081 ms | 581 |
| 1 000 `firstHit` vs 35 520 edges | 1 196 ms | — |
| `separation` evaluate, 5 000 pts | 364–384 ms; typed-array kernel 19 ms | — |
| planarize / faces, 18 k V 35 k E | 133 / 346 ms | — |

Scripts: scratchpad `ledger.mts`, `a3.mts`, `codex.mts`, `prof.mts`, `sepbench.mts`. Reference fixtures to hold through every stage: `ring-growth-alt` / `ring-growth-compact` (hash 751298479d52…), church oracle (381.0 min, 16 515 travel mm), golden SVG (Rust), docs 98/98.

Dismissed: none. Every reported item reproduced; A4 and A10 are reclassified as design decisions, as the plan allows.

Next review point per §9: land Stage A repairs as a separate change, then present the transfer table (§5.1) and the ergonomic signatures (§6) before any broader API change.

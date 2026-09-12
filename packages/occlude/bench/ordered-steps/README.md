# Ordered steps experiment

This is a runnable prototype, **not a replacement for `Material.steps` and not a new public API**. Import `orderedSteps` from `prototype.ts` in this directory to run it. Existing Studio sketches, rendering, and the production step engine remain unchanged.

The experiment tests the proposed contract: frozen `prev`, editable `current`, selection-first edits, immediate execution, and selections that retain identities but read live values. There are no hidden value snapshots at operation boundaries. A `move` callback can observe changes made by earlier callbacks in that same move. `current.points` and `current.edges` capture their membership when accessed; `filter` narrows it. Reading a saved live view after its removal throws.

The batch-side fixture calls have since migrated to selection-first `extrude` and explicit passes. The committed timing file below records the earlier engine comparison; rerunning measures the current batch API. The ordered editor remains an isolated experiment.

## Findings

The simple growth and force/subdivision examples convert cleanly. All benchmark fixtures have matching point and undirected-edge geometry to 1e-9 material units after ignoring row order. Attribute assertions are separate native TypeScript tests. This does not establish parity for arbitrary forces, curves, seeded random recipes, or the whole docs corpus.

**Shared-edge collisions expose a tradeoff, not an impossibility.** The initial strict prototype rejected the second frozen hit after the first split replaced its edge. Following the user's suggestion to combine batching and ordering, the revised prototype retains split-descendant parameter intervals. Later `split(originalEdge, { at: t })` calls resolve onto the surviving piece. Storage still compacts once, while queries and edits see changes in statement order.

Three executable alternatives now match the fixture:

- Keep frozen queries and resolve repeated original-edge cuts through interval lineage. This keeps the original collision example concise and avoids query rebuilding.
- Query an explicit snapshot of the updated editor before each tip attaches. This is slower and can change a real sketch because later tips see earlier new branches.
- Collect frozen hits by edge and perform one multi-cut. This is cheaper in this prototype, but introduces user-side grouping.

The lineage alternative adds internal rules: an original parameter is mapped to the current geometry of its descendant, repeated cut positions reuse junctions, and cuts in deleted intervals fail. It does not resurrect deleted geometry. It is implemented only for splitting; other edits do not silently expand a replaced edge into its children. Custom split callbacks operate on the resolved descendant, so arbitrary old batch callback behavior is not preserved. The simple iterative lineage walk can become quadratic for many ordered cuts; no balanced interval index is implemented here.

**Recommendation: retain this as an experiment.** Ordered editing is workable, and batching storage is compatible with it. Backward compatibility for replaced geometry adds complexity the user may not want. Selection-first arguments are independent of that decision. No production API has changed.

## Converted examples

These are experimental signatures. `orderedSteps(seed, count, callback)` is the harness standing in for a possible future `seed.steps` implementation.

Growing tips:

```ts
orderedSteps(seed, 10, (prev, current) => {
  const tips = current.points.filter(p => p.active === 1);
  current.extend(tips, p => ({
    position: [p.x + 1, p.y + 1],
    attributes: { active: 1 },
  }));
  current.set(tips, { active: 0 });
});
```

Frozen attractors, updated subdivision:

```ts
orderedSteps(seed, 30, (prev, current) => {
  const push = force.attract(prev, {
    radius: 10, excludeConnected: true, strength: 0.1,
  });
  current.move(current.points, push);
  current.splitEdges(current.edges.filter(e => e.length > 4));
});
```

The concise frozen-query version now works through split lineage:

```ts
orderedSteps(seed, 1, (prev, current) => {
  const query = edgeQuery(prev);
  const tips = current.points.filter(p => p.active === 1);
  current.extend(tips, p => {
    const hit = query.firstHit(p, [p.x, -1]);
    if (!hit) return [];
    return { to: current.split(hit.edge, {
      at: hit.t, point: { active: 0 },
    }) };
  });
  current.set(tips, { active: 0 });
});
```

Updated collision queries (explicit conversion, including its cost):

```ts
orderedSteps(seed, 1, (prev, current) => {
  const tips = current.points.filter(p => p.active === 1);
  current.extend(tips, p => {
    const query = edgeQuery(current.snapshot());
    const hit = query.firstHit(p, [p.x, -1]);
    if (!hit) return [];
    return { to: current.split(hit.edge, {
      at: hit.t, point: { active: 0 },
    }) };
  });
  current.set(tips, { active: 0 });
});
```

The grouped version in `fixtures.ts` gathers the same frozen hits into a `Map` by edge and calls `split(edge, { at: parameters })`. Returned junctions follow requested parameter order; repeated parameters share a junction. It avoids resolving descendants for subsequent cuts.

## Operator audit

| Operation | Prototype behavior |
| --- | --- |
| `move(target, vector/callback)` | Updated values, sequential displacement; accepts previous-state refs or editor refs/selections |
| `set(target, attrs/callback)` | Immediate writes; declared columns only |
| `setEdge` / `setEdges` | Immediate edge writes; subsequent splits inherit updates |
| `addPoint` | Returns a usable live reference immediately |
| `connect` | Immediate connection; duplicate existing pair is a no-op; self-edges rejected |
| `extend` | One/many/no children, inheritance, connections to existing or newly split points; captured parents only |
| `remove` | Deletes incident edges; identities never shift during the iteration; repeat removal is harmless |
| `disconnect` | Keeps points; repeat disconnection is harmless |
| `split` | Immediate replacement; endpoints reuse points; original split parameters map through surviving descendants |
| `splitEdges` | Splits captured edges once; no recursive inclusion of newly created children |

Point transfer policies (`interpolate`, `nearest`), edge transfer policies (`copy`, `distribute`) and split override callbacks are implemented. Legacy `attributes`/`parent` spellings, bare numeric references, history capture, and the full selection/query surface are deliberately outside this experiment. Stale and foreign references are rejected; references to split ancestors remain usable for splitting within this iteration. An uncaught callback failure discards the whole editor and leaves its input unchanged; per-operation rollback when the user catches an error inside the callback is not implemented.

## Identity and query caveats

The prototype uses stable IDs, live getters, per-point incident-edge sets, and a connection map. Removed slots remain until final compaction. Conversions to `Material` create an explicit immutable snapshot and retain a row-to-ID mapping for references returned by queries against that snapshot. No existing force or spatial index is silently refreshed.

Existing force kernels identify self and connected neighbors through a vertex's source Material. The prototype gives original live points their `prev` provenance, allowing the frozen radial-force example to preserve these exclusions. This is a narrow compatibility bridge, **not a production identity solution**: original points have updated coordinates but previous-state ownership, new points have no previous-state row, and arbitrary Material methods expecting owned immutable views have not been audited. A replacement engine needs an explicit lineage contract for force/query consumers. It must not simply pretend the editor is a normal frozen Material.

There is no implicit query over mutable `current`. Queries use `prev` or an explicit `current.snapshot()`. An efficient indexed query over the editor and a fully audited split-lineage contract remain design work before adopting this API.

## Compute comparison

12 September 2026, Node v24.21.0, AMD Ryzen 5 3600; two warmups and seven measured samples per mode. These are TypeScript geometry timings, not render or plot ETA. Tail is the largest of seven samples, not a population p99. Cases were measured sequentially, so small differences include runtime/GC noise. Raw values are in `results.jsonl`.

| Fixture | Output points / edges | Existing median / tail ms | Ordered median / tail ms |
| --- | ---: | ---: | ---: |
| tips-100 | 101 / 100 | 12.70 / 23.98 | 57.36 / 92.70 |
| ring-30 | 80 / 80 | 6.12 / 22.34 | 18.29 / 43.89 |
| ring-70 | 320 / 320 | 24.17 / 39.25 | 121.69 / 154.35 |
| collisions-300-lineage | 602 / 601 | 2.48 / 3.80 | 10.24 / 11.88 |
| collisions-300-grouped | 602 / 601 | 2.34 / 3.81 | 5.35 / 6.87 |
| collisions-20 | 42 / 41 | 0.29 / 0.59 | 2.02 / 2.47 |
| collisions-100 | 202 / 201 | 0.72 / 0.82 | 13.79 / 21.89 |
| collisions-300 | 602 / 601 | 1.82 / 2.14 | 94.81 / 103.16 |

The prototype is slower even without query rebuilding. It creates live accessor objects and identity bookkeeping for each iteration; this experiment does not profile their individual shares. Shared view prototypes, storage reuse and incremental indexes are candidates for a later measured implementation, not established speedups. Peak memory was not measured. These results describe this implementation, not a lower bound on ordered editing performance.

## Verification and reproduction

```sh
pnpm --filter occlude exec vitest run test/ordered-steps.test.ts
pnpm --filter occlude exec tsx bench/ordered-steps/compare.mts
pnpm --filter occlude typecheck
pnpm check
```

The 13 targeted tests cover all edit families, frozen input preservation, live callback ordering, selection membership, added-point edits, deletion identity, stale/foreign refs, force exclusions, multi-cut transfer, and all three collision alternatives and moved/deleted split descendants. `compare.mts` asserts geometry parity before timing each case. No production geometry or golden fixture is changed.

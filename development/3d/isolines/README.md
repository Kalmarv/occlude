# Scalar isolines and cross-contours (fork D, 2026-09-14)

Files: `packages/occlude/src/three/curves/isolines.ts` (kernel `isolines3`),
`packages/occlude/src/three/api/isolines.ts` (public `isolines`),
`packages/occlude/test/three-isolines.test.ts` (7 tests). Not yet exported from
`occlude/3d`; the main slice adds `export {isolines}` and the docs section.

## API

```ts
isolines(mesh, field, { levels, key?, maxSegments?, maxNodes?, budget? })
  : SurfaceCurves<{ level: number; levelIndex: number }>
```

- `field`: a numeric POINT attribute name, or a callback over mesh corner rows
  (`c => c.point.z`, `c => c.uv[1]` for cross-contours). Evaluated once per
  corner of the frozen revision.
- `levels`: explicit array; `{count, min?, max?}` gives `count` evenly spaced
  levels strictly inside the range (defaults: field min/max); `{spacing,
  offset?}` gives every multiple inside the range.
- Segment attributes are `level` and `levelIndex` (the contract said `index`,
  but edge rows already carry their row `index`, which would shadow it).

## Contract

- Linear interpolant of the three corner values inside each fixed triangle.
  Nonlinear fields are approximated by their corner samples; refine the mesh.
- Crossing parameter is binary64; the crossing point is constructed exactly on
  the represented edge (`integerWeights` on the two vertex slots), so incidence
  to both triangles sharing the edge is exact and validated by the graph.
- Half-open rule: a corner value equal to the level counts as above. A level
  through a vertex yields that vertex as the node (keyed by vertex + value), so
  neighbouring triangles meet there; zero-length pieces are never emitted.
- Node identity: (level index, unordered vertex pair or single vertex, the
  corner values along that edge, exact point). Two triangles share a node only
  when their corner values agree along the shared edge. A seam (different
  corner values at one vertex, e.g. the cylinder's `u` seam) keeps separate
  nodes and therefore separate chains.
- Chains: per level, open chains start at nodes of degree ≠ 2, leftovers are
  closed loops (first node = last node). `range` is cumulative length
  fraction, ulp-bumped to stay strictly increasing.
- Budgets: `maxSegments`/`maxNodes` (default 250000) throw before allocation;
  `budget` is the graph validator's budget.
- Kind `isoline`; supports one triangle each; ordinary `view`/`strokes` apply.

Verified: tilted plane contours straight with total length 2 per level; sphere
latitude loops closed within 3% of the analytic circumference (32 segments);
cylinder cross-contour one closed loop of exact polygon length; seam levels stay
open; vertex-level case connected with no zero-length segments; exact incidence;
budgets; async render through `view`.

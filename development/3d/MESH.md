# Mesh visibility slice (M2 in progress)

The dedicated `three.html` laboratory now accepts polygon surfaces, a box, and
open wires. Polygon topology stays separate from its deterministic ear-clipped
triangles. Positions and point/edge/face attributes are editable; rendering owns
a snapshot. Original edge IDs, triangle-to-face support, incident face labels,
and clipping ranges survive classification. Planar tessellation diagonals are
excluded; a deformed face can contribute a true piecewise silhouette.

The worker builds a conservative projected BVH and streams candidate pairs to
the hardware interval pipeline. Candidate capacity failures are explicit. Line
sources and occluders are independent. CPU robust orientation predicates refine
uncertain geometry; adjacent interval endpoints within the GPU tolerance are
refined before union so triangle boundaries cannot create spurious visible gaps.
This does not snap or fill an actual small gap. The regression covers both cases
across separate GPU batches.

The lab can orbit without regenerating geometry and select all edges,
silhouettes, or marked edges without another visibility dispatch. Hidden ink uses
a named pen and physical 2 mm dashes in paper coordinates, including perspective.
The lab disables planner bridging. This is not yet the final composable protected
stroke-run adapter.

## Evidence

- `three-mesh.test.ts`: topology, concavity, deformed silhouette, owned snapshots,
  source/occluder independence, near clipping, all-pairs BVH comparison in both
  projections, small true-gap preservation, and explicit capacity failure.
- `playwright-mesh/report.json`: direct Playwright on NVIDIA Turing hardware,
  retaining prior analytic and worker lifecycle checks. A cube has 12 source
  edges, 9 visible and 3 hidden; silhouettes select 6, marking selects 1 without
  reclassification. Overlapping meshes and a wire produce 25 source features.
- The 20-box comparison checks all 240 features against the CPU oracle over
  7,649 candidate pairs with deliberately small batches of 127. This is a
  correctness/batching fixture, not a GPU speedup claim. CPU refinement is still
  frequent on this topology-heavy fixture, and performance remains unfinished.
- Screenshots show the depth viewport and actual Occlude SVG together. The
  exported perspective box SVG is checked for physical 2 mm dash segments within
  the existing 0.005 mm finishing grid tolerance. Touching dashes at a source
  corner may share a planner path.
- Final isolated image `pnpm check`: Rust 10.6s, TS 20.6s, library types 5.2s,
  Studio types 4.7s, docs 12.6s, unchanged ink 14.5s, build 36.2s, smoke 2.2s.
  WASM MD5 remains `f74997a8bc946afc3bbaf4c26c313909`.

## Remaining

M2 is not complete: generic line sets, chaining and modifier order, protected
stroke breaks in the normal planner, and the full public/Studio integration are
still pending. Topology-edit identity, manifold-vertex validation, extreme-scale
precision and broad-phase hardening also remain. M3–M5 procedural operations,
hatch/sections, persistence, picking, independent fixtures and performance gates
remain in scope. The optional software-adapter lane remains unverified.

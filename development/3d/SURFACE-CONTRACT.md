# M6–M7 and selected M8 contract / reuse audit

Assignment: `3dpt2.md`, complete scope. Starting commit:
`000c9cb0e86af431ee48e4b8a3129d7fcf23e52c`. Fetched origin/dev at start;
there are no intervening commits and no landed orientation helper. The older
API contract/audit/final report describes the baseline, not this assignment's
completion. This contract is an implementation guide; planned signatures are
not claims that the API is already available.

Isolation: `/home/kalmarv/containers/occlude-3d`, branch `feat/3d-webgpu`,
Compose project `occlude-3d`, only service `dev`, built server on port 5273.
Resolved mounts use this checkout's source and dev-store. Production is outside
this assignment. Preserve user `development/3d/md` and the supplied spec.

## Vocabulary inventory and decisions

| Need | Existing vocabulary | Decision |
| --- | --- | --- |
| Repetition | `t.times`, seeded `t.rnd` / streams | Reuse. No new repetition helper. |
| Selection predicates and sets | 2D selection `find`, `some`, `every`, `has`, `union`, `intersect`, `subtract`; 3D filter/groupBy | Extend 3D `Collection` with these spellings and complement over the full source domain. Require identical revision/domain; preserve source order. |
| Topology relationships | 2D selections `.points`, `.edges`, `.boundaryEdges`; face/edge adjacency | Normal collections for incident domains; connected components over face adjacency. Cache topology separately from geometric measurements. |
| Attribute initialization | 2D `.attributes({name: valueOrField})`, `.edgeAttributes` | Same field-map spelling for points/edges/faces/corners. Every field sees the incoming revision. Retain existing row-patch `faceAttributes` as compatible input where unambiguous. |
| Evolving state | 2D `next.set`, `setEdge`, `setEdges`; 3D `next.move` | Reuse frozen-pass set operations, adding face/corner equivalents. Existing columns only; last assignment wins per column, moves accumulate. |
| Point/curve passes | Mesh and curve `.steps` and transforms | Extend point geometry and preserve richer surface-sample rows. No fake mesh domains. |
| Query consumption | Prepared scalar / CPU / async host batches return `{source,hit}` | Keep array iteration/indexing; add captured `.field((point,hit)=>value)` and `.sources(predicate)` returning a normal source selection. Validate the actual source revision/row. Capture attributes before intentional deformation; matching IDs alone never revalidates an old query. |
| Rotation | Geometry/instances accept XYZ Euler degree triples; no alignment helper | Add immutable rotation/frame values with axis-angle and axis-alignment operations, degree boundary, explicit pivot/reference/twist. Keep quaternion/matrix data through composition rather than mandatory Euler round trips. |
| Surface sampling | Triangle/face/barycentric `SurfaceSample` | Generalize into owned surface locations with model/world/chart interpretation and placement identity. |
| Supported marks | Single-surface section/hatch segments and affine visibility basis | Generalize the same carrier to multiple validated supports and graph nodes, preserving uncut parameters and seam-specific corners. |
| Intersections | Plane sections; no mesh/mesh constructor | `intersections` is a distinct construction operation; host-scheduled async path for substantial workloads. Contact class and both-source provenance remain data. No splitting/Booleans. |
| Corner attributes | Point/edge/face attributes only | Add one generic corner domain, including UV columns and triangle-to-face-corner correspondence. No duplicated geometric vertices for UV seams. |
| Surface mappings | Bound 2D material conversion, ordinary curves and source ranges | `mapSurface` maps numeric chart material through corner UVs; toolkit resolves frame-dependent shapes. Async orchestration for substantial workloads; explicit approximation/budgets. |
| Images | `t.image`, owned assets and scalar sampling | Extend coordinate sampling bridge and filtering; no second loader or raster output. |
| Tangent fields | Scalar fields, vector math, forces | New surface field context; reuse scalar tools. UV/world-projection/gradient/estimated-curvature directions feed one generic adjacency tracer. |
| Tracing and surface hatch | Paper-directed `view.hatch` | Preserve that mode. Async `t.hatch` creates stable surface-originated supported curves, surface-aware occupancy and bounded seeding. Family arrays use one tracer. |
| Tone | Existing scalar maps/ease/noise and named pens | Explicit tone convention 0 light, 1 dark; nested acceptance/length/family selection. Built-in directional light and UV image input share CPU/GPU evaluation. |
| Scalar contours | Model-plane sections | Generalize supported construction/chaining to scalar isolines; document vertex-interpolated field. No suggestive-contour claim. |
| Curve editing | Curves/material resampling and source stroke ranges | Reuse names/phase rules for resampling and trimming supported marks. No attachment loss at conversion boundaries. |
| Connected extrusion | Advanced independent nonadjacent-face extrusion | Separate connected-region edit operation, one vector per component, shared cap and boundary walls, corner transfer. Preserve independent operation. |
| Rendering and persistence | `view`, `strokes`, retained camera commit, saved results and portable download | Extend existing serializers/discriminants together. Same original-world visibility path; no ambient scene or label-based exemption. |
| GPU | Worker-owned query/deform/visibility host and phase accounting | Useful batched surface/attribute/tone/UV-image evaluation with CPU reference, leases, bounded cache and explicit async boundary. No JS-to-WGSL compiler. |

## Coordinate, ownership and precision rules

A source location binds an owned mesh revision and source face/triangle with
affine coordinates. Placements are explicit for world-space constructions.
Prototype patterns can be instanced without realization; ambiguous placement
attachment is rejected rather than choosing a matching prototype arbitrarily.
Support changes split segments; chain nodes can coincide without merging UV
seams. Only incident triangles on each actual supporting placement are exempt
from hiding a mark. Other triangles on either mesh remain occluders.

Stored chart coordinates remain attached through transforms/deformation;
world-projected mapping is explicitly different. Topology-preserving rebind
uses retained identities/affine coordinates, never nearest-surface guessing.
Topology changes use an explicit operation transfer or require regeneration.

Surface spacing is model/world distance with stated adjacency/occupancy limits,
not UV distance or global Euclidean geodesic claims. Tracing and mapping have
explicit model-approximation budgets separate from the existing paper interval
and projection budget. No camera-space epsilon, coordinate shift or blanket
short-line suppression may replace source incidence.

Critical contact geometry uses independent analytic/rational oracles and full
segment/topology comparisons. Existing world-depth oracles remain regressions.
Approximate curvature and shading normals do not replace represented geometry.
CPU/GPU tone thresholds use a documented shared/refined quantization contract.

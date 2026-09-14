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

## Implemented attribute/topology slice

The next slice uses typed mesh-only row relationships and collection subclasses;
point clouds and curves keep their own domain capabilities. Relations on rows
are nonenumerable getters so inspecting/serializing a row cannot recursively
walk the entire mesh. Set operations and groups preserve the concrete selection
capabilities; derived selections retain the group's key metadata.

Face connectivity follows shared polygon edges. `connected()` expands through
the source graph; `components()` partitions only the selected induced graph.
`boundaryEdges()` counts one selected incident face. Equal coordinates and
vertex-only face contact do not merge components. Mesh field maps and frozen
editor callbacks receive the same rich rows as direct selection iteration.

Adjacency is weakly owned by exact topology signatures (IDs, polygon/edge
incidence and fixed triangles), not positions or attribute values. Assembly
validates the topology signature before inheriting its token. Trusted frozen
snapshots reuse the token directly; mutable advanced surfaces revalidate their
signature. Motion/state passes retain adjacency but recapture measurements and
row ownership. Topology comparison remains linear work; this is adjacency reuse,
not a claim of constant-time geometry edits or bounded total scene size.

Point/sample passes retain captured sample provenance and typed history. State
literals widen to their value kind at the stepping boundary; vector dimensions
remain fixed. Attribute writes validate a whole selected operation before
publishing it, merge partial records and use last-write-wins per column. Corner
fields/edits still await the generic corner domain; they are not delivered here.

## Implemented orientation and point-grid slice

`axisAngle(axis, degrees)` and `alignAxis(localAxis, direction, options)` return
rotation values with `apply`, `then` and `inverse`. Geometry and instance fields
consume them directly; JSON/worker data retains normalized xyzw quaternions.
Legacy Euler arrays remain supported with their prior arithmetic. Up/localUp
constrain roll; previous orientation instead transports a frame. Twist follows
alignment about the resulting world axis. Singular/invalid references are
reported. A fixed local fallback handles exact antipodal alignment; previous
frames provide continuity through that stateless convention's singularity.

The user identified the modulo-based 6x6 instance layout as missing a helper.
`grid({cols, rows, layers?, spacing?, maxPoints?, key?})` now returns centered
model-space point geometry with typed i/j/k metadata. This reuses the familiar
cols/rows vocabulary and ordinary point editing/placement, while preserving
`t.grid` as the existing drawable/paper-cell helper. It has no mesh domains.

## Implemented corner foundation

Corner records now live alongside each polygon's ordered vertex list. Assembly
canonicalizes missing legacy records; a triangle maps into its source polygon's
corners. Mesh's fourth generic is the corner schema. `.corners`, field maps and
frozen `setCorner`/`setCorners` edits preserve actual row ownership and typed
point/face relations. Mirroring reverses both polygon lists together. Face
extraction and realization preserve columns/policies; subdivision interpolates
inside the parent face and refines fixed triangles for non-affine numeric corner
quads. No cross-seam averaging is implicit. Side transfer in advanced independent
extrusion, primitive charts and the shared owned-location/curve contract still
need the subsequent implementation; this is not an M7 completion claim.

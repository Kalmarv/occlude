# Procedural 3D contract

Implementation contract for `3dapi.md`. The acceptance examples in
`api-examples/` are tracked targets. Terrain and instanced forms are now executable
and live in `docs/three.md`; the paper composition target still needs its
dedicated acceptance verification. The broader curve and GPU profiling work
remains separate and pending.

## Values and domains

`occlude/3d` exports `mesh`, `plane`, `box`, `sphere`, `cylinder`, `cone`,
`torus`, `view`, `orthographic`, `perspective`, `pointCloud`,
`instanceOnPoints`, prepared `query`, and reusable `force` recipes. The existing
`strokes` import remains in `occlude`. Advanced `*3` access is available from
`occlude/3d/advanced`; the same visibility and output engines serve both APIs.

A mesh is an immutable owned revision with `.points`, `.edges`, `.faces()`.
Rows contain stable `id`, local `index`, an immutable `attributes` map and
flattened nonreserved attributes. Point rows add `x/y/z`; face rows add
`normal`, `center`, `area`; edge rows add endpoint rows and length. Built-in
row names are reserved and rejected as attribute names. Point and face
attribute methods propagate their types to later fields. Edge attributes
may be absent on newly created interior edges; their types must expose that
possibility instead of promising values that do not exist.

Collections are iterable and support `length`, `map`, `filter`, `groupBy` and
`extract`. Groups are collections with a `key`, not `{key, selection}` wrappers.
Face extraction produces a mesh with remapped shared vertices; point
extraction produces point geometry; edge extraction produces curve geometry.
Point/curve geometry does not pretend to expose editable mesh faces.
Selections retain their source revision. An editor rejects a selection from
another revision, even if its IDs happen to match. Explicit extraction and
new selections make ownership changes visible.

Geometry operations return new values. `.attribute`, `.edgeAttribute`,
`.faceAttribute`, `.faceAttributes`, `.translate`, `.rotate`, `.scale`,
`.displace` and `.subdivide` preserve the common mesh contract. Transform
vectors use world units; rotations use degrees and an explicit origin pivot.
Factories accept an optional semantic key; `.withKey(key)` names a reused
value without changing topology. Ordinary view object IDs derive from local
input order, not an ambient counter. Duplicate explicit keys are diagnosed.
Derived topology uses compact deterministic IDs and records immediate parent
IDs as provenance; allocation order, wall time and model RNG are irrelevant.

## Refinement and frozen passes

`plane(w=1,h=w)` is centered in XY with four points, four edges, one +Z quad.
Subdivision is generic: convex planar quads become four quads, triangles
become four triangles; concave n-gons and folded quads refine their existing
validated triangles. Every shared edge has one midpoint. This preserves the
represented surface, including folds, instead of imposing analytic shapes.
The full level request is budgeted before its first allocation.

Original point IDs persist. Child faces inherit face attributes and record
parent IDs. Midpoints/centers interpolate continuous numeric point attributes;
`{transfer:'nearest'}` preserves numeric categories. Other categories choose
the first source in canonical ID order; columns missing from any contributor
remain missing. Child boundary edges copy their parent edge attributes;
new interior edges start without edge attributes. IDs are metadata, never
interpolated columns. Corner attributes, smooth subdivision, selective
refinement and connected-region extrusion remain future work.

`.steps(n, (current,next,k)=>..., {every})` uses frozen inputs and accumulated
edits. `next.move(current.points, field)` adds displacements based on input
rows; repeated edits do not alter what the callback reads. Escaped editors
stop accepting edits when their pass finishes. Iteration counts continue
across calls; `k` starts at zero for each call, matching 2D steps. Optional
history includes the initial state, every requested completed iteration and
the final state once; historical values have empty histories of their own.
`.displace(field)` is one immutable displacement pass. CPU JS fields are not
silently compiled or reevaluated on the GPU.

## Interpretation

`view(geometryOrArray, {camera, stroke, hatch, sections, creaseAngle}, draw?)` returns a
retained drawable subtree. It composes with existing clips, groups, masks and
labels. Default ink selects visible boundaries, silhouettes and creases above
30 degrees; `creaseAngle` explicitly controls that artistic threshold.
`hatch` owns its input revision automatically and resolves spacing in paper
units. A hatch `select` predicate receives face rows for selective decoration.
Multiple hatch recipes have independent pens and optional keys; spacing,
angle and offset accept fields captured once on the typed eligible face rows.
`sections` captures model-space planes on the same revision. For instances the
planes belong to the prototype and section curves transform with placements.
Neither decoration requires callers to thread derived `.surface` values.
The callback replaces default emission and receives visible/hidden interval
collections with readable kind sets and captured source attributes.

`strokes(projectedCurves, {stroke, ...options})` records an explicit projected
stroke intent. It retains the classification, interval selection, full source
reference, support and physical paper frame until the bound interpreter.
Never flatten to anonymous contours. Existing supported stroke modifiers
must retain their source phase and deterministic style identity through
clipping. A view automatically retains its interpretation for camera commit;
custom callbacks must be pure, with captured stable inputs. Arbitrary JS
closure state cannot be serialized or frozen by the library.

## Queries, repetition and limits

`query(target)` prepares captured geometry once. Nearest, ray and segment
results distinguish world `distance` from parameter `t`; batch results always
retain their input source row, including misses. Forces are reusable fields
on the current iteration. Directional plane constraints have explicit sided
semantics; nearest-surface projection is not volume containment.

`instanceOnPoints(prototype, selection, options)` shares prototype geometry,
adds source row identity, per-instance attributes and transforms, and returns
an instance collection. `.realize()` is the explicit topology duplication
boundary. A view can consume instances directly. Mixed collections keep
mesh-only capabilities separate from point/curve capabilities.

This pass does not claim a general GPU field compiler, curvature-following
hatch, mesh–mesh intersection curves, connected-region extrusion, inset,
bevel or automatic GPU-device recovery. Profile input capture/serialization,
upload, dispatch, readback and CPU refinement separately; shader timestamps
alone do not establish an end-to-end speedup.

## Integration checklist

The new package exports must also be recognized by the Studio runner and the
headless `requireFor` adapter. `liveExampleToJs` rewrites root and 3D namespace imports. Monaco loads
nested source modules with their relative paths and registers both new entry
declarations. These integrations landed with the first working mesh slice. Test actual compiled examples
and editor diagnostics, not only direct TypeScript imports in unit tests.

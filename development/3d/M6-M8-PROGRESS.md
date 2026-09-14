# M6–M7 and selected M8 progress

Full objective: `3dpt2.md`. Starting dev commit:
`000c9cb0e86af431ee48e4b8a3129d7fcf23e52c`. Final commit: not yet delivered.
No completion claim. The scope below remains required until directly verified.

| Checkpoint | Required outcome | Current state / evidence |
| --- | --- | --- |
| 1. Contract and reuse | Inventory existing helpers, settle coordinate/domain contracts, actual target examples | Initial inspection and contract in `SURFACE-CONTRACT.md`; latest dev and isolation verified. Examples pending implementation. |
| 2. Shared data/API | Collections, topology, frozen edits, query fields, orientation, corners, surface locations and multi-source support | Partial: selection algebra, captured query fields, attribute maps/frozen writes, point/sample passes, typed mesh topology, orientation values and model-space point grids implemented. All nine Docker gates and 22 served live examples pass. See `surface-foundations/` and `attributes-topology/`. Corner/location and multi-source support remain pending. |
| 3. M6 intersections | Candidate BVH, exact contacts/policies, graphs, both-source support, editable demo and independent oracle | Required, not implemented. |
| 4. M7 mapping | Primitive/custom corners/UVs and transfers; vector patterns/images; rebind and repeated prototypes | Required, not implemented. |
| 5. M7 tracing/tone | General tangent tracer/curvature/spacing, crosshatch, isolines, CPU/GPU surface evaluation, curved/custom demos | Required, not implemented. |
| 6. Selected M8 | Connected-region extrusion, shared cap/walls/holes, frozen transaction, UV/provenance transfers | Required, not implemented. |
| 7. Integration | Acceptance A–E, actual Studio workflows/persistence, CPU/GPU performance suite, all gates, dev publication/final handoff | Required, not implemented. |

Final audit must cover every numbered spec subsection and verification-table
row, including candidate/output budgets, real async cancellation, contact order
invariance, surface attachment through deformation, corners through all topology
operations, tone monotonicity, style phase and output consistency. Sparse point
checks or primitive-only demos do not substitute for generic contracts.

Explicitly outside this batch: M9 cutting/reconstruction/Booleans; broader M8
inset/bevel/smooth subdivision/selective refinement; full UV unwrap; suggestive
contours; automatic worker/device recovery. Production and plotters untouched.

## First API slice

- `Collection` adds find/some/every/has and union/intersect/subtract/complement.
  Actual row ownership, source revision and domain are checked; source order
  and typed extraction survive the operations.
- CPU/async query batches retain their readonly array contract and add `.field`
  plus `.sources`. Fields reject unqueried rows and later revisions; captured
  answers do not dispatch more GPU queries. Intentional reuse captures an
  attribute before deformation or re-queries the edited geometry.
- Ten focused tests and existing mesh/query/sampling/instance tests pass. All
  nine gates pass; 239 stable existing docs drawings are unchanged, with only
  the new `three#19` baseline added. Church remains 15,601 chains / 96,037 mm
  draw / 16,515 mm travel / 381.0 minutes. Twenty served examples pass Monaco,
  vector export and nonfallback GPU checks. The new example issues one GPU
  query batch and consumes its field in an ordinary displacement.
- Dev-only deployment uses stamp `000c9cb-surface-foundations`; source/evidence
  in this checkpoint identify the change. Existing dev demo sources were read
  and compared; no store writes or production deployment were made.

Next: topology relationships and cache ownership, multi-attribute field maps,
frozen attribute edits and point/sample pass parity, then orientation and the
shared corner/location/curve foundation. The full M6/M7/M8 scope remains open.

## Attribute and topology slice

Implemented field maps for multiple attributes; initialized point/edge/face
state writes in frozen passes; point/sample transforms, steps and typed history;
mesh row/selection relationships and adjacency cache reuse across motion.
Captured sample interpretation stays attached to its original surface reference.
Existing query/force demo now consumes captured fields and typed `face.points`
without manual ID maps. New live `three#20` demonstrates evolving state.

Seventeen new focused tests cover frozen reads/writes, ownership, async and
closed-editor rejection, sample history, incident domains, disconnected sheets,
components, extraction and topology reuse. Existing query/selection and broader
regressions also pass. All nine Docker gates and 21 served Studio live examples
pass. All 240 prior stable drawings retain their hashes; only the new example's
hash is added. Church routing/timing and WASM identity are unchanged. Evidence
and remaining scope are in `attributes-topology/`.

Next: orientation values, generic corners and their frozen edits/transfers,
owned surface locations and multi-source curve support. M6 intersections, M7
mapping/tracing/tone/GPU evaluation and selected M8 region extrusion remain
required. No full milestone completion claim.


## Orientation and point-grid slice

Axis-angle/alignment values now pass through modeling and instances without
Euler conversion, with explicit composition, inverse, references/twist and
previous-frame transport. A user-requested centered point-grid factory replaces
the regular instance example's modulo arithmetic and preserves its ink exactly.
The sampled-tree example intentionally changes roll to shortest-turn alignment;
all other 240 prior stable hashes are unchanged. New `three#21` demonstrates
alignment and twist. There are 242 stable hashes and two unstable examples.

Eleven new orientation/grid tests and existing geometry/instance regressions
pass. All nine Docker gates and 22 served Studio examples pass on the isolated
dev build. Evidence and the deliberate ink-change explanation are in
`orientation-grid/`. Generic corners, surface locations/multi-source curves and
the entire M6/M7/selected-M8 implementation/integration scope remain required.

## Generic corner foundation

Added polygon-corner storage without splitting geometric points, typed corner
collections and point/face relationships, field maps, and frozen corner edits.
Transforms/mirrors, extraction and instance realization preserve corner values;
subdivision transfers within each parent face and retains fixed triangle fields
for non-affine quads. Both preflight and allocation guards enforce subdivision
budgets. Raw mesh import and ordinary view/instance types carry the new domain.

Ten focused tests plus a new committed-scene JSON round-trip test cover the
corner contract. All nine Docker gates pass; 23 served Studio examples pass
Monaco, SVG and nonfallback GPU checks. All 242 prior stable hashes remain
unchanged, with only `three#22` added. Church and WASM are unchanged; four
paper-box oracles retain zero interval error and nine world-depth probes pass.
Dev-only stamp `1baa409-corner-domain`; evidence is in `corner-domain/`.

The complete M6/M7/selected-M8 scope remains open. Next are owned surface
locations, explicit rebind and multi-source supported curves. Corner storage
alone does not deliver primitive UVs, surface mapping/tracing/hatch, contacts,
region extrusion, the GPU batch or final acceptance/performance evidence.

## Owned locations and sample rebinding

Added owned source/triangle/affine locations with distinct point/face/corner
attributes, model/placement coordinates, normals, selected UV/chart columns and
tangent derivatives. Placement identity is independent of labels. An attachment
lineage survives unchanged incidence through motion, attributes and mirrors;
independent meshes and topology changes require regeneration/transfer.

Sampling/scatter retain the richer typed context. `.rebind(target)` refreshes it
without RNG or nearest projection, preserves edited point state and IDs, and
starts a new history. The tiny-scale mirror sign now avoids determinant
underflow. Eleven new location/rebind tests and existing regressions pass.

All nine Docker gates and 24 served Studio examples pass. All 243 prior stable
hashes are unchanged, with `three#23` added. Church/WASM are unchanged; four
paper-box cameras retain zero interval error and nine world-depth probes pass.
Dev-only stamp `8f50ce6-surface-locations`; evidence is in `surface-locations/`.

Next is the shared multi-source curve carrier and its construction/rendering
integration. This checkpoint does not complete M6/M7: primitive UVs, contacts,
mapping, generic tracing/spacing/tone/curvature, the new GPU batch and selected
M8 region extrusion remain required, along with all acceptance/performance work.

## Supported-curve graph integration

Implemented exact rational graph nodes, multiple owned surface/placement
supports, branch/contact records and capacity limits. Legacy section/paper hatch
now normalize through the graph. Feature capture, scene options, ordinary view,
source-reference construction and Studio persistence carry it end to end.
Only actual supporting triangles are exempt from occlusion. Explicit rebind
preserves source parameters/attributes and rejects separated intersection
attachments. Placed locations now evaluate the represented transformed vertices.

All nine Docker gates pass (915 library / 168 Studio tests). All 244 prior stable
docs hashes and church routing are unchanged; `three#24` adds an advanced known
seam demonstration. All 25 served Studio examples, four independent rational
seam probes, four paper-box cameras (96 edges / 1685 curves, zero interval error)
and nine world-depth probes pass. The scene uses one indexed graph registry,
including contact-only data, rather than duplicating graphs in every feature.
Dev stamp `e9e4e60-supported-curves`; evidence is in `supported-curves/`. No M6/M7 completion
claim: the actual contact generator and the full remaining assignment remain
required, including mapping/tracing/tone, region extrusion, GPU evaluation and
acceptance/performance integration.

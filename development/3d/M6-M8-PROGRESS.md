# M6–M7 and selected M8 progress

Full objective: `3dpt2.md`. Starting dev commit:
`000c9cb0e86af431ee48e4b8a3129d7fcf23e52c`. Final commit: not yet delivered.
No completion claim. The scope below remains required until directly verified.

| Checkpoint | Required outcome | Current state / evidence |
| --- | --- | --- |
| 1. Contract and reuse | Inventory existing helpers, settle coordinate/domain contracts, actual target examples | Initial inspection and contract in `SURFACE-CONTRACT.md`; latest dev and isolation verified. Examples pending implementation. |
| 2. Shared data/API | Collections, topology, frozen edits, query fields, orientation, corners, surface locations and multi-source support | Foundations implemented through supported curves at `6ab53b6`: all nine gates and 25 served examples pass. Curve resampling/query/trace consumers and ordinary-first presentation remain open. See checkpoint evidence below. |
| 3. M6 intersections | Candidate BVH, exact contacts/policies, graphs, both-source support, editable demo and independent oracle | In progress: exact contacts, yielding BVH, atomic seam arrangement, coplanar boundaries, chain graphs, ordinary mesh/instance operation and async host adoption implemented. Construction consumers, rendering/phase audit and broader independent mesh/workflow evidence remain open. |
| 4. M7 mapping | Primitive/custom corners/UVs and transfers; vector patterns/images; rebind and repeated prototypes | Stored UVs/projections deployed at `bae1191`. Exact chart clipping tested locally; chart lookup/material mapping draft unverified and uncommitted. Vector patterns/images and full acceptance remain open. |
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

## M6 automatic intersection construction

The exact triangle contact kernel now covers point, segment and area contacts.
An independently authored Python Fraction oracle supplies 300 represented-input
cases. World BVHs and cached validated triangle adjacency reduce candidate
pairs; input/intermediate capacities and real task-yielding cancellation are
implemented. The source cache is owned by actual surface/placement bindings.

New internal assembly splits exact collinear overlaps, noncollinear crossings
and supported point contacts. It preserves separate source components. Symbolic
left/right occupancy of each source's coplanar triangle union removes overlap
interiors without a finite offset epsilon or polygon-edge multiplicity rule.
Atomic seams retain both-source triangle supports; isolated point contacts remain
data. Chains follow exact graph incidence, stop at branches and close loops
topologically. Their identity omits redundant collinear support splits.

The pipeline composes contact generation, assembly, chaining and the existing
graph validator through a yielding job. The synchronous graph constructor now
drains that same validator, preserving its ownership and support checks. Its
15 existing graph/render regression tests pass. Luna performed bounded reviews
and focused new tests; this is not a substitute for the outstanding independent
mesh oracle, full required gates or served Studio verification.

An independent analytical Python Fraction box oracle now also verifies complete
exact segment coverage and isolated contacts for 40 axis-aligned cases, including
shared faces/edges, tangencies, one-ULP gaps, nested/disjoint boxes and uniform
binary scales. These pass through the complete validated graph pipeline. Oblique
mesh-level and rendered visibility evidence remain outstanding.

The ordinary `intersections(a, b)` and `await t.intersections(a, b)` APIs now
create the supported construction directly from meshes or instance sets. Instance
selection/attribute edits preserve actual placement ownership; transforms create
new placements. Typed edge contact attributes support ordinary filtering. Async
execution captures input/options before yielding and checks scope before adoption.
The live crossing-forms example replaces the manually authored advanced seam
example at `three#24`; this deliberate ink change is recorded in `intersections/`.
Graph storage and this generator do not finish resampling, queries, adjacent-region
selection, trace seeding or the full remaining M6/M7/selected-M8 assignment.

All nine Docker gates passed for this checkpoint. Dev stamp
`6ab53b6-intersections` is served, and `crossing-forms` is saved in the isolated
dev sketch store with verified source readback. Targeted Playwright checks of
`three#12` and the changed `three#24` pass Monaco, SVG and nonfallback NVIDIA GPU
checks; the crossing-forms screenshot was inspected. Build/ink/church and served
evidence live in `intersections/`. No production operation was performed.

## Supported curve sampling and source phase checkpoint

`t.sample(curves, { spacing })` now produces ordinary editable point geometry
with tangents and exact multi-surface contexts, retaining interpretation through
selection/edits and explicit lineage-checked rebinding. Supported stroke references
retain authored chain phase through collinear support subdivision and output
selection. Focused Luna tests verify sampling and actual dash/wobble output.

All nine Docker gates pass. The deliberate three#24 ink change and new three#25
example are recorded in `curve-sampling/`; other docs ink and church routing are
unchanged. Dev serves `3424244-curve-sampling`, with `sampled-seams` saved in its
sketch store. Focused Playwright examples 24/25 pass. The requested 60-second
watchdog is live and a 22.4-second render completed successfully.

Progressive rendering investigation is in `PROGRESSIVE-RENDERING.md`; it is a
proposal, not implemented streaming. Full M6/M7/selected-M8 remains open, including
additional curve consumers, mapping/tracing/tone, region extrusion, GPU evaluation
and comprehensive workflow/performance acceptance.

## Stored coordinate checkpoint

Plane, box, sphere, cylinder, cone and torus now have typed corner UV/chart data,
including periodic seams, distinct caps and shared poles. Sweep/revolve retain
normalized profile/path coordinates and cap charts. Explicit `planarUV` and
`cylindricalUV` projection helpers use ordinary corner attributes. Stored values
follow deformation; reprojecting is an explicit operation.

Focused Luna primitive tests and projection/location/construction tests pass.
The new `three#26` rest-coordinates example selects UV bands before deformation
and rebinds the same sample points afterward. All existing docs ink and church
routing are unchanged. All nine Docker gates and focused Playwright checks
of the served example pass. Dev stamp `bce6f2b-surface-uv` is running and
`rest-coordinates` is saved/read back in the dev sketch store. Evidence is
under `surface-uv/`. Mapping/tracing/tone and the remaining full
M6/M7/selected-M8 acceptance are still open.

## Mapping work in progress

`curves/chartClip.ts` now clips a represented UV segment against one triangle
using exact homogeneous half-plane predicates. It retains rational original
segment parameters and affine weights, distinguishes isolated contacts from
positive-length boundary overlaps, and maps endpoints onto represented world
triangles without rounding away incidence. Four focused analytical tests pass,
including reversal, one-ULP separation and very different chart/world scales.
This kernel is not yet connected to public `mapSurface`: spatial chart lookup,
support deduplication, island/chain identity, source phase, material capture,
curved approximation and async orchestration remain required. This work is local
and uncommitted; it has not been deployed as a completed feature.

## User-requested pause and Claude handoff

Implementation paused on 2026-09-14 at the user’s request. See
`CLAUDE-HANDOFF.md` for exact deployed state, uncommitted mapping drafts, remaining
scope, evidence locations, test/commit/dev deployment workflow and user decisions.
No completion claim; mapping.ts/chartIndex.ts were written immediately before the
pause and have not been typechecked or tested.

## Surface drawing checkpoint (Claude, 2026-09-14)

Resumed from the Codex handoff. The uncommitted mapping draft was reviewed and
rewritten: closed-chain-only endpoint merging, overlap `layer` chains for a
sheet folded onto itself in chart space, interpolated node attributes,
`chart`/`component`/`pattern`/`layer` edge attributes, an explicit `frame` for
sketch-unit material, monotone float phase for binary64 slivers, and
`curves.place(instances)` for repeated prototypes. `await t.mapSurface` runs the
same construction with yields and cancellation.

New this checkpoint: `t.image(name).surface(...)` chart sampling with one
prefilter shared by CPU and GPU; surface field ingredients (`light`, `gradient`,
`curvature`, `across`, `tangentU/V`); an adjacency-walking tracer with direction
transport, crease/boundary/loop/budget termination and exact per-segment
support; seeded Jobard–Lefer hatch with surface-aware occupancy, lane-based
nested tone selection, crosshatch families with named pens, and `await t.hatch`
on meshes or instance sets; a batched GPU surface evaluation (`evaluateSurface`
on the host) with a CPU reference and the shared tone quantum; scalar
isolines/cross-contours; connected-region extrusion `mesh.extrude`; `view`
drawing generated marks in their own pens; `docs/three.md` reorganised
ordinary-first with nine new live examples (three#19–27). Every previous 3D
example keeps its ink under a new position key (`surface-drawing/ink-change.json`);
other pages are byte-identical; church routing is unchanged. Evidence and the
honest contract/limit statements are in `surface-drawing/README.md`.

Still open after this checkpoint: the six final performance workloads with
matched CPU/GPU cold/warm medians, broader M6 rendered-seam evidence
(oblique/near/far), a Studio A–E workflow pass (save/download/reopen,
orbit/commit per view) beyond the served example checks, and the final
requirement-by-requirement audit. Deferred by decision: M9, inset/bevel/smooth
subdivision, full UV unwrap, suggestive contours, automatic device recovery.

### Corrections and performance (same day)

The first served check found three docs defects (tonal example lit from below,
no live example for surface fields, an accidental clip on the two-views inset),
a missing dev asset (ivy.png uploaded through the asset API; asset responses
now `no-store`), and two real defects: float phase ranges of binary64 slivers
(now a zero-width range contract in the graph validator, no nudging) and a
tracer that bounced on gradient sinks at sphere poles until `maxSteps` (now a
converged `degenerate` stop). Tracer cost was cut roughly 3–8× by caching
per-triangle geometry, lazy attributes, blind side walks and an allocation-free
occupancy test; the user plans a dedicated optimization pass later. The six
workloads' CPU numbers are in `benchmark-surface/README.md`; the GPU run and
final served checks follow the `bae1191-surface-final` build.

### Visibility pruning, watertight abutments, unlimited capacities

The user's woven-vessel sketch (six swept helices, hidden lines) timed out in
Studio. Two exact improvements to 3D visibility: depth-cutoff candidate pruning
and seam closure for edge-adjacent occluders instead of refining both (details
and numbers in `surface-drawing/README.md`). At the user's direction all
count/byte capacity defaults are now unlimited; explicit caps remain. The
vessel is the seventh workload in `benchmark-surface/`.

# M6–M7 and selected M8 progress

Full objective: `3dpt2.md`. Starting dev commit:
`000c9cb0e86af431ee48e4b8a3129d7fcf23e52c`. Final commit: not yet delivered.
No completion claim. The scope below remains required until directly verified.

| Checkpoint | Required outcome | Current state / evidence |
| --- | --- | --- |
| 1. Contract and reuse | Inventory existing helpers, settle coordinate/domain contracts, actual target examples | Initial inspection and contract in `SURFACE-CONTRACT.md`; latest dev and isolation verified. Examples pending implementation. |
| 2. Shared data/API | Collections, topology, frozen edits, query fields, orientation, corners, surface locations and multi-source support | Partial: selection algebra and captured query fields implemented; 10 new tests plus regression coverage, all nine Docker gates and 20 served live examples pass. See `surface-foundations/`. Other shared-data requirements remain pending. |
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

# Procedural API requirement audit

Scope: the complete `3dapi.md` proposal, its `API-CONTRACT.md` interpretation,
numbered implementation stages, three named M5 demos and three acceptance
sketches. This is separate from the earlier M0–M5 audit. Reviewed against
implementation commit `0889e2c`, the `0acbd61` audit, and the final world-space
visibility correction documented in `paper-world-depth/`. The working tree,
source/tests and independently checked geometry were inspected.

**The scoped proposal is complete.** The user supplied the exact underside
camera after the earlier audit. It reproduced a substantial visibility error;
E3 now has a correction and independent CPU/served-GPU evidence. Remaining
microscopic positive gaps and explicit future modeling work are documented
without relabeling them as implemented or suppressing them.

Paths below are relative to the repository root. `test/three-*.test.ts` means
`packages/occlude/test/three-*.test.ts`; `api/` means
`packages/occlude/src/three/api/`; evidence folders are under `development/3d/`.
“Verified” means the named source and assertions cover that requirement, with
execution evidence from the implementation gates or served-browser reports.
It does not mean every possible input or camera is proven correct.

## Export, camera and retained interpretation

| ID | Requirement | Current implementation and inspected evidence | Status |
| --- | --- | --- | --- |
| E1 | Preserve the affected source, seed, camera, paper, pens, backend and export; trace the wrong fragment beyond CPU/GPU agreement | `api-export-defect/paper-composition.ts`, `README.md`, captured exports and `served-summary.json`; source affine basis in feature capture and `three/visibility/interval.ts`; convex-box hidden-face oracle in `three-hatch.test.ts` | Verified for the original saved-camera defect: 45 false point paths became zero. |
| E2 | Correct support/incidence without global epsilon, coordinate changes or blanket coincident-line suppression; protect near-coplanarity, real gaps, transformed support and clipping | `three-visibility.test.ts` explicitly retains tiny positive gaps/depth separation; `three-hatch.test.ts` covers both projections, near clipping and mirrored geometry; `three-shared-boundary.test.ts` independently checks convex cone occlusion and real open gaps; `instances-api/precision/report.json` records hardware precision cases | Verified focused corrections. Both CPU and GPU refinement consume the affine source basis. Canonical shared-edge evaluation supplies identical roots without interval-gap merging. |
| E3 | Resolve the fresh “paper-composition bottom” observation | `paper-world-depth/`: exact submitted source/camera and before/after main Studio captures; world-space exact refinement; seven unit regressions; independent rational ray/box oracle for 96 edges and 1,685 hatch segments across four cameras; nine analytic GPU probes; independent ray/triangle oracle for the changed forest drawing. | Verified: no box interval differences and no incorrectly hidden bottom hatch remain. All eight remaining collapsed paths across the four exports trace to positive microscopic source gaps; no coordinate adjustment or epsilon suppression. |
| C1 | Main Studio projection selector and correct Span/FOV control, reflecting selected exploration camera | `packages/occlude-studio/src/three/constructionPanel.ts`; `projection-controls/report.json`, `two-scenes.json` and the actual main Studio verifiers | Verified in main Studio, not only the laboratory. |
| C2 | Preserve target/direction/up and target-plane scale; valid clipping when eye distance changes; deliberate clipping remains expressible | Projection conversion and camera tests; `projection-controls/README.md` documents 45-degree default and the narrower-FOV precision-preserving case. Unit tests check projected target-plane scale and world clipping planes. | Verified; ordinary orbit does not silently replace explicit near/far planes. |
| C3 | Both-mode orbit/zoom/picking/copy/reset/scene switch without modeling RNG | `verify-scenes.mjs`, `verify-projection-scenes.mjs`, `projection-controls/camera-config.json`, `two-scenes.json`; counters and captured-object checks | Verified. |
| C4 | Exploration leaves committed ink intact; Commit reinterprets hatch/visibility, persists camera, downloads/reopens, rejects failed/cancelled/obsolete work | `three-camera-commit.test.ts`, main Studio camera commit/config reports; `paper-api/report.json`, `phase-accounting/served/report.json` | Verified with actual SVG/hash comparisons, retained model counters and failure-path assertions. Code camera edits plus Run remain supported. |

## Geometry contracts and building blocks

| ID | Requirement | Current implementation and inspected evidence | Status |
| --- | --- | --- | --- |
| G1 | Everyday `occlude/3d` names; advanced internals still accessible; own renderer, no React/Three dependency requirement | `api/index.ts`, package exports, `occlude/3d/advanced`, `api/view.ts` uses existing `lineArt3`/`drawing3` engine internally; runner/headless/live-doc/Monaco integration | Verified. Two facades share one rendering path. |
| G2 | Geometry factories return reusable data and do not draw; `view` is the explicit composable interpretation | Mesh/curve/instance value classes and `api/view.ts`; `three-view.test.ts`; terrain and paper acceptance sketches | Verified. Existing arrays/groups/clips/masks/labels compose with the retained drawing. |
| G3 | Four-point, four-edge, +Z quad plane; generic subdivision; 32×32 quads at level 5 | `api/mesh.ts`, `api/subdivide.ts`, `three-mesh-api.test.ts`, `three-subdivide.test.ts` | Verified counts, area, orientation and source immutability. No rows/columns parameter. |
| G4 | Refinement handles generated/imported triangles/quads/n-gons, concavity and shared edges; preserves represented shape; validated input and preflight budgets | Same subdivision tests verify box surface/creases, concave mixed polygons, folded represented triangles, shared-edge incidence, categories and oversize rejection. Raw `mesh` validates triangulation and owns inputs. | Verified for the supported validated polygon mesh contract. No analytic sphere projection or smooth subdivision is implied. |
| G5 | Point/edge/face attribute transfer, stable original IDs and child provenance, numeric vs categorical rules | `api/subdivide.ts` interpolates numeric columns, preserves `{transfer:'nearest'}` categories, copies parent face/boundary-edge data and leaves interior edges optional; `three-subdivide.test.ts`, `three-mesh-api.test.ts`, contract and live docs | Verified; IDs are metadata, not averaged attributes. Corner attributes remain explicitly future work. |
| G6 | Box/raw mesh plus sphere/cylinder/cone/torus share the ordinary contract | `api/primitives.ts`, `three-primitives-api.test.ts`, `primitives-api/served/report.json` | Verified seams/poles/caps, winding/dimensions, minimal resolutions, budgets and common downstream operations. |
| G7 | Curves/polylines/circle profiles, generic sweep/revolve | `api/curves.ts`, `revolve.ts`, `sweep.ts`; 6 curve and 12 profile-construction tests; `curves-api/served/`, `profile-construction/served/` | Verified shared seams, explicit caps, transported frames, domains/attributes, budgets, camera retention and independent GPU visibility oracles. Curves do not expose mesh faces or occlude surfaces. |
| G8 | Seeded surface sampling/scatter, instance-on-points/transforms and explicit realization | `api/sampling.ts`, `instances.ts`; `three-sampling-api.test.ts`, `three-instances-api.test.ts`; `sampling-api/served/`, `instances-api/served/` | Verified area-weighted samples, bounded Euclidean spacing, rich source metadata, shared prototype identity, per-instance transforms/attributes and budgeted explicit realization. |
| G9 | Frozen domain collections with existing spellings, keyed selection groups and meaningful extracted geometry | `api/collection.ts`, `mesh.ts`; `three-mesh-api.test.ts`, `three-curves-api.test.ts` | Verified `.points`, `.edges`, `.faces()`, filter/groupBy/extract and attribute methods. Point/curve extraction does not fabricate face capabilities. |
| G10 | Typed `{id,index,x,y,z,...attributes}` rows, reserved names and explicit attribute map | `api/mesh.ts`, typed assertions in mesh/query/sampling tests, real Monaco positive/negative probes in API evidence | Verified. Heterogeneous geometry views explicitly use the broad attribute map; single-mesh and instance overloads preserve precise face-column types. |
| G11 | Immutable reuse, owned raw import, cross-revision selection errors, safe decorations | Snapshot ownership in mesh/curve values, `MeshEdit`/`CurveEdit`, `api/view.ts`; mesh/view/decorations/instances tests | Verified input mutation isolation, closed escaped editors, wrong-revision rejection, shared surfaces across views and captured decoration eligibility. |
| G12 | Frozen `.steps`, accumulated edits, iteration/history semantics, displacement fields and explicit world domains | `Mesh.steps`, `MeshEdit`, curve pass adapter; mesh/curve/query-force tests; contract and live docs | Verified reads from current input, repeated accumulated moves, local k vs continued iteration, sparse history and synchronous callback requirement. |
| G13 | Deterministic identities without global counters/time/GPU ordering/RNG; optional semantic keys; supported provenance through edits/instances | `api/identity.ts`, mesh/view/instance ID construction, source-parent metadata and repeated-construction assertions | Verified deterministic local derivation and duplicate-key diagnostics. No promise of identity across arbitrary code rearrangement. |

## Drawing, queries and execution

| ID | Requirement | Current implementation and inspected evidence | Status |
| --- | --- | --- | --- |
| D1 | Default visible boundaries/silhouettes/creases, documented user-controlled artistic threshold, no automatic triangulation ink | `api/view.ts` defaults to 30 degrees; `three-subdivide.test.ts` checks box crease count; live docs explain crease controls; relief explicitly requests zero for shallow deformed creases | Verified. User's partial-base-grid observation remains a documented artistic choice, not a reason to ink all triangulation edges. |
| D2 | Decorations capture their revision automatically; physical spacing/pen/context; selective hatch and sections without `.surface` threading | `ViewHatch`/`ViewSection`, captured fields and shared surface in `api/view.ts`; `three-view-decorations.test.ts`, `decoration-api/` | Verified multiple pens/recipes, typed face fields, independent section square geometry and retained capture. Sections are model/prototype-space; hatch is paper-directed, not curvature-following. |
| D3 | Callback replaces default ink; readable coexisting kinds and actual visible/hidden interval collections | `api/projected.ts`, `api/view.ts`; `three-view.test.ts`, migrated visibility demo | Verified empty callback output is empty, hidden and visible are nonempty where expected, and group pen defaults apply. |
| D4 | Projected carrier retains physical frame, full source/support, dash phase and style identity through supported modifiers/clipping | `emitProjectedStrokes` selects ranges on the full classified source and delegates to `sourceStrokeShapes3`; `three-view.test.ts` checks exact planned dash endpoints; existing `three-phase`, `three-style`, `three-style-identity` tests exercise that shared finishing path; migrated visibility demo verifies source inspection and multiple styles | Verified existing supported modifier path; no anonymous-contour flattening. |
| D5 | Retained interpretation can rerun for a camera without modeling RNG or ambient scene; eager results remain camera-bound | `drawing3`/camera commit path, `three-view.test.ts`, `three-camera-commit.test.ts`, model counters in every focused API browser verifier | Verified. Stable pure custom callbacks are an explicit caller contract; the library does not claim to snapshot arbitrary closures. |
| D6 | Named complete pens, portable libraries, imperial/one-off paper, machine settings, one time model; fill/opacity independent | Existing paper/pen/export pipeline retained; `verify-paper-composition.mjs` and `demo-migration/paper/` check three pens, Letter paper, conflicting-library reopen and machine settings; `paper-api/` checks physical clip/mask controls | Verified current composition integration. No new plot-duration estimator or implicit opaque view rectangle. |
| Q1 | Prepared nearest/ray/segment facade with world distance distinct from t; batches preserve source identity including misses | `api/query.ts`, `three-query-api.test.ts`, `query-api/served/`, sampled-row query proofs | Verified independent plane distances/parameters, misses, empty selections, zero-length contact queries, capture-before-await and result count validation. |
| Q2 | Reusable forces evaluated on current pass; explicit plane sidedness; nearest projection is not containment | `api/force.ts`, query force tests and relief migration | Verified below/above constraint, attraction, composition and nearest-surface semantics. Relief's special ceiling logic is not hidden inside a generic collision API. |
| Q3 | Arbitrary JS CPU fields/frozen steps; explicit GPU modeling readback boundaries; captured fixed samples rather than fake GPU callback reevaluation | Toolkit modeling adapters and `three-toolkit.test.ts`, `three-deform.test.ts`; relief verifies eight fixed-sample GPU iterations and prepared query; contract/live docs | Verified. Normal `view` schedules classification internally. Authors do not acquire buffers/devices; no hidden synchronous readback or field-compiler claim. |
| Q4 | Shared prototype until realization; honest mesh-only/mixed capabilities | Instances source/capture/realize implementation and instance tests; curves/instances in mixed view | Verified shared surface references, mirrored realization equivalence, source provenance and wrong-domain diagnostics. |
| Q5 | Measure capture/serialization, transfers, refinement and readback separately from shader time; no unsupported speedup claim | `three/timing.ts`, native visibility/query/deform instrumentation and host adapters; `three-timing.test.ts`; `phase-accounting/served/report.json`, `MEASUREMENTS.md` | Verified exclusive host phase totals, cold/warm cache, queue and zero-work cases, independent plane results and camera retention. Upload submission is not a physical PCIe timestamp; readback wait includes work/transfer/scheduling. Shader timestamps remain separate and non-additive. |

## Named deliverables and gates

| ID | Requirement | Authoritative evidence | Status |
| --- | --- | --- | --- |
| A0 | Independently reviewable correctness and main Studio projection changes before facade work | Commits `5f8317` and `7c1ce1f`, their focused fixtures/reports | Verified history and separate change scope. |
| A1 | Settled contract/imports/domains/ownership/view/projected carrier and three acceptance sources | `API-CONTRACT.md`; `api-examples/terrain.ts`, `instanced-forms.ts`, `paper-composition.ts`; public exports and live imports | Verified, including corrected stale contract introduction. |
| A2 | First useful slice beyond renaming: plane, generic subdivision on plane/box/custom mesh, fields/steps/default view | `mesh-api/` and focused mesh/subdivide/view tests | Verified. |
| A3 | Expanded primitives and readable drawing; remove normal capture/flag/assembly boilerplate from all three M5 demos | `demos/visibility-laboratory.ts`, `procedural-relief.ts`, `paper-composition.ts`; migration/decoration source comparisons and publication reports | Verified current installed sources via read-only GET in `api-audit/store.json`, matching all three tracked demo sources. Migration evidence also verifies behavior. Paper retains all 296 saved-camera paths; relief retains its exact mesh and all 847 segments. Visibility source identities change deliberately with the new owned curve source and are documented. Advanced independent-face extrusion and fixed-sample deformation remain explicit. |
| A4 | Queries/forces/repetition/realization plus measured GPU ergonomics | Q1–Q5 and their named tests/served reports | Verified. |
| A5 | Terrain acceptance | `primitives-api/served/report.json` verifies the live terrain source with sphere/subdivided terrain and GPU dispatch; later 19-example served run includes it | Verified executable acceptance drawing and common geometry contract. |
| A6 | Instanced forms acceptance | `instances-api/served/report.json` checks shared prototypes, Monaco, hardware dispatch, no model rerun, commit/download/reopen | Verified. |
| A7 | Paper composition acceptance with selective hatch/hidden ink, physical clip/mask, explicit paper and pens | `paper-api/report.json` plus all three exports, negative clip/mask controls, source model counters and downloaded portable source | Verified for its defined cameras; the additional user-reported camera is covered separately by E3. |
| A8 | Actual Studio imports/Monaco/headless compilation/live docs; unchanged committed output after failure | API runner/headless/module wiring, Monaco negative probes, current 19-example report; C4 failures | Verified. |
| A9 | Existing nine Docker gates, explicit deliberate ink updates, church routing before/after output-affecting edits, stable WASM | `paper-world-depth/gates.json`: all nine gates passed, one deliberate forest ink update (`three#16`) supported by an independent exact ray oracle, 238 other stable examples unchanged, church 15,601 chains / 96,037 mm draw / 16,515 mm travel / 381.0 minutes unchanged, WASM MD5 `8bf0034cb79606aa8d6c7293496a1b7e`. | Verified on the final visibility correction. Served hardware and deployment evidence are in the same folder. |
| A10 | Source substitution preserves selection/attribute/deformation/query/drawing workflow | Mesh/primitives/queries test loops substitute plane, box, sphere and custom topology; all results flow through the same Mesh/Collection/view implementation | Verified ordinary workflow; primitive-specific intrinsic construction remains separate. |

## Explicit future work, not missing work in this pass

The proposal says this is **not** the entire future modeling catalog. Its
“later modeling work” is connected-region extrusion, inset, bevel and smooth
subdivision. Corner-domain UVs/normals and selective refinement are future
contracts. Existing independent-face extrusion must continue rejecting
adjacent faces explicitly until generalized. Curvature-following hatch and
mesh–mesh intersection curves remain stated limits. A GPU field compiler,
visual node editor, React/JSX and Three dependency are not prerequisites.
Automatic worker restart and GPU device-loss recovery were explicitly deferred
by the user. None of these is relabeled as implemented.

## Completion record

All requirements above have their stated implementation and verification.
`paper-world-depth/` closes E3 with the exact camera provided by the user,
independent geometry oracles, final build gates and served Playwright checks.
The earlier `api-audit/` and `paper-box-oracle/` reports remain historical;
their failed diagnostics are not retroactively marked passed.

User-noted follow-ups: broader camera-control ergonomics; curvature-following
hatch; intersection curves; and an axis-alignment rotation helper with explicit
twist/reference direction. The partial base-grid observation is reflected in
D1: `view.creaseAngle` is user controlled (default 30 degrees). The proposed
rotation helper has only been discussed, not implemented. None expands this
completed proposal into the explicitly deferred work listed above.

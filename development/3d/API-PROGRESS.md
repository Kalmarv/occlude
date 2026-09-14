# Procedural 3D API implementation progress

Target: `3dapi.md`, starting from 821ea62. The M0–M5 completion record describes
the earlier API. This redesign is now complete within the proposal scope;
`API-REQUIREMENTS-AUDIT.md` maps every requirement to its evidence.

- Export defect: exact paper-composition store fixture reproduced; affine
  endpoint-incidence fix and negative controls implemented. See
  `api-export-defect/README.md` and its Playwright export evidence.
- Main Studio projection control: implemented with labels, independent per-scene exploration and
  precision-preserving projection conversion. Main Studio Playwright covers
  both-mode reset/copy/orbit/zoom/picking, perspective commit/download/reopen,
  no model rerun, and stale/cancelled request rejection. The served build passes all Docker gates and both focused
  Playwright verifiers; see `projection-controls/`.
- Contract and three target acceptance sketches: `API-CONTRACT.md` and
  `api-examples/`. Terrain and instanced forms are live; the paper composition
  target has dedicated served Studio acceptance evidence in `paper-api/`.
- First working API slice: implemented and deployed. `occlude/3d` exposes the
  common immutable mesh, four-point plane, box/raw import, generic subdivision,
  typed domain attributes/collections, displacement and frozen steps/history.
  Selections enforce revision ownership; imported topology is validated.
- Retained default `view` and visible/hidden projected collections: implemented.
  Existing `strokes` preserves the full source reference and dash phase through
  selection and interpretation. Hatch selection captures owned face rows;
  multiple views and camera-only commits reuse model geometry.
- Public imports are wired through Studio, headless compilation, live docs and
  Monaco. Two live examples are added; all 228 existing docs ink entries are
  unchanged. Full Docker gates and served NVIDIA Playwright checks pass; see
  `mesh-api/README.md`, `gates.json`, `report.json` and `scenes/`.
- Sphere/cylinder/cone/torus now share the ordinary mesh contract. Four focused
  tests cover watertight seams/poles/caps, winding, valid minimal resolutions,
  dimensions, budgets and the downstream attribute/subdivision/steps workflow.
  All Docker gates and served NVIDIA Playwright checks pass for twelve live
  examples, including the catalog and full terrain acceptance sketch. See
  `primitives-api/README.md` and its gate/render evidence.
- Shared mesh instances, typed per-instance fields/collections/transforms,
  instance-on-points and explicit budgeted realization are implemented.
  Captured views share a single prototype and projected curves retain placement
  and source-point identity. Unit tests cover ownership, provenance, mirrored
  transforms, analytic hidden geometry and realization equivalence. Source
  NVIDIA Playwright verifies the instanced forms acceptance sketch and camera
  commit/download/reopen without model RNG. All nine Docker gates and thirteen
  served live examples pass; the served cone export has zero stray dot paths.
- The cone export exposed false visible gaps between shared triangle boundaries.
  Canonical edge ordering fixes the interval roots without an epsilon; the
  independent convex-cone regression fails before and passes after. See
  `shared-boundary/README.md` and `instances-api/` evidence.
- Prepared queries and reusable forces are implemented. Scalar and batch
  nearest/ray/segment results separate world distance from t; batches retain
  source rows including misses. CPU indexes follow owned revisions; the GPU
  host reuses bounded target buffers. Frozen-pass force fields provide explicit
  plane sidedness, attraction, nearest-surface projection and composition.
  Unit and served Studio checks pass, including independent analytic ray/nearest
  oracles, target reuse, typed hit/source attributes and camera-only commit.
  All nine Docker gates and fourteen live examples pass; see `query-api/`.
- The docs ink checker now rejects compilation errors in new examples as well
  as changes to existing baselines. A deliberately broken appended example
  verifies the failure path.
- Polylines, sampled paths and circle profiles now share the extracted-edge
  curve contract: typed attributes, transforms, frozen passes/history and mixed
  mesh/curve views. Six focused tests, all nine Docker gates, fifteen live
  examples and source/served Studio checks pass. Analytic GPU wire visibility
  is verified in both projections. See `curves-api/`.
- The fresh paper-composition underside report is captured in `paper-depth/`.
  Overlapping bottom faces are established; temporal flicker and the exact
  reported fragment remain unverified. It is not marked resolved.
- Revolve and sweep now return the common mesh from curve profiles. Shared
  seams/axis points, explicit caps, transported frames, sampled scale fields,
  attributes/provenance and topology/cap budgets are implemented. Twelve tests
  and source/served Studio checks pass, including four independent GPU
  visibility oracles. All nine Docker gates and sixteen live examples pass;
  see `profile-construction/`.
- Seeded mesh sampling and fixed-spacing surface scatter are implemented as
  toolkit overloads. Captured sample metadata survives point edits, instancing
  and synchronous/asynchronous query batches with its complete row type.
  Seven sampling tests and sixteen existing query/instance tests pass; source
  Studio verifies terrain placement, spacing, alignment and camera retention.
  All nine Docker gates and seventeen served live examples pass. Three GPU
  query batches preserve rich sample rows and match analytic plane hits; their
  target cache and Monaco checks pass. See `sampling-api/`.
- Visibility laboratory and paper composition now use the ordinary mesh/curve,
  view and projected-stroke API. Main Studio verifies typed source inspection,
  three styles, camera commit, preserved bundled libraries and exact download
  reopen. The paper migration preserves all 296 exported paths at the user's
  saved camera. See `demo-migration/` for verification and store publication.
- The separate paper acceptance target passes selective hatch/support and
  hidden-crease inspection, physical mask/clip checks with negative controls,
  orthographic/perspective commit without modeling reruns, and exact portable
  reopen. See `paper-api/`. The later exact underside camera is covered by the final correction below.
- Captured hatch arrays with typed per-face spacing/angle/offset fields and
  model-space section planes are implemented in `view`. Default ink routes each
  recipe to its named pen; shared revision ownership is automatic. Five focused
  tests plus existing view/instance checks pass, including independent square
  section geometry, exact shared-kernel intervals, frozen field capture and
  camera retention. A new live example covers both decorations.
- Procedural relief now uses those recipes and prepared, source-aware query
  batches. Independent-face extrusion and fixed-sample GPU deformation remain
  explicit advanced modeling operations with their existing semantics. The
  migrated model and all 847 exported segments match the previous sketch.
  Main Studio checks seed variation/repeatability, eight GPU deformation passes,
  one GPU query, typed hatch fields and camera commit without a model rerun.
  All nine Docker gates and eighteen served live examples pass. The migrated
  relief is installed in the dev sketch store; see `decoration-api/`.
- Detailed phase accounting is implemented for native CPU/GPU visibility,
  deformation and surface-query batches. Capture/serialization, queue/setup,
  packing, upload/command submission, readback wait/copy, CPU refinement,
  finalization and remaining overhead are exclusive; shader timestamps stay
  separate. The workload measures earlier view capture and CPU snapshot time
  explicitly and states the observable transfer/timing limits. Unit and served
  hardware checks cover nested totals, queue/cache behavior, zero-work paths,
  independent plane hits, CPU/GPU interval agreement and unchanged repeated ink.
  All nine Docker gates and nineteen served live examples pass; see
  `phase-accounting/` for measurements and scope.
- The earlier saved-box oracle correctly checked its own four cameras but did
  not reproduce the user's later exact camera. The submitted camera exposed
  wrong depth ordering after camera-space rounding: missing bottom hatch bands
  and seven incorrect edge intervals. Source capture and exact refinement now
  retain consistent world geometry. Seven unit regressions cover clipping,
  mirrored placement and one-ULP front/equal/behind planes. Independent rational
  ray/box checks match all 96 edges and 1,685 hatch segments on CPU and served
  NVIDIA GPU, with no incorrectly hidden bottom rows. Nine analytic main Studio
  GPU probes also pass. All remaining collapsed SVG paths trace to positive
  microscopic source gaps; no geometric epsilon or coordinate changes were used.
- The changed forest documentation drawing has a separate exact ray/triangle
  oracle: 165 samples, 57 old mismatches, zero new mismatches. Only its `three#16`
  baseline changed deliberately; the other 238 stable examples are unchanged.
  All nine Docker gates pass and church routing is unchanged. See
  `paper-world-depth/` for the final correction, served proof and deployment.
- The full requirement audit is complete in `API-REQUIREMENTS-AUDIT.md`. It
  separates implemented requirements, authoritative verification and explicit
  future work. User-noted camera ergonomics, curvature-following hatch,
  intersection curves and the proposed axis-alignment helper remain recorded.
  Artistic crease selection is already user controlled with `view.creaseAngle`.

Worker restart/device-loss recovery remains deferred by the user. Use
Playwright, not ProofShot. Continue in this isolated checkout; production
containers and the original checkout stay untouched.

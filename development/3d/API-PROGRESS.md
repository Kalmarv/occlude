# Procedural 3D API implementation progress

Target: `3dapi.md`, starting from 821ea62. The M0–M5 completion record describes
the earlier API and does not imply this redesign is finished.

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
  target still needs its dedicated acceptance verification.
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
- M5 demo migration and detailed GPU phase
  accounting remain pending. Terrain and instanced forms are runnable live
  examples; the complete acceptance set is not yet verified.

Worker restart/device-loss recovery remains deferred by the user. Use
Playwright, not ProofShot. Continue in this isolated checkout; production
containers and the original checkout stay untouched.

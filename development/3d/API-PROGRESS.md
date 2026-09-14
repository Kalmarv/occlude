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
  `api-examples/`. These imports are explicitly not yet implemented.
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
- Primitive expansion (sphere/cylinder/cone/torus), curves/profiles/sweep/revolve,
  M5 demo migration, prepared queries, reusable forces, shared instances and
  detailed GPU phase accounting remain pending. The three acceptance targets
  still require those dependencies and are not yet complete.

Worker restart/device-loss recovery remains deferred by the user. Use
Playwright, not ProofShot. Continue in this isolated checkout; production
containers and the original checkout stay untouched.

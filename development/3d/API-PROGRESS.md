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
- Generic subdivision kernel: implemented internally, four focused tests pass
  for shared plane/box/mixed-concave/folded topology, attributes and budgets.
  Still needs integration into the common immutable mesh facade.
- Mesh facade, public primitive expansion, projected-curve interpretation,
  query/force/instance ergonomics and detailed performance accounting: pending.

Worker restart/device-loss recovery remains deferred by the user. Use
Playwright, not ProofShot. Continue in this isolated checkout; production
containers and the original checkout stay untouched.

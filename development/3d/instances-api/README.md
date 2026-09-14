# Shared mesh instances and explicit realization

`instanceOnPoints` places a shared mesh prototype on an owned point collection.
Point attributes become typed instance attributes; source rows remain attached.
Selections, attribute edits, replacement S/R/T components and world displacement
return new values without duplicating prototype topology. Views retain one
prototype surface reference across all placements. Projected feature rows carry
placement and source-point identity independently of automatic view object IDs.

`.realize()` explicitly duplicates disconnected topology, preserves internal
shared edges and fixed triangulation, handles mirrored winding, transfers
attributes and derives stable IDs with parent provenance. Existing prototype
attributes win collisions. Allocation budgets are checked before duplication.
Instances expose an instance domain, not editable mesh faces.

Seven focused tests cover sharing, immutable inputs, selection ownership,
source identity, transform bounds, deterministic realization, subset IDs,
attribute transfer, budgets and diagnostics. Both projections compare actual
visible/hidden segment geometry before and after realization, with mirroring,
hatch and camera clipping, at 1e-10 world precision. A separate analytic front
box completely hides a rear instance. Camera commit consumes no model RNG and
hatch eligibility is selected only once on prototype faces.

The main Studio Playwright verifier opens the exact instanced-forms acceptance
sketch. Its model logs prove that all 36 scene objects share one prototype.
It checks real NVIDIA execution, zero editor diagnostics, a deliberate TS2322
numeric-attribute error, exploration/commit without a model rerun, and identical
camera/output after portable download and reopen. It also asserts zero stray
zero-length SVG paths. Source evidence is in `source/`; final served evidence
is in `served/`. New source modules required refreshing Vite's cached editor
module during source testing; the actual instance types were correct, and the
rebuilt served editor is tested independently.

The cone array exposed a shared triangle boundary interval defect, fixed and
regressed separately in ../shared-boundary/. The 36 existing hardware precision
cases and four physical-budget controls pass (`precision/report.json`). No
shader timing is presented as an end-to-end speedup.

The full Docker gates are recorded in `gates.json`. Only new live example
three#12 adds an ink baseline; all 232 prior entries stay unchanged. The pinned
Freestyle comparison retains its known coverage differences, with explicit
sample-count updates for the corrected perspective-cube gap. Church routing
stays at 15,601 chains, 96,037 mm draw, 16,515 mm travel and 381.0 minutes.

Reproduce main Studio checks against the served isolated origin:

```sh
DISPLAY=:93 OCCLUDE_API_EXAMPLE=instances \
OCCLUDE_API_EVIDENCE=../../development/3d/instances-api/served \
pnpm --filter occlude-studio exec node tools/verify-mesh-api.mjs
```

The broader redesign remains active: curves/profiles/sweep/revolve, prepared
queries, reusable forces, demo migration and detailed GPU phase accounting
are still open. Mesh instances currently require a mesh prototype; mixed arrays
of meshes and mesh-instance values have honest separate capabilities.

# Captured view decorations and relief migration

`view` accepts one hatch recipe or an array, with typed per-face spacing,
angle and offset fields, selection, named pens and optional keys. Eligibility
and field values are captured once; camera commits rebuild physical paper
rulings without reevaluating model fields. Default ink routes each family's
intervals to its own pen. Existing single-recipe identities are preserved.

`sections` captures model-space plane intersections on the same owned mesh.
Instances transform these prototype-space sections with their geometry. This
is not a fixed world-space cut across separate placements. Surface ownership,
support, keys and attributes use the existing section/hatch/visibility kernels;
there is no parallel renderer or caller-managed derived-surface handoff.
The existing one-million-segment limits apply separately to hatch and sections
per mesh/prototype. Documentation and live example are in `docs/three.md`.

Five focused tests cover typed frozen field capture and immutable reuse,
independent pen routing, camera commit without model/field reruns, exact
old/new feature and interval equality in both projections, an independent
square-perimeter section oracle, transformed instance support, and invalid
keys/values. Existing four view and seven instance tests also pass. The first
Docker attempt caught an overly narrow projection type in a test helper; it
was corrected to accept both projections and the local typecheck passed.

The relief keeps its explicit advanced independent-face extrusion and
fixed-sample GPU deformation. Its ceiling query now uses a prepared batch
with source row identities. Drawing uses ordinary `view` options and typed
hatch fields, with no feature flags, line-set assembly or captured-surface
threading. `creaseAngle: 0` preserves the previous shallow-crease selection.
The independent extrusion restriction has not changed.

At seed 42 the before/after source Studio runs have identical mesh records and
all **847 exported segments**, including named pens (endpoint direction is
normalized, coordinates are compared exactly). Seven sites become towers and
16 vertices are adjusted by the ceiling query. `migration-comparison.json`
records this check. The old and new runs use the same current source renderer;
this is not a comparison between different historical kernel versions.

Source Studio NVIDIA Playwright evidence:
- `before/`: original store sketch, including seeded replay and camera checks.
- `source/`: migrated relief, GPU deformation/query counts, face-specific hatch
  spacing, source geometry retention, seed replay/variation, clean Monaco,
  perspective commit without a model rerun and actual camera download.
- `source-default/`: new live example, retained perspective commit and exact
  portable reopen, plus two negative Monaco probes for typed face fields.

The source and served screenshots were visually inspected. The served relief
also passes all checks in `served/`, and its SVG and mesh exactly match the
source verification. `served-default/` verifies the new API example against the
rebuilt application. `scenes/` records all eighteen live examples passing on
hardware WebGPU; routine empty-library / plot-progress 404s are recorded there.
The relief is published in the isolated dev sketch store; `publication.json`
records a fresh unchanged-source preflight and exact GET after saving. All nine
Docker `pnpm check` gates pass (`gates.json`, local `build.log`), with WASM md5
`8bf0034cb79606aa8d6c7293496a1b7e`. Production container IDs remain unchanged.
Public Cloudflare authentication was not retested. The new live example is
`three#17`; all 237 prior docs ink entries are unchanged. No existing golden
output is replaced. The church oracle is unchanged before/after: 15,601 chains,
96,037 draw mm, 16,515 travel mm, 381.0 min, bridge 0, Euler 15,593, coincident
18.1 mm. The fresh paper underside report is still open.

Reproduce from the isolated worktree root:

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-relief.mjs
DISPLAY=:93 OCCLUDE_API_EXAMPLE=decorations pnpm --filter occlude-studio exec node tools/verify-mesh-api.mjs
```

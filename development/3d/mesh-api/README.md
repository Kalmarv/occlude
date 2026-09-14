# First working procedural mesh API

The served dev build at http://127.0.0.1:5273 passes the full Docker `pnpm check`
gates recorded in `gates.json`. The image is deployed only to occlude-3d-dev-1.
The original mesh tests remain intact; new tests are in three-mesh-api,
three-subdivide and three-view.test.ts.

The new tests cover shared subdivision topology on plane, box, concave/mixed
and folded faces, resource budgets, raw import ownership/triangulation,
attribute transfer, frozen edits/history, stale selections, retained multiple
views, selective hatch and source dash phase after interval filtering.
The two new docs ink entries are three#8/#9; all 228 prior entries are unchanged.
Church routing remains 15,601 chains, 96,037 mm draw, 16,515 mm travel, 381.0 min.

`report.json` and `default-view.png/svg` are Playwright captures from the served
build on the NVIDIA Turing adapter, not software fallback. The editor reports
zero semantic diagnostics for the live example. A deliberate number-to-string
assignment produces TS2322, proving the field type reaches Monaco. Perspective
commit does not rerun modeling; downloading and reopening the portable sketch
preserves the camera and output hash. `portable.ts` is the captured download.

`scenes/report.json` covers all ten live 3D examples. The associated camera and
construction reports cover the actual Studio controls, including exploration,
commit and portable configuration. Empty-library/no-plot 404 responses are
expected server empty states; no page errors occurred. The public tunnel's
Access login is not bypassed: these tests use the same served origin directly.

Reproduce with DISPLAY=:93 and the installed NVIDIA Vulkan driver:

```sh
pnpm --filter occlude-studio exec node tools/verify-mesh-api.mjs
OCCLUDE_GPU_EVIDENCE=../../development/3d/mesh-api/scenes \
OCCLUDE_CONSTRUCTION_CHECK=1 OCCLUDE_CAMERA_CHECK=1 \
OCCLUDE_CAMERA_CONFIG_CHECK=1 OCCLUDE_PROJECTION_CHECK=1 \
pnpm --filter occlude-studio exec node tools/verify-scenes.mjs
```

This is the first working slice, not completion of 3dapi.md. Primitive expansion,
curves, queries/forces, instances, demo migration and detailed GPU timing remain.

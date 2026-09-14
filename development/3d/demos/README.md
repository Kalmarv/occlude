# Demonstration sketches

The visibility and paper demos have been migrated to `occlude/3d`; the relief
migration remains pending. Current migration evidence is in
[`demo-migration/`](../demo-migration/README.md). The earlier M5 evidence below
records the original implementation, not completion of the API redesign.

All three are installed in the isolated dev sketch store: `visibility-laboratory`, `procedural-relief`, and `paper-composition` (portable bundled definitions). Refresh Studio’s Sketches page to open them.

Import these `.ts` files into the isolated Studio at `http://localhost:5273` (or its configured tunnel). These are complete sketches using the public library API. Direct Playwright verification uses the actual main Studio and hardware WebGPU; `three.html` is not the UI evidence for these demos.

| Demo | What to try | Verified artifacts |
| --- | --- | --- |
| [Visibility laboratory](visibility-laboratory.ts) | Compare the clean/hidden, dashed/wobbled and contour/wire columns. All three use the same classified scene. Open the browser console for the `visibility-laboratory` report: visible/hidden interval counts and three intervals with source IDs, parameter ranges and support. Edit the readable kind predicate to choose another filter. Choose **3D**, orbit, then **Commit view** to reproject all columns. | [SVG](../demo-migration/visibility/visibility.svg), [screenshot](../demo-migration/visibility/visibility.png), [report](../demo-migration/visibility/report.json) |
| [Procedural relief](procedural-relief.ts) | Change the seed to select different nonadjacent sites. Heights vary, point attributes drive eight GPU deformation iterations, a nearest-surface batch trims high vertices against a ceiling, and face attributes control hatch spacing. Section contours share the realized surface. | [SVG](../playwright-relief/relief.svg), [screenshot](../playwright-relief/relief.png), [report](../playwright-relief/report.json) |
| [Paper composition](paper-composition.ts) | Uses the starter Letter paper and `pigma-01-black` pen imports, two color instances and a one-off pen. Commit a camera, download, and reopen the bundled sketch. | [Portable download](../demo-migration/paper/paper-composition.ts), [SVG](../demo-migration/paper/composition.svg), [report](../demo-migration/paper/report.json) |

The visibility demo contains a cube, an open plane, two crossing boxes and an authored wire. Cross-object intersection curves are deferred; it intentionally demonstrates the supported mesh features and visibility cuts. Its console inspection is part of the sketch, not a new Studio inspector UI. Feature/style construction inside the retained drawing callback uses one classified result; changing the sketch source reruns the sketch, while its three displayed interpretations share the result within each run.

The relief verifier checks a proper subset of selected sites, differing extrusion heights, nonconstant deformation attributes, actual query-adjusted positions, generated section and hatch curves, exact hatch-spacing transfer from each supporting face, and all three exported colors. Seed 42 selects seven sites and changes 16 vertices through the ceiling query. Repeating that seed yields identical realized geometry, plan and SVG; seed 43 changes the selected sites. A hardware report requires eight GPU deformation dispatches and one GPU query dispatch.

The visibility verifier checks one classified scene, positive visible/hidden/contour interval selections, a strictly smaller contour selection, populated source/support inspection, all required mesh and curve objects, clean Monaco diagnostics, and successful camera commitment with unchanged source geometry. Both screenshots were visually inspected. The first visibility screenshot exposed labels placed in the wrong units; the final sketch converts the column positions into numeric drawable units (the label API takes numbers).

Reproduce from the worktree root:

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-visibility-demo.mjs
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-relief.mjs
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-paper-composition.mjs
```

The verifiers start isolated browser contexts, never connect to a plotter, and do not publish sketches or results to the server. Saved-result persistence is separately covered by the main Studio regression evidence. These demos completed the original M5 demonstration requirements. Current redesign work is tracked in [API-PROGRESS.md](../API-PROGRESS.md).

Historical M5 validation: isolated container `pnpm check` passed Rust/TS tests, library and Studio types, live docs, unchanged docs ink, build, WASM (`615f9d1b7a63396d451fd33aac18b559`) and smoke. Final demo sources were executed by the direct Playwright verifiers against the existing served application. Application code is unchanged. Production container IDs and start times remained unchanged.

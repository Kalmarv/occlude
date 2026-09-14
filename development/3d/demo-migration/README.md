# Ordinary API demo migration

`visibility-laboratory` and `paper-composition` are installed in the isolated
served dev sketch store using `occlude/3d`. `publication.json` records fresh
source comparisons immediately before saving and exact GET verification after
saving. The original store sources are retained as `visibility/before.ts` and
`paper/before.ts`. The paper's user-saved camera and bundled pen/paper settings
are preserved. Procedural relief migration is still pending.

The visibility demo uses ordinary meshes and a polyline, one retained `view`,
readable interval kinds and the existing `strokes` verb. Its three columns
share classification. Console inspection now reports classified intervals with
source IDs, support and ranges; the old demo reported assembled stroke runs,
so the counts are intentionally different measures. The polyline is captured
as owned curve geometry instead of the old separate wire object. Projected
stroke and curve source identities differ from the old spelling, so this
migration does not claim byte-identical dash/wobble paths. Geometry and all
three intended interpretations are preserved and visually checked.

The paper demo uses default `view` ink and a face attribute to select the block
for hatch. No capture identity, visibility flags or stroke assembly is needed.
All **296 exported paths** (including labels) match the previous captured paper
SVG exactly at the saved camera: comparison uses the multiset of named pen and
SVG path text, without rounding or tolerance. See `paper/ink-comparison.json`.
This is migration-equivalence evidence; it does not resolve the user's fresh
underside artifact report recorded in `../paper-depth/`.

Main Studio Playwright on the served origin, using NVIDIA Vulkan and a
non-fallback WebGPU adapter, verifies both demos. Visibility checks populated
visible/hidden/contour selections and source inspection, one scene, retained
mesh/curve geometry across camera commit and clean editor diagnostics. Paper
checks imperial dimensions, all three named pens and machine-relevant settings,
commit, download and exact SVG/hash/camera reopen against conflicting library
values. The screenshots were visually inspected.

The separate new-API paper acceptance target is verified in `../paper-api/`.
No application/library implementation changed in this slice; the served runtime
already supports these sketch sources. No application restart was needed.

Validation: all nine Docker `pnpm check` gates passed (`build.log`): Rust, TS,
library types, Studio types, live docs, unchanged docs ink, build, WASM and smoke.
WASM md5 is `8bf0034cb79606aa8d6c7293496a1b7e`. The church seed-42 oracle is
unchanged before/after: 15,601 chains, 96,037 draw mm, 16,515 travel mm, 381.0 min,
bridge 0, Euler 15,593, coincident 18.1 mm. Production container IDs remain
unchanged. Public Cloudflare authentication was not retested.

Reproduce from the isolated worktree root:

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-visibility-demo.mjs
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-paper-composition.mjs
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-paper-api.mjs
```

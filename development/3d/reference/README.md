# Pinned Blender Line Art reference

Reference: **Blender 5.2.1 LTS**, build/source commit `9e2066aef7ef7e20c142ad7bd3303138a4304c93`. The prebuilt Linux x64 archive SHA-256 is `a31f524fa99a527d3d52b7f5aaa68c34e1a19d5a1c9473f79c5cc610fd5b10e9`, checked against Blender's release checksum. Blender is a development reference only; it is neither compiled nor required by Occlude's application/build.

- [Official release download](https://mirror.blender.org/release/Blender5.2/blender-5.2.1-linux-x64.tar.xz)
- [Official checksums](https://mirror.blender.org/release/Blender5.2/blender-5.2.1.sha256)
- [Pinned source tag](https://projects.blender.org/blender/blender/src/tag/v5.2.1)

The task-local binary and sparse source checkout live under `/tmp/occlude-blender-reference/`. The checkout includes Line Art/modifiers, Freestyle, geometry/kernel, RNA/DNA declarations, Freestyle scripts and Python tests (118 MB including Git metadata). No source engine implementation was transplanted into Occlude. The reference script is independently authored against Blender's public Python API. Source inspection established the Blender 5.2 edge-mark attribute name `freestyle_edge`; it is an edge-domain Boolean attribute.

## Reproduce

From the isolated checkout, after extracting the verified prebuilt release:

```sh
/tmp/occlude-blender-reference/blender-5.2.1-linux-x64/blender --background --factory-startup --python-exit-code 1 --python development/3d/reference/blender-lineart.py -- development/3d/reference/fixtures.json development/3d/reference/blender.json
pnpm --filter occlude exec tsx tools/compare-blender3.ts
```

`fixtures.json` supplies the exact polygon geometry and camera to both engines. `blender-lineart.py` extracts evaluated Grease Pencil Line Art strokes and projects them with Blender's camera utility into a 100×100 mm frame. Factory startup, camera clipping, source collection, feature switches, occlusion levels, crease threshold, image trimming and depth offset are explicit in the script. Edge intersections, material boundaries and loose curves are disabled in these comparisons. Blender's 179-degree crease setting includes the right-angle edges in these fixtures; this does not assert parity for all crease-threshold conventions.

`compare-blender3.ts` generates Occlude CPU classifications from the same input and compares **bidirectional collinear segment coverage** at 0.0001 mm. It checks entire intervals rather than sparse samples or screenshots. This deliberately ignores stroke order/chaining and permits different subdivision of the same geometric line. A missing or extra line portion outside tolerance fails. This comparison is not a claim about multiplicity, identical chain topology, pen routing, or an independently established numerical error bound for arbitrary scenes.

Eight comparisons pass: orthographic cube visible/hidden, perspective cube visible/hidden, open-plane boundary, crossing boxes visible/hidden, and a marked flat edge. `comparison.json` records counts and uncovered lengths. The SVG pairs show Blender in rust on the left and Occlude in dark ink on the right. Blender and Occlude sometimes split the same coverage into different segment counts, particularly at overlapping occluders. The CPU oracle also has separately authored analytical and ray-intersection tests; agreement with Blender is additional evidence, not the sole correctness oracle.

The exact same eight fixtures also pass on nonfallback NVIDIA Turing using the production-bundled reference worker (Chrome 145.0.7632.109). `gpu.json` records projected vectors, adapter and per-case dispatch/refinement/transfer counts; `comparison-gpu.json` reports zero uncovered length in either direction. The browser driver opens the laboratory only to start its bundled benchmark worker; this is a headless fixture computation, separate from main Studio interaction verification.

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/reference-three.mjs
pnpm --filter occlude exec tsx tools/compare-blender3.ts ../../development/3d/reference ../../development/3d/reference/gpu.json
```

`three-reference.test.ts` runs the CPU comparison against captured Blender vectors during ordinary tests and deliberately displaces one reference segment to verify that the comparator rejects mismatches. It uses temporary files and requires no Blender executable. Blender regenerations are explicit development commands.

Full isolated `pnpm check` passes: Rust 10.0s, TS 21.1s, library types 6.0s, Studio types 5.0s, docs 12.8s, ink 14.5s, build 37.8s and smoke 2.3s. WASM remains `615f9d1b7a63396d451fd33aac18b559`; all existing docs ink remains unchanged. These are local/container gates, not a remote CI claim.

Freestyle selection and constant physical width/color references are now captured in [FREESTYLE.md](FREESTYLE.md), including two explicit intersecting-box discrepancies corroborated against Line Art and independent ray checks. The broader precision/performance/final audit remains outstanding. No complete parity or M5 completion claim.

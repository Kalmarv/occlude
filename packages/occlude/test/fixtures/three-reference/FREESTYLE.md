# Pinned Freestyle selection and constant-style reference

Blender 5.2.1 LTS, build `9e2066aef7ef7e20c142ad7bd3303138a4304c93`, using the same verified prebuilt binary and exact geometry/cameras as the Line Art reference. The independently authored `blender-freestyle.py` and `freestyle-capture.py` use the public Python API; no Blender engine implementation is incorporated into Occlude.

The reference selects boundary/silhouette/crease/marked features and quantitative invisibility, creates unchained Freestyle strokes, and captures their vector vertices after constant width/color shaders. The 512-pixel square render maps to a 100 mm square paper frame. A 1.536-pixel total stroke width therefore corresponds to 0.3 mm. The shader's numeric RGB components are 0.2/0.4/0.6; these match the components encoded by Occlude's `#336699` pen. This checks numeric color and physical width, not perceptual equivalence between Blender color management and an SVG viewer.

API references: [Freestyle predicates](https://docs.blender.org/api/5.2/freestyle.predicates.html) and [Freestyle shaders](https://docs.blender.org/api/5.2/freestyle.shaders.html). Chaining, dash/wobble algorithms, corner rules and topology-dependent stroke ordering are not asserted identical. Occlude's source-phase and planning tests cover its own contracts separately.

## Results and intentional differences

Six of eight coverage comparisons match within 0.0001 mm in both CPU and hardware-GPU runs: orthographic and perspective cube visible/hidden edges, open-plane boundaries, and the marked flat edge. All captured vertices match the constant width and numeric color. A test also exports a real Occlude 3D cube with that pen and checks its SVG width/color.

The intersecting-box visible and hidden selections differ. In visible coverage, Occlude has 6.8599434 mm absent from Freestyle and Freestyle has 11.6596714 mm absent from Occlude. Hidden coverage exchanges approximately those amounts. These are recorded discrepancies, not passing parity checks. The strict comparator intentionally exits 1 for Freestyle, and `freestyle-comparison*.json` retain `passed: false`. The regression test requires exactly these two mismatches and their measured lengths, while still requiring the other six comparisons to match.

Blender Line Art agrees with Occlude in all eight cases. To add an independent check, the comparator now tests three representable interior samples per CPU-oracle interval using a separate Möller–Trumbore ray/triangle calculation over all fixture triangles, without the projected index or visibility half-spaces. Hardware coverage is compared separately against the same captured reference; these ray counts are explicitly labeled CPU. All 177 checked samples agree with Occlude, including 87 on the intersecting boxes. This evidence supports retaining Occlude's geometric result instead of copying the Freestyle discrepancy. It does not establish the internal cause of Freestyle's different classification.

Three requested samples in a perspective-cube interval cannot be represented strictly between its adjacent f64 endpoints (`0.4` and `0.4000000000000001`). They are reported as `unrepresentableInteriorSamples`; no boundary sample or tolerance-based classification is substituted. This reference sampling is additional fixture evidence, not a general precision proof.

The vector pairs put Freestyle in rust on the left and Occlude in dark ink on the right. [Visible crossing-box comparison](freestyle-crossing-boxes-visible.svg), [hidden comparison](freestyle-crossing-boxes-hidden.svg), [visible screenshot](freestyle-crossing-boxes-visible.png). Full raw strokes, widths and colors are in `freestyle.json`.

## Reproduce

From the worktree root (binary path is task-local):

```sh
/tmp/occlude-blender-reference/blender-5.2.1-linux-x64/blender -b --python-exit-code 1 --python packages/occlude/test/fixtures/three-reference/blender-freestyle.py -- development/3d/reference/fixtures.json development/3d/reference/freestyle.json
pnpm --filter occlude exec tsx tools/compare-blender3.ts test/fixtures/three-reference - freestyle
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/reference-three.mjs
pnpm --filter occlude exec tsx tools/compare-blender3.ts test/fixtures/three-reference test/fixtures/three-reference/gpu.json freestyle
pnpm --filter occlude test test/three-reference.test.ts
```

The two strict Freestyle comparator commands intentionally exit 1 for the documented crossing-box discrepancies; the regression suite exits 0 when the recorded behavior and independent checks hold. The generator asserts nonempty strokes for these nonempty fixtures because Blender can log a Freestyle module error while returning a successful render/process status.

Validation: all three reference regressions pass; a fresh direct Playwright hardware run reports a nonfallback NVIDIA Turing adapter for all eight cases. The complete isolated-container `pnpm check` passes Rust/TS tests, library/Studio types, live docs, unchanged docs ink, build, unchanged WASM hash and smoke. Production containers retain their previous IDs and start times. This slice changes reference tools/tests/data only, with no application renderer change.
